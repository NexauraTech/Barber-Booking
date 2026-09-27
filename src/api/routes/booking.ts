import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { getPool } from '../../db/pool.js';
import {
  cancelAppointment,
  confirmAppointment,
  getAvailability,
  holdSlot,
  markNoShow,
} from '../../booking/commands.js';
import { cancelAndRefill } from '../../booking/cancel-and-refill.js';
import { startTimeOptions } from '../../domain/availability.js';
import { loadLocationPolicy } from '../../db/availability-repo.js';
import { ensureClientForUser } from '../../auth/service.js';
import {
  requireOwnerOrStaff,
  requirePrincipal,
  requireStaff,
} from '../context.js';
import { badRequest, notFound } from '../errors.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const serviceIds = {
  type: 'array',
  items: uuid,
  minItems: 1,
  maxItems: 10,
} as const;

export async function bookingRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Available start times. PUBLIC — browsing needs no account.
   *
   * Returns distinct start times with the barbers free at each, which is what
   * the client-facing time picker renders (docs/research/04-apps-and-ux.md §4.1).
   * Availability is computed, never read from a slots table.
   */
  app.get(
    '/locations/:locationId/availability',
    {
      schema: {
        params: {
          type: 'object',
          required: ['locationId'],
          properties: { locationId: uuid },
        },
        querystring: {
          type: 'object',
          required: ['serviceIds', 'date'],
          properties: {
            // Comma-separated, so the URL stays shareable and cacheable.
            serviceIds: { type: 'string' },
            date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            staffId: uuid,
          },
        },
      },
    },
    async (request) => {
      const { locationId } = request.params as { locationId: string };
      const query = request.query as {
        serviceIds: string;
        date: string;
        staffId?: string;
      };

      const ids = query.serviceIds.split(',').filter(Boolean);
      if (ids.length === 0) throw badRequest('At least one service is required');

      const location = await loadLocationPolicy(locationId);
      const { slots, staff } = await getAvailability({
        locationId,
        serviceIds: ids,
        date: query.date,
        staffId: query.staffId ?? null,
      });

      return {
        date: query.date,
        // Named explicitly: a client in another country must not be shown
        // times silently shifted into their own zone.
        timezone: location.timezone,
        options: startTimeOptions(slots).map((option) => ({
          start: new Date(option.start).toISOString(),
          end: new Date(option.end).toISOString(),
          staffIds: option.staffIds,
        })),
        staff: staff.map((s) => ({
          staffId: s.staffId,
          durationMinutes: s.durationMinutes,
        })),
      };
    },
  );

  /**
   * Hold a slot.
   *
   * A booking is a COMMAND with a server-decided outcome, not a row the
   * client writes. The hold reserves the time through the same exclusion
   * constraint as a confirmed booking, so nobody can take it during checkout,
   * and expires on its own if the user wanders off.
   */
  app.post(
    '/appointments/hold',
    {
      schema: {
        body: {
          type: 'object',
          required: ['locationId', 'serviceIds', 'start'],
          properties: {
            locationId: uuid,
            serviceIds,
            start: { type: 'string', format: 'date-time' },
            staffId: uuid,
            // Staff booking on someone else's behalf (phone bookings).
            clientId: uuid,
          },
        },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const body = request.body as {
        locationId: string;
        serviceIds: string[];
        start: string;
        staffId?: string;
        clientId?: string;
      };

      const location = await loadLocationPolicy(body.locationId);

      let clientId: string;
      let source: 'online' | 'phone' = 'online';

      if (body.clientId) {
        // Booking for someone else is a front-desk action.
        await requireStaff(request, body.locationId);
        clientId = body.clientId;
        source = 'phone';
      } else {
        clientId = await ensureClientForUser(principal.userId, location.orgId);
      }

      const appointment = await holdSlot({
        locationId: body.locationId,
        serviceIds: body.serviceIds,
        clientId,
        start: Date.parse(body.start),
        staffId: body.staffId ?? null,
        // Ties the hold to this session, so another tab cannot confirm it.
        sessionId: `user:${principal.userId}`,
        source,
      });

      return reply.status(201).send({
        appointmentId: appointment.id,
        staffId: appointment.staffId,
        startsAt: appointment.startsAt.toISOString(),
        endsAt: appointment.endsAt.toISOString(),
        holdExpiresAt: appointment.holdExpiresAt?.toISOString() ?? null,
      });
    },
  );

  /**
   * Confirm a held slot.
   *
   * The Idempotency-Key header is how a retry on a flaky mobile network
   * produces one booking rather than two. It is optional but strongly
   * recommended; without one, the caller generates a fresh key per attempt
   * and loses that protection.
   */
  app.post(
    '/appointments/:appointmentId/confirm',
    {
      schema: {
        params: {
          type: 'object',
          required: ['appointmentId'],
          properties: { appointmentId: uuid },
        },
        body: {
          type: 'object',
          properties: {
            notes: { type: 'string', maxLength: 1000 },
          },
        },
        headers: {
          type: 'object',
          properties: { 'idempotency-key': { type: 'string', maxLength: 200 } },
        },
      },
    },
    async (request) => {
      const principal = requirePrincipal(request);
      const { appointmentId } = request.params as { appointmentId: string };
      const body = (request.body ?? {}) as { notes?: string };

      const appointment = await confirmAppointment({
        appointmentId,
        sessionId: `user:${principal.userId}`,
        idempotencyKey:
          (request.headers['idempotency-key'] as string | undefined) ?? randomUUID(),
        notes: body.notes ?? null,
      });

      const { rows } = await getPool().query(
        `SELECT policy_snapshot FROM appointments WHERE id = $1`,
        [appointmentId],
      );

      return {
        appointmentId: appointment.id,
        status: appointment.status,
        staffId: appointment.staffId,
        startsAt: appointment.startsAt.toISOString(),
        endsAt: appointment.endsAt.toISOString(),
        // Returned so the confirmation screen can restate the terms the
        // client just accepted, rather than making them hunt for them.
        policy: rows[0]?.policy_snapshot ?? null,
      };
    },
  );

  /** A client's own bookings. */
  app.get('/appointments', async (request) => {
    const principal = requirePrincipal(request);
    const query = request.query as { upcoming?: string };

    const { rows } = await getPool().query(
      `SELECT a.id, a.location_id, a.staff_id, a.starts_at, a.ends_at, a.status,
              l.name AS location_name, l.address, l.timezone, s.display_name
         FROM appointments a
         JOIN clients c ON c.id = a.client_id
         JOIN locations l ON l.id = a.location_id
         JOIN staff s ON s.id = a.staff_id
        WHERE c.user_id = $1
          AND a.status IN ('confirmed','in_progress','completed')
          AND ($2::boolean IS NOT TRUE OR a.starts_at >= now())
        ORDER BY a.starts_at DESC
        LIMIT 100`,
      [principal.userId, query.upcoming === 'true'],
    );

    return {
      appointments: rows.map((r) => ({
        appointmentId: r.id,
        locationId: r.location_id,
        locationName: r.location_name,
        address: r.address,
        timezone: r.timezone,
        staffId: r.staff_id,
        staffName: r.display_name,
        startsAt: new Date(r.starts_at).toISOString(),
        endsAt: new Date(r.ends_at).toISOString(),
        status: r.status,
      })),
    };
  });

  /**
   * Cancel.
   *
   * The client may cancel their own; staff may cancel anyone's. Cancelling
   * frees the slot and immediately offers it to the waitlist, which is what
   * turns a cancellation into revenue rather than a hole in the day.
   */
  app.post(
    '/appointments/:appointmentId/cancel',
    {
      schema: {
        params: {
          type: 'object',
          required: ['appointmentId'],
          properties: { appointmentId: uuid },
        },
        body: {
          type: 'object',
          properties: { reason: { type: 'string', maxLength: 500 } },
        },
      },
    },
    async (request) => {
      const { appointmentId } = request.params as { appointmentId: string };
      const body = (request.body ?? {}) as { reason?: string };

      const appointment = await loadAppointmentOwner(appointmentId);
      await requireOwnerOrStaff(request, appointment.locationId, appointment.userId);

      const result = await cancelAndRefill({
        appointmentId,
        reason: body.reason ?? null,
      });

      return {
        appointmentId: result.appointmentId,
        // Stated plainly: a client should never discover a fee on a statement.
        feeCents: result.feeCents,
        // Whether the shop managed to resell the slot, for the staff view.
        refilled: result.offer !== null,
      };
    },
  );

  /** Mark a no-show. Staff only: a client cannot no-show themselves. */
  app.post(
    '/appointments/:appointmentId/no-show',
    {
      schema: {
        params: {
          type: 'object',
          required: ['appointmentId'],
          properties: { appointmentId: uuid },
        },
      },
    },
    async (request) => {
      const { appointmentId } = request.params as { appointmentId: string };
      const appointment = await loadAppointmentOwner(appointmentId);
      await requireStaff(request, appointment.locationId);

      const result = await markNoShow(appointmentId);

      return {
        appointmentId: result.appointment.id,
        feeCents: result.feeCents,
        // Handed back so the barber app can offer "waive" in one tap.
        feePaymentId: result.feePaymentId,
      };
    },
  );

  /** Start or finish a service. Staff only. */
  app.post(
    '/appointments/:appointmentId/status',
    {
      schema: {
        params: {
          type: 'object',
          required: ['appointmentId'],
          properties: { appointmentId: uuid },
        },
        body: {
          type: 'object',
          required: ['status'],
          properties: {
            status: { type: 'string', enum: ['in_progress', 'completed'] },
          },
        },
      },
    },
    async (request) => {
      const { appointmentId } = request.params as { appointmentId: string };
      const body = request.body as { status: 'in_progress' | 'completed' };

      const appointment = await loadAppointmentOwner(appointmentId);
      await requireStaff(request, appointment.locationId);

      const column = body.status === 'in_progress' ? 'started_at' : 'completed_at';
      const { rows } = await getPool().query(
        `UPDATE appointments
            SET status = $2::appointment_status, ${column} = now()
          WHERE id = $1 AND status IN ('confirmed','in_progress')
        RETURNING id, status`,
        [appointmentId, body.status],
      );

      if (!rows[0]) {
        throw badRequest('Appointment is not in a state that can be started or finished');
      }
      return { appointmentId: rows[0].id, status: rows[0].status };
    },
  );
}

async function loadAppointmentOwner(appointmentId: string): Promise<{
  locationId: string;
  userId: string | null;
}> {
  const { rows } = await getPool().query(
    `SELECT a.location_id, c.user_id
       FROM appointments a
       LEFT JOIN clients c ON c.id = a.client_id
      WHERE a.id = $1`,
    [appointmentId],
  );
  if (!rows[0]) throw notFound('Appointment not found');
  return { locationId: rows[0].location_id, userId: rows[0].user_id };
}

export { cancelAppointment };
