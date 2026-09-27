import type { FastifyInstance } from 'fastify';
import {
  loadStaffMemberships,
  requestOtp,
  revokeToken,
  verifyOtp,
} from '../../auth/service.js';
import { requirePrincipal } from '../context.js';

const phoneSchema = {
  type: 'string',
  minLength: 5,
  maxLength: 24,
  pattern: '^[+0-9 ()\\-.]+$',
} as const;

export async function authRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Request a login code.
   *
   * Rate limited hard: this endpoint sends SMS, which costs real money and is
   * the obvious target for someone wanting to run up a bill or spam a number.
   *
   * The response is identical whether or not the number has an account.
   * Anything else makes this an account-enumeration oracle.
   */
  app.post(
    '/auth/otp',
    {
      config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
      schema: {
        body: {
          type: 'object',
          required: ['phone'],
          properties: {
            phone: phoneSchema,
            locationId: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
    async (request) => {
      const body = request.body as { phone: string; locationId?: string };

      const challenge = await requestOtp(body.phone, {
        locationId: body.locationId ?? null,
        // Only ever in dev/test, and never when a real code was dispatched.
        revealCode: process.env.EXPOSE_OTP === 'true',
      });

      return {
        challengeId: challenge.challengeId,
        expiresAt: challenge.expiresAt.toISOString(),
        ...(challenge.code ? { code: challenge.code } : {}),
      };
    },
  );

  /** Verify a code and receive a session token. Creates the account if new. */
  app.post(
    '/auth/verify',
    {
      config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
      schema: {
        body: {
          type: 'object',
          required: ['challengeId', 'code'],
          properties: {
            challengeId: { type: 'string', format: 'uuid' },
            code: { type: 'string', minLength: 4, maxLength: 8 },
            name: { type: 'string', maxLength: 120 },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        challengeId: string;
        code: string;
        name?: string;
      };

      const session = await verifyOtp(body.challengeId, body.code, {
        name: body.name ?? null,
        userAgent: request.headers['user-agent'] ?? null,
      });

      return reply.status(201).send({
        token: session.token,
        userId: session.userId,
        expiresAt: session.expiresAt.toISOString(),
        isNewUser: session.isNewUser,
      });
    },
  );

  /** Who am I, and where do I work. */
  app.get('/auth/me', async (request) => {
    const principal = requirePrincipal(request);
    const memberships = await loadStaffMemberships(principal.userId);

    return {
      userId: principal.userId,
      name: principal.name,
      phone: principal.phone,
      staff: memberships,
    };
  });

  app.post('/auth/logout', async (request, reply) => {
    requirePrincipal(request);
    const token = request.headers.authorization?.split(' ')[1];
    if (token) await revokeToken(token);
    return reply.status(204).send();
  });
}
