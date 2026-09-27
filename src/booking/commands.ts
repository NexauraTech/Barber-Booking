/**
 * Booking commands.
 *
 * Every write to `appointments` goes through here. Clients read availability
 * broadly over realtime channels but never write an appointment row directly:
 * a booking is a command with a server-decided outcome, not client-owned
 * state (docs/research/03-realtime.md §3.4).
 *
 * The three layers of double-booking protection (§2.5):
 *   1. the exclusion constraint in the database — the actual guarantee
 *   2. short-lived holds, so a user can pay without the slot being taken and
 *      without holding a lock across a network round trip
 *   3. idempotency keys, so a retry on a flaky mobile network produces one
 *      appointment rather than two
 */
import { withTransaction } from '../db/pool.js';
import type { PoolClient } from 'pg';
import {
  type AvailabilityRequest,
  loadAvailability,
  loadLocationPolicy,
  resolveServices,
} from '../db/availability-repo.js';
import { assignAnyBarber, availableSlots } from '../domain/availability.js';
import { localDateOf } from '../domain/localtime.js';
import { BookingError, isSlotConflict } from './errors.js';
import {
  chargeLateCancellation,
  chargeNoShow,
  decidePolicy,
  recordDeposit,
} from './policy-service.js';
import { scheduleReminders } from '../notifications/scheduling.js';
import { cancelForAppointment } from '../notifications/outbox.js';
import {
  emitAppointmentCancelled,
  emitAppointmentCreated,
  emitAppointmentStatus,
} from '../realtime/emit.js';

export type AppointmentStatus =
  | 'pending'
  | 'confirmed'
  | 'in_progress'
  | 'completed'
  | 'cancelled'
  | 'no_show';

export interface Appointment {
  id: string;
  locationId: string;
  staffId: string;
  clientId: string;
  startsAt: Date;
  endsAt: Date;
  status: AppointmentStatus;
  source: string;
  holdExpiresAt: Date | null;
}

function toAppointment(row: Record<string, any>): Appointment {
  return {
    id: row.id,
    locationId: row.location_id,
    staffId: row.staff_id,
    clientId: row.client_id,
    startsAt: new Date(row.starts_at),
    endsAt: new Date(row.ends_at),
    status: row.status,
    source: row.source,
    holdExpiresAt: row.hold_expires_at ? new Date(row.hold_expires_at) : null,
  };
}

export interface HoldRequest {
  locationId: string;
  serviceIds: string[];
  clientId: string;
  /** Instant the service should start. */
  start: number;
  /** Omit for "any barber": the least-fragmenting free barber is chosen. */
  staffId?: string | null;
  sessionId: string;
  source?: 'online' | 'walkin' | 'phone' | 'marketplace' | 'recurring';
  now?: number;
}

/**
 * Reserve a slot as a `pending` appointment with an expiry.
 *
 * The pending row participates in the exclusion constraint, so the slot is
 * genuinely held — but it expires on its own, so an abandoned checkout
 * releases the time without manual cleanup.
 */
