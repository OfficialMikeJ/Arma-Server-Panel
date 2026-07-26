/**
 * Structured logging with mandatory redaction.
 *
 * The redaction list is the last line of defence, not the first - code should
 * not put secrets into log objects at all - but a single careless
 * `logger.info({ body })` should not be able to leak a session token.
 */

import { pino, stdSerializers, stdTimeFunctions, type LoggerOptions } from 'pino';
import { loadConfig } from '../config/env.js';

const config = loadConfig();

const REDACT_PATHS = [
  'password', '*.password', '*.*.password',
  'newPassword', 'currentPassword', 'confirmPassword',
  'token', '*.token', '*.*.token',
  'apiKey', '*.apiKey', 'api_key', '*.api_key',
  'secret', '*.secret', 'secrets', '*.secrets',
  'authorization', 'Authorization',
  'cookie', 'Cookie', 'set-cookie',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-asp-csrf"]',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  'totpSecret', 'totpSecretEnc', 'secretsEnc', 'apiKeyEnc',
  'webhookUrl', 'userKey', 'apiToken',
  'refreshToken', 'accessToken', 'client_secret', 'clientSecret',
  'code', 'enrollmentToken', 'challengeToken', 'discordLinkToken',
  'recoveryCodes', 'plaintext',
  'DATABASE_URL', 'ENCRYPTION_KEY', 'HASH_PEPPER', 'RELAY_TOKEN',
  'STEAM_PASSWORD', 'DISCORD_CLIENT_SECRET',
];

const options: LoggerOptions = {
  level: config.LOG_LEVEL,
  redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  base: { service: 'asp-api' },
  timestamp: stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
  // Errors carry stack traces; never serialise arbitrary properties off them
  // in production, where they may contain query parameters.
  serializers: {
    err: stdSerializers.err,
    req(request: { method?: string; url?: string; id?: string }) {
      return { method: request.method, url: sanitizeUrl(request.url), id: request.id };
    },
  },
};

/** Drops query strings, which routinely carry tokens. */
function sanitizeUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  const index = url.indexOf('?');
  return index === -1 ? url : `${url.slice(0, index)}?[redacted]`;
}

export const logger =
  config.isDevelopment && process.stdout.isTTY
    ? pino({
        ...options,
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname,service' },
        },
      })
    : pino(options);

export type Logger = typeof logger;
