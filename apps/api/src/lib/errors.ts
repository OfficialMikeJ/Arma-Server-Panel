/**
 * Typed application errors.
 *
 * Every error surfaced to a client goes through one of these, so no stack
 * trace, SQL fragment or internal path can escape in a response body.
 */

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: Array<{ path: string; message: string }>;
  /** Extra context for the log line only. Never serialised to the client. */
  readonly logContext?: Record<string, unknown>;
  /** Response headers this error requires, e.g. Retry-After. */
  readonly headers?: Record<string, string>;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    options: {
      details?: Array<{ path: string; message: string }>;
      logContext?: Record<string, unknown>;
      headers?: Record<string, string>;
    } = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = options.details;
    this.logContext = options.logContext;
    this.headers = options.headers;
  }
}

export const badRequest = (message: string, details?: Array<{ path: string; message: string }>) =>
  new AppError(400, 'bad_request', message, { details });

export const unauthorized = (message = 'Authentication required.') =>
  new AppError(401, 'unauthorized', message);

export const forbidden = (message = 'You do not have permission to do that.') =>
  new AppError(403, 'forbidden', message);

export const notFound = (message = 'Not found.') => new AppError(404, 'not_found', message);

export const conflict = (message: string) => new AppError(409, 'conflict', message);

export const gone = (message: string) => new AppError(410, 'gone', message);

export const unprocessable = (message: string, details?: Array<{ path: string; message: string }>) =>
  new AppError(422, 'unprocessable', message, { details });

export const tooManyRequests = (message: string, retryAfterSeconds: number) =>
  new AppError(429, 'rate_limited', message, {
    headers: { 'retry-after': String(Math.max(1, Math.ceil(retryAfterSeconds))) },
  });

export const internal = (message = 'Something went wrong.', logContext?: Record<string, unknown>) =>
  new AppError(500, 'internal_error', message, { logContext });

export const serviceUnavailable = (message: string) =>
  new AppError(503, 'service_unavailable', message);

export const preconditionFailed = (message: string, code = 'precondition_failed') =>
  new AppError(412, code, message);
