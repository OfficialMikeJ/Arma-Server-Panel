/**
 * Central error handling.
 *
 * Two rules:
 *   1. A client never sees anything we did not deliberately write for it.
 *   2. Every 5xx is logged with full context and a request id the user can quote.
 */

import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { AppError } from '../lib/errors.js';
import { SsrfBlockedError } from '../security/ssrf.js';
import { loadConfig } from '../config/env.js';

export default fp(async function errorHandler(app: FastifyInstance) {
  const config = loadConfig();

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: {
        code: 'not_found',
        message: 'Not found.',
        requestId: request.id,
      },
    });
  });

  app.setErrorHandler((error, request, reply) => {
    const requestId = request.id;

    if (error instanceof AppError) {
      if (error.headers) {
        for (const [key, value] of Object.entries(error.headers)) reply.header(key, value);
      }
      if (error.statusCode >= 500) {
        request.log.error({ err: error, ...error.logContext, requestId }, error.message);
      } else {
        request.log.info(
          { code: error.code, status: error.statusCode, requestId },
          'Request rejected',
        );
      }
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
          requestId,
        },
      });
    }

    if (error instanceof ZodError) {
      const details = error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      }));

      // Name the offending field in the message itself. "The request payload
      // is not valid" on its own gives an operator nothing to act on, and the
      // details array is easy for a caller to drop.
      const first = details[0];
      const summary = first
        ? first.path
          ? `${first.path}: ${first.message}`
          : first.message
        : 'unknown field';
      const more = details.length > 1 ? ` (and ${details.length - 1} more)` : '';

      request.log.info({ details, requestId }, 'Validation failed');

      return reply.status(422).send({
        error: {
          code: 'validation_failed',
          message: `Invalid request — ${summary}${more}`,
          details,
          requestId,
        },
      });
    }

    if (error instanceof SsrfBlockedError) {
      request.log.warn({ url: error.url, requestId }, 'Blocked outbound request');
      return reply.status(400).send({
        error: {
          code: 'destination_not_allowed',
          message: 'That destination is not permitted.',
          requestId,
        },
      });
    }

    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      // P2002 unique violation is the only one worth reflecting back, and even
      // then without naming the column.
      if (error.code === 'P2002') {
        return reply.status(409).send({
          error: { code: 'conflict', message: 'That value is already in use.', requestId },
        });
      }
      if (error.code === 'P2025') {
        return reply.status(404).send({
          error: { code: 'not_found', message: 'Not found.', requestId },
        });
      }
      request.log.error({ err: error, prismaCode: error.code, requestId }, 'Database error');
      return reply.status(500).send({
        error: { code: 'internal_error', message: 'Something went wrong.', requestId },
      });
    }

    // Fastify's own errors (body too large, malformed JSON, unsupported media type).
    const fastifyStatus = (error as { statusCode?: number }).statusCode;
    if (typeof fastifyStatus === 'number' && fastifyStatus >= 400 && fastifyStatus < 500) {
      const code = (error as { code?: string }).code ?? 'bad_request';
      return reply.status(fastifyStatus).send({
        error: {
          code: String(code).toLowerCase(),
          message:
            fastifyStatus === 413
              ? 'Payload too large.'
              : fastifyStatus === 415
                ? 'Unsupported content type.'
                : 'The request could not be processed.',
          requestId,
        },
      });
    }

    request.log.error({ err: error, requestId }, 'Unhandled error');
    return reply.status(500).send({
      error: {
        code: 'internal_error',
        message: config.isProduction
          ? 'Something went wrong.'
          : String((error as { message?: unknown })?.message ?? error),
        requestId,
      },
    });
  });
});
