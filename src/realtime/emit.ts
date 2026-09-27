/**
 * Emitting events from the write path.
 *
 * Every helper here takes the transaction's client, so the notification is
 * held by Postgres until COMMIT and discarded on ROLLBACK. That is the whole
 * reason the bus is Postgres: an event can only describe a write that landed.
 *
 * Emitting must never break the write. A realtime fan-out that fails is a
 * degraded UI; a booking that fails because the fan-out did is lost revenue.
 * So every helper swallows its own errors — the HTTP response and the
 * committed row remain the source of truth, and clients recover by refetching.
 */
import type { PoolClient } from 'pg';
import { publish } from './bus.js';
import { localDateOf } from '../domain/localtime.js';
import { getLiveQueue } from '../queue/service.js';

type Db = Pick<PoolClient, 'query'>;

/** Runs `fn`, logging rather than propagating any failure. */
async function safely(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    // Deliberately swallowed: see the note at the top of this file.
    if (process.env.REALTIME_DEBUG === 'true') {
      console.warn('realtime emit failed', err);
    }
  }
}

interface AppointmentRow {
  id: string;
  location_id: string;
  staff_id: string;
  client_id: string;
  starts_at: Date | string;
  ends_at: Date | string;
  source?: string;
}

async function contextFor(
  appointment: AppointmentRow,
  client: Db,
): Promise<{ timezone: string; clientName: string }> {
  const { rows } = await client.query(
    `SELECT l.timezone, c.name
       FROM locations l
       LEFT JOIN clients c ON c.id = $2
      WHERE l.id = $1`,
    [appointment.location_id, appointment.client_id],
  );
  return {
    timezone: rows[0]?.timezone ?? 'UTC',
    clientName: rows[0]?.name ?? 'Client',
  };
}

const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

export async function emitAppointmentCreated(
  appointment: AppointmentRow,
  client: Db,
): Promise<void> {
  await safely(async () => {
    const { timezone, clientName } = await contextFor(appointment, client);
    const startsAt = iso(appointment.starts_at);

    await publish(
      {
        type: 'appointment.created',
        locationId: appointment.location_id,
        appointmentId: appointment.id,
        staffId: appointment.staff_id,
        clientId: appointment.client_id,
        clientName,
        startsAt,
        endsAt: iso(appointment.ends_at),
        localDate: localDateOf(Date.parse(startsAt), timezone),
        source: appointment.source ?? 'online',
      },
      client,
    );
  });
}

export async function emitAppointmentCancelled(
  appointment: AppointmentRow,
  refilled: boolean,
  client: Db,
): Promise<void> {
  await safely(async () => {
    const { timezone, clientName } = await contextFor(appointment, client);
    const startsAt = iso(appointment.starts_at);

    await publish(
      {
        type: 'appointment.cancelled',
        locationId: appointment.location_id,
        appointmentId: appointment.id,
        staffId: appointment.staff_id,
        clientId: appointment.client_id,
        clientName,
        startsAt,
        endsAt: iso(appointment.ends_at),
        localDate: localDateOf(Date.parse(startsAt), timezone),
        refilled,
      },
      client,
    );
  });
}

export async function emitAppointmentStatus(
  appointment: AppointmentRow,
  status: 'in_progress' | 'completed' | 'no_show',
  client: Db,
): Promise<void> {
  await safely(async () => {
    const { timezone, clientName } = await contextFor(appointment, client);
    const startsAt = iso(appointment.starts_at);

    await publish(
      {
        type: 'appointment.status',
        locationId: appointment.location_id,
        appointmentId: appointment.id,
        staffId: appointment.staff_id,
        clientId: appointment.client_id,
        clientName,
        startsAt,
        localDate: localDateOf(Date.parse(startsAt), timezone),
        status,
      },
      client,
    );
  });
}

/**
 * Publish the queue as a whole.
 *
 * A queue is a handful of people, and every change reorders and re-estimates
 * everyone behind it — so a snapshot is both simpler and smaller than a set of
 * per-entry deltas. Published AFTER the transaction, because the recomputed
 * positions have to reflect the committed state.
 */
export async function emitQueueChanged(
  locationId: string,
  now = Date.now(),
): Promise<void> {
  await safely(async () => {
    const live = await getLiveQueue(locationId, now);

    await publish({
      type: 'queue.changed',
      locationId,
      quotedWaitMinutes: live.quotedWaitMinutes,
      entries: live.entries.map((entry) => ({
        queueEntryId: entry.id,
        position: entry.estimate.position,
        name: entry.guestName,
        phone: entry.guestPhone,
        clientId: entry.clientId,
        status: entry.status,
        assignedStaffId: entry.estimate.staffId,
        waitFromMinutes: entry.estimate.rangeStartMinutes,
        waitToMinutes: entry.estimate.rangeEndMinutes,
      })),
    });
  });
}

export async function emitQueueCalled(
  locationId: string,
  entry: { id: string; clientId: string | null; name: string | null; position: number },
): Promise<void> {
  await safely(async () => {
    await publish({
      type: 'queue.called',
      locationId,
      queueEntryId: entry.id,
      clientId: entry.clientId,
      name: entry.name,
      position: entry.position,
    });
  });
}

export async function emitWaitlistOffered(
  params: {
    locationId: string;
    waitlistEntryId: string;
    clientId: string;
    appointmentId: string;
    startsAt: string;
    expiresAt: string;
  },
  client?: Db,
): Promise<void> {
  await safely(async () => {
    await publish({ type: 'waitlist.offered', ...params }, client);
  });
}

export async function emitWaitlistResolved(
  params: {
    locationId: string;
    waitlistEntryId: string;
    clientId: string;
    outcome: 'accepted' | 'expired';
  },
  client?: Db,
): Promise<void> {
  await safely(async () => {
    await publish({ type: 'waitlist.resolved', ...params }, client);
  });
}

export async function emitCheckoutCompleted(
  params: {
    locationId: string;
    checkoutId: string;
    appointmentId: string | null;
    staffId: string | null;
    clientId: string | null;
    totalCents: number;
    currency: string;
  },
  client?: Db,
): Promise<void> {
  await safely(async () => {
    await publish({ type: 'checkout.completed', ...params }, client);
  });
}

export async function emitStaffPresence(
  locationId: string,
  staffId: string,
  state: 'available' | 'with_client' | 'on_break' | 'off',
): Promise<void> {
  await safely(async () => {
    await publish({ type: 'staff.presence', locationId, staffId, state });
  });
}