export async function holdSlot(request: HoldRequest): Promise<Appointment> {
  const now = request.now ?? Date.now();

  return withTransaction(async (client) => {
    const location = await loadLocationPolicy(request.locationId, client);
    const date = localDateOf(request.start, location.timezone);

    const availabilityRequest: AvailabilityRequest = {
      locationId: request.locationId,
      serviceIds: request.serviceIds,
      date,
      staffId: request.staffId ?? null,
      now,
      // Staff-initiated bookings may target a barber with online booking off.
      includeOfflineOnly: request.source != null && request.source !== 'online',
    };

    const { services, query } = await loadAvailability(availabilityRequest, client);

    if (query.staff.length === 0) {
      throw new BookingError(
        'NO_ELIGIBLE_STAFF',
        'No barber at this location can perform the requested services on that date',
      );
    }

    const slots = availableSlots(query);
    const chosen = request.staffId
      ? slots.find((s) => s.start === request.start && s.staffId === request.staffId)
      : assignAnyBarber(request.start, slots, query.staff);

    if (!chosen) {
      throw new BookingError('SLOT_TAKEN', 'That time is no longer available', {
        start: new Date(request.start).toISOString(),
      });
    }

    const holdExpiresAt = new Date(now + location.holdTtlSeconds * 1000);

    let inserted;
    try {
      inserted = await client.query(
        `INSERT INTO appointments
           (location_id, staff_id, client_id, starts_at, ends_at,
            buffer_before_minutes, buffer_after_minutes,
            status, source, hold_expires_at, hold_session_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9,$10)
         RETURNING *`,
        [
          request.locationId,
          chosen.staffId,
          request.clientId,
          new Date(chosen.start),
          new Date(chosen.end),
          services.bufferBeforeMinutes,
          services.bufferAfterMinutes,
          request.source ?? 'online',
          holdExpiresAt,
          request.sessionId,
        ],
      );
    } catch (err) {
      // Someone else won the race between our availability read and this
      // insert. The constraint is the real guarantee; this is the expected
      // losing path, not an error condition.
      if (isSlotConflict(err)) {
        throw new BookingError('SLOT_TAKEN', 'That time was just taken', {
          start: new Date(request.start).toISOString(),
        });
      }
      throw err;
    }

    const appointment = inserted.rows[0];

    await insertAppointmentServices(
      client,
      appointment.id,
      request.locationId,
      request.serviceIds,
      chosen.staffId,
    );

    if (services.resourceTypeId) {
      await client.query(
        `INSERT INTO appointment_resources (appointment_id, resource_type_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [appointment.id, services.resourceTypeId],
      );
    }

    return toAppointment(appointment);
  });
}

/** Snapshot service names, durations and prices onto the appointment. */
async function insertAppointmentServices(
  client: PoolClient,
  appointmentId: string,
  locationId: string,
  serviceIds: readonly string[],
  staffId: string,
): Promise<void> {
  const { rows } = await client.query(
    `SELECT s.id, s.name, s.duration_minutes, s.price_cents,
            ss.duration_minutes AS staff_duration,
            ss.price_cents      AS staff_price
       FROM services s
       LEFT JOIN staff_services ss
              ON ss.service_id = s.id AND ss.staff_id = $2
      WHERE s.location_id = $3 AND s.id = ANY($1::uuid[])`,
    [serviceIds, staffId, locationId],
  );

  const byId = new Map(rows.map((r) => [r.id, r]));

  for (const [index, id] of serviceIds.entries()) {
    const row = byId.get(id);
    if (!row) throw new BookingError('NOT_BOOKABLE', `Unknown service: ${id}`);

    await client.query(
      `INSERT INTO appointment_services
         (appointment_id, service_id, name, duration_minutes, price_cents, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        appointmentId,
        id,
        row.name,
        row.staff_duration ?? row.duration_minutes,
        row.staff_price ?? row.price_cents,
        index,
      ],
    );
  }
}

export interface ConfirmRequest {
  appointmentId: string;
  sessionId: string;
  /** Replay protection; the same key returns the original appointment. */
  idempotencyKey: string;
  notes?: string | null;
  policySnapshot?: Record<string, unknown>;
  now?: number;
}

/**
 * Promote a held slot to a confirmed booking.
 *
 * Verifies the hold still belongs to this session and has not expired, so a
 * user who leaves a checkout open for an hour is told the slot lapsed rather
 * than silently taking a time someone else has since booked.
 */
export async function confirmAppointment(
  request: ConfirmRequest,
): Promise<Appointment> {
  const now = new Date(request.now ?? Date.now());

  return withTransaction(async (client) => {
    // A replayed request returns the original result rather than failing.
    const replay = await client.query(
      `SELECT * FROM appointments WHERE idempotency_key = $1`,
      [request.idempotencyKey],
    );
    if (replay.rows[0]) return toAppointment(replay.rows[0]);

    const { rows } = await client.query(
      `SELECT * FROM appointments WHERE id = $1 FOR UPDATE`,
      [request.appointmentId],
    );
    const held = rows[0];

    if (!held) throw new BookingError('NOT_FOUND', 'Appointment not found');

    if (held.status !== 'pending') {
      // Already confirmed by an earlier attempt that lost its response.
      if (held.status === 'confirmed') return toAppointment(held);
      throw new BookingError(
        'INVALID_STATE',
        `Cannot confirm an appointment that is ${held.status}`,
      );
    }

    if (held.hold_session_id !== request.sessionId) {
      throw new BookingError('HOLD_NOT_YOURS', 'This hold belongs to another session');
    }

    if (new Date(held.hold_expires_at) <= now) {
      throw new BookingError('HOLD_EXPIRED', 'Your hold on this slot expired', {
        start: new Date(held.starts_at).toISOString(),
      });
    }

    const location = await loadLocationPolicy(held.location_id, client);

    // Freeze the terms this client is agreeing to. A policy change tomorrow
    // must not alter what was accepted today.
    const { rows: serviceRows } = await client.query(
      `SELECT service_id FROM appointment_services WHERE appointment_id = $1`,
      [request.appointmentId],
    );
    const serviceIds = serviceRows.map((r) => r.service_id);

    const decision = await decidePolicy(
      location,
      request.appointmentId,
      held.client_id,
      serviceIds,
      client,
    );

    const updated = await client.query(
      `UPDATE appointments
          SET status = 'confirmed',
              hold_expires_at = NULL,
              hold_session_id = NULL,
              idempotency_key = $2,
              notes = COALESCE($3, notes),
              policy_snapshot = $4
        WHERE id = $1
      RETURNING *`,
      [
        request.appointmentId,
        request.idempotencyKey,
        request.notes ?? null,
        JSON.stringify(request.policySnapshot ?? decision.snapshot),
      ],
    );

    if (decision.depositRequired) {
      await recordDeposit(
        location,
        request.appointmentId,
        held.client_id,
        decision.depositCents,
        await currencyFor(held.location_id, client),
        client,
      );
    }

    await scheduleReminders(
      {
        appointmentId: request.appointmentId,
        locationId: held.location_id,
        clientId: held.client_id,
        appointmentStart: new Date(held.starts_at).getTime(),
        cancellationWindowHours: location.cancellationWindowHours,
        now: now.getTime(),
      },
      client,
    );

    // A hold is not news; a confirmed booking is. Published on this client so
    // Postgres holds it until commit and drops it if the transaction fails.
    await emitAppointmentCreated(updated.rows[0], client);

    return toAppointment(updated.rows[0]);
  });
}

async function currencyFor(locationId: string, client: PoolClient): Promise<string> {
  const { rows } = await client.query(
    `SELECT currency FROM locations WHERE id = $1`,
    [locationId],
  );
  return rows[0]?.currency ?? 'USD';
}

export interface CancelRequest {
  appointmentId: string;
  reason?: string | null;
  /** Counts toward the client's late-cancellation reputation. */
  late?: boolean;
  now?: number;
}

/**
 * Cancel a booking, releasing the slot.
 *
 * Cancelled rows are excluded from the exclusion constraint, so the time
 * becomes immediately resellable — which is what lets the waitlist fill it
 * (docs/research/02-scheduling-engine.md §2.8).
 */
export interface CancelResult {
  appointment: Appointment;
  /** Fee charged under the accepted policy, if any. */
  feeCents: number;
  /** Services freed, so the caller can offer the slot to the waitlist. */
  freedServiceIds: string[];
}

export async function cancelAppointment(
  request: CancelRequest,
): Promise<CancelResult> {
  const now = new Date(request.now ?? Date.now());

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE appointments
          SET status = 'cancelled',
              cancelled_at = $2,
              cancellation_reason = $3,
              hold_expires_at = NULL,
              hold_session_id = NULL
        WHERE id = $1
          AND status IN ('pending','confirmed','in_progress')
      RETURNING *`,
      [request.appointmentId, now, request.reason ?? null],
    );

    const cancelled = rows[0];
    if (!cancelled) {
      throw new BookingError('INVALID_STATE', 'Appointment cannot be cancelled');
    }

    const location = await loadLocationPolicy(cancelled.location_id, client);

    // Judge the fee against the snapshot the client accepted, not against
    // whatever the shop's policy says now.
    const fee = await chargeLateCancellation(
      location,
      {
        id: cancelled.id,
        clientId: cancelled.client_id,
        startsAt: new Date(cancelled.starts_at).getTime(),
        policySnapshot: cancelled.policy_snapshot,
      },
      now.getTime(),
      await currencyFor(cancelled.location_id, client),
      client,
    );

    if (fee || request.late) {
      await client.query(
        `UPDATE clients SET late_cancel_count = late_cancel_count + 1 WHERE id = $1`,
        [cancelled.client_id],
      );
    }

    // Reminding someone about an appointment they cancelled is a small
    // betrayal that loses clients.
    await cancelForAppointment(cancelled.id, client);

    const { rows: services } = await client.query(
      `SELECT service_id FROM appointment_services WHERE appointment_id = $1
        ORDER BY sort_order`,
      [cancelled.id],
    );

    // `refilled` is not known yet — cancelAndRefill emits the authoritative
    // event after it has tried the waitlist. This one keeps a plain cancel
    // (no refill attempt) from being silent.
    await emitAppointmentCancelled(cancelled, false, client);

    return {
      appointment: toAppointment(cancelled),
      feeCents: fee?.amountCents ?? 0,
      freedServiceIds: services.map((s) => s.service_id),
    };
  });
}

export interface NoShowResult {
  appointment: Appointment;
  /** Fee raised under the accepted policy; always waivable by the barber. */
  feeCents: number;
  feePaymentId: string | null;
}

/**
 * Mark a confirmed booking as a no-show.
 *
 * Raises the fee automatically — the whole point of the policy is that it
 * does not depend on a busy barber remembering — while leaving it as a
 * `pending` payment a barber can waive in one action.
 */
export async function markNoShow(
  appointmentId: string,
  now = new Date(),
): Promise<NoShowResult> {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE appointments
          SET status = 'no_show'
        WHERE id = $1 AND status IN ('confirmed','in_progress')
      RETURNING *`,
      [appointmentId],
    );

    const appointment = rows[0];
    if (!appointment) {
      throw new BookingError('INVALID_STATE', 'Appointment cannot be marked no-show');
    }

    await client.query(
      `UPDATE clients SET no_show_count = no_show_count + 1 WHERE id = $1`,
      [appointment.client_id],
    );

    const location = await loadLocationPolicy(appointment.location_id, client);
    const fee = await chargeNoShow(
      location,
      {
        id: appointment.id,
        clientId: appointment.client_id,
        policySnapshot: appointment.policy_snapshot,
      },
      await currencyFor(appointment.location_id, client),
      client,
    );

    await cancelForAppointment(appointment.id, client);
    await emitAppointmentStatus(appointment, 'no_show', client);

    return {
      appointment: toAppointment(appointment),
      feeCents: fee?.amountCents ?? 0,
      feePaymentId: fee?.id ?? null,
    };
  });
}

/**
 * Release holds whose expiry has passed.
 *
 * Availability reads already ignore expired holds, so this is housekeeping
 * rather than correctness — but without it the exclusion constraint keeps
 * blocking the slot for new inserts.
 */
export async function expireStaleHolds(now = new Date()): Promise<number> {
  return withTransaction(async (client) => {
    const { rowCount } = await client.query(
      `UPDATE appointments
          SET status = 'cancelled',
              cancelled_at = $1,
              cancellation_reason = 'hold expired',
              hold_expires_at = NULL,
              hold_session_id = NULL
        WHERE status = 'pending' AND hold_expires_at <= $1`,
      [now],
    );
    return rowCount ?? 0;
  });
}

/** Slots for the client-facing time picker. */
export async function getAvailability(request: AvailabilityRequest) {
  const { query, services } = await loadAvailability(request);
  return { slots: availableSlots(query), services, staff: query.staff };
}

export { resolveServices };
