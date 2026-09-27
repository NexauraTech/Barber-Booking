/**
 * Domain errors to HTTP.
 *
 * The mapping matters for the booking flow specifically: losing a race for a
 * slot is a 409 with the refreshed alternatives attached, never a 500. The
 * client shows "10:30 was just booked" in place, with the next options
 * already loaded, rather than dumping the user back to the start
 * (docs/research/03-realtime.md §3.4).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { BookingError, type BookingErrorCode } from '../booking/errors.js';
import { AuthError } from '../auth/service.js';

const STATUS_BY_CODE: Record<BookingErrorCode, number> = {
  SLOT_TAKEN: 409,
  HOLD_EXPIRED: 409,
  HOLD_NOT_YOURS: 403,
  INVALID_STATE: 409,
  NOT_BOOKABLE: 400,
  NO_ELIGIBLE_STAFF: 422,
  NOT_FOUND: 404,
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const unauthorized = (message = 'Authentication required') =>
  new ApiError(401, 'UNAUTHORIZED', message);

export const forbidden = (message = 'You do not have access to this') =>
  new ApiError(403, 'FORBIDDEN', message);

export const notFound = (message = 'Not found') =>
  new ApiError(404, 'NOT_FOUND', message);

export const badRequest = (message: string, details?: Record<string, unknown>) =>
  new ApiError(400, 'BAD_REQUEST', message, details);

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof ApiError) {
      return reply
        .status(error.status)
        .send({ error: error.code, message: error.message, details: error.details });
    }

    if (error instanceof BookingError) {
      return reply.status(STATUS_BY_CODE[error.code] ?? 400).send({
        error: error.code,
        message: error.message,
        details: error.details,
      });
    }

    if (error instanceof AuthError) {
      const status = error.code === 'TOO_MANY_ATTEMPTS' ? 429 : 401;
      return reply.status(status).send({ error: error.code, message: error.message });
    }

    // Fastify's own schema validation.
    if ((error as { validation?: unknown }).validation) {
      return reply.status(400).send({
        error: 'VALIDATION_FAILED',
        message: error instanceof Error ? error.message : 'Invalid request',
      });
    }

    if ((error as { statusCode?: number }).statusCode === 429) {
      return reply.status(429).send({
        error: 'RATE_LIMITED',
        message: 'Too many requests; slow down',
      });
    }

    // Anything unrecognised is a bug. Log it in full, tell the caller nothing
    // — internal messages and stack traces are not the client's business.
    request.log.error({ err: error }, 'unhandled error');
    return reply
      .status(500)
      .send({ error: 'INTERNAL', message: 'Something went wrong' });
  });

  app.setNotFoundHandler((_request, reply) => {
    reply.status(404).send({ error: 'NOT_FOUND', message: 'No such route' });
  });
}
