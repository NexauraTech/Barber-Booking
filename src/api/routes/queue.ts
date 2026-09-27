import type { FastifyInstance } from 'fastify';
import { getPool } from '../../db/pool.js';
import {
  abandonQueueEntry,
  bumpPriority,
  getLiveQueue,
  getPublicQueueStatus,
  joinQueue,
  notifyUpcoming,
  promoteToAppointment,
} from '../../queue/service.js';
import { ensureClientForUser } from '../../auth/service.js';
import { loadLocationPolicy } from '../../db/availability-repo.js';
import { requireStaff } from '../context.js';
import { notFound } from '../errors.js';

const uuid = { type: 'string', format: 'uuid' } as const;

export async function queueRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Join the walk-in queue. PUBLIC.
   *
   * This is the QR-code-at-the-door path: no app, no account, no download.
   * In walk-in markets most clients will never install anything, and an
   * install requirement here kills adoption outright
   * (docs/research/01-market-landscape.md §1.5).
   */
  app.post(
    '/locations/:locationId/queue',
    {
      config: { rateLimit: { max: 10, timeWindow: '10 minutes' } },
      schema: {
        params: {
          type: 'object',
          required: ['locationId'],
          properties: { locationId: uuid },
        },
        body: {
          type: 'object',
          required: ['serviceIds'],
          properties: {
            serviceIds: { type: 'array', items: uuid, minItems: 1, maxItems: 10 },
            name: { type: 'string', minLength: 1, maxLength: 120 },
            phone: { type: 'string', minLength: 5, maxLength: 24 },
            preferredStaffId: uuid,
          },
        },
      },
    },
    async (request, reply) => {
      const { locationId } = request.params as { locationId: string };
      const body = request.body as {
        serviceIds: string[];
        name?: string;
        phone?: string;
        preferredStaffId?: string;
      };

      // A signed-in client is recognised; everyone else joins as a guest.
      let clientId: string | null = null;
      if (request.principal) {
        const location = await loadLocationPolicy(locationId);
        clientId = await ensureClientForUser(request.principal.userId, location.orgId);
      }

      const entry = await joinQueue({
        locationId,
        serviceIds: body.serviceIds,
        clientId,
        guestName: clientId ? null : (body.name ?? null),
        guestPhone: clientId ? null : (body.phone ?? null),
        preferredStaffId: body.preferredStaffId ?? null,
      });

      return reply.status(201).send({
        queueEntryId: entry.id,
        // The whole public status page hangs off this token — it is the
        // client's only credential, so it is returned once and never listed.
        publicToken: entry.publicToken,
        joinedAt: entry.joinedAt.toISOString(),
      });
    },
  );

  /**
   * Live position for one waiting client. PUBLIC, by token.
   *
   * Returns position and ETA only. Anyone holding a token can read this, so
   * it must never carry another client's name or number
   * (docs/research/03-realtime.md §3.2).
   */
  app.get(
    '/queue/:publicToken',
    {
      schema: {
        params: {
          type: 'object',
          required: ['publicToken'],
          properties: { publicToken: { type: 'string', minLength: 16, maxLength: 64 } },
        },
      },
    },
    async (request) => {
      const { publicToken } = request.params as { publicToken: string };
      const status = await getPublicQueueStatus(publicToken);
      if (!status) throw notFound('Queue entry not found');

      return {
        status: status.status,
        position: status.position,
        waitMinutes:
          status.rangeStartMinutes === null
            ? null
            : { from: status.rangeStartMinutes, to: status.rangeEndMinutes },
      };
    },
  );

  /** Leave the queue. By token, so a guest can do it from their phone. */
  app.delete(
    '/queue/:publicToken',
    {
      schema: {
        params: {
          type: 'object',
          required: ['publicToken'],
          properties: { publicToken: { type: 'string', minLength: 16, maxLength: 64 } },
        },
      },
    },
    async (request, reply) => {
      const { publicToken } = request.params as { publicToken: string };
      const { rows } = await getPool().query(
        `SELECT id FROM queue_entries WHERE public_token = $1`,
        [publicToken],
      );
      if (!rows[0]) throw notFound('Queue entry not found');

      await abandonQueueEntry(rows[0].id);
      return reply.status(204).send();
    },
  );

  /**
   * The shop-side queue. Staff only — this one carries names and numbers.
   */
  app.get(
    '/locations/:locationId/queue',
    {
      schema: {
        params: {
          type: 'object',
          required: ['locationId'],
          properties: { locationId: uuid },
        },
      },
    },
    async (request) => {
      const { locationId } = request.params as { locationId: string };
      await requireStaff(request, locationId);

      const live = await getLiveQueue(locationId);

      return {
        quotedWaitMinutes: live.quotedWaitMinutes,
        entries: live.entries.map((entry) => ({
          queueEntryId: entry.id,
          name: entry.guestName,
          phone: entry.guestPhone,
          clientId: entry.clientId,
          serviceIds: entry.serviceIds,
          preferredStaffId: entry.preferredStaffId,
          status: entry.status,
          position: entry.estimate.position,
          assignedStaffId: entry.estimate.staffId,
          waitMinutes:
            entry.estimate.rangeStartMinutes === null
              ? null
              : {
                  from: entry.estimate.rangeStartMinutes,
                  to: entry.estimate.rangeEndMinutes,
                },
        })),
      };
    },
  );

  /** Nudge whoever is nearly up. Staff only. */
  app.post(
    '/locations/:locationId/queue/notify',
    {
      schema: {
        params: {
          type: 'object',
          required: ['locationId'],
          properties: { locationId: uuid },
        },
      },
    },
    async (request) => {
      const { locationId } = request.params as { locationId: string };
      await requireStaff(request, locationId);
      return { notified: await notifyUpcoming(locationId) };
    },
  );

  /**
   * Seat a walk-in, turning the queue entry into a real appointment.
   *
   * Defaults to the caller's own staff record — the common case is a barber
   * calling their own next client — but the front desk can name anyone.
   */
  app.post(
    '/queue/:queueEntryId/seat',
    {
      schema: {
        params: {
          type: 'object',
          required: ['queueEntryId'],
          properties: { queueEntryId: uuid },
        },
        body: {
          type: 'object',
          properties: { staffId: uuid },
        },
      },
    },
    async (request, reply) => {
      const { queueEntryId } = request.params as { queueEntryId: string };
      const body = (request.body ?? {}) as { staffId?: string };

      const { rows } = await getPool().query(
        `SELECT location_id FROM queue_entries WHERE id = $1`,
        [queueEntryId],
      );
      if (!rows[0]) throw notFound('Queue entry not found');

      const membership = await requireStaff(request, rows[0].location_id);
      const result = await promoteToAppointment(
        queueEntryId,
        body.staffId ?? membership.staffId,
      );

      return reply.status(201).send({
        appointmentId: result.appointmentId,
        startsAt: result.startsAt.toISOString(),
        endsAt: result.endsAt.toISOString(),
      });
    },
  );

  /** Reorder the queue by hand. Staff only. */
  app.post(
    '/queue/:queueEntryId/priority',
    {
      schema: {
        params: {
          type: 'object',
          required: ['queueEntryId'],
          properties: { queueEntryId: uuid },
        },
        body: {
          type: 'object',
          required: ['priority'],
          properties: { priority: { type: 'integer', minimum: -100, maximum: 100 } },
        },
      },
    },
    async (request) => {
      const { queueEntryId } = request.params as { queueEntryId: string };
      const body = request.body as { priority: number };

      const { rows } = await getPool().query(
        `SELECT location_id FROM queue_entries WHERE id = $1`,
        [queueEntryId],
      );
      if (!rows[0]) throw notFound('Queue entry not found');

      await requireStaff(request, rows[0].location_id);
      await bumpPriority(queueEntryId, body.priority);
      return { queueEntryId, priority: body.priority };
    },
  );
}
