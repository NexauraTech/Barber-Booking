/**
 * Walk-in queue.
 *
 * In most of the world barbering is a walk-in trade, and a product that only
 * models a calendar loses to one that also models a queue
 * (docs/research/01-market-landscape.md §1.5). Joining requires no app and no
 * account: a QR code at the door opens a page, the client picks a service,
 * and they get a public token to watch their position.
 *
 * A queue entry is promoted into a real appointment the moment a barber takes
 * them, so walk-in revenue flows through the same checkout and reporting path
 * as booked revenue.
 */
import { getPool, withTransaction } from '../db/pool.js';
import type { PoolClient } from 'pg';
import {
  type BarberState,
  type QueueEstimate,
  type QueueParty,
  estimateQueue,
  partiesToNotify,
  quotedWaitMinutes,
} from '../domain/queue.js';
import { fitsInGap } from '../domain/availability.js';
import { loadAvailability, resolveServices } from '../db/availability-repo.js';
import { localDateOf } from '../domain/localtime.js';
import { BookingError, isSlotConflict } from '../booking/errors.js';
import { notifyNow } from '../notifications/scheduling.js';
import { cancelForQueueEntry } from '../notifications/outbox.js';
import {
  emitAppointmentCreated,
  emitQueueCalled,
  emitQueueChanged,
} from '../realtime/emit.js';

type Db = Pick<PoolClient, 'query'>;

export interface JoinQueueRequest {
  locationId: string;
  serviceIds: string[];
  /** A known client, or a guest identified only by name and phone. */
  clientId?: string | null;
  guestName?: string | null;
  guestPhone?: string | null;
  preferredStaffId?: string | null;
  now?: number;
}

export interface QueueEntry {
  id: string;
  locationId: string;
  clientId: string | null;
  guestName: string | null;
  guestPhone: string | null;
  serviceIds: string[];
  preferredStaffId: string | null;
  joinedAt: Date;
  status: string;
  publicToken: string;
}

function toEntry(row: Record<string, any>): QueueEntry {
  return {
    id: row.id,
    locationId: row.location_id,
    clientId: row.client_id,
    guestName: row.guest_name,
    guestPhone: row.guest_phone,
    serviceIds: row.service_ids,
    preferredStaffId: row.preferred_staff_id,
    joinedAt: new Date(row.joined_at),
    status: row.status,
    publicToken: row.public_token,
  };
}

export async function joinQueue(request: JoinQueueRequest): Promise<QueueEntry> {
  const now = new Date(request.now ?? Date.now());

  if (!request.clientId && !(request.guestName && request.guestPhone)) {
    throw new BookingError(
      'NOT_BOOKABLE',
      'A queue entry needs either a client or a guest name and phone',
    );
  }

  return withTransaction(async (client) => {
    // Reject services the shop does not offer before handing out a token.
    const services = await resolveServices(request.locationId, request.serviceIds, client);
    if (services.eligibleStaffIds.length === 0) {
      throw new BookingError(
        'NO_ELIGIBLE_STAFF',
        'No barber here performs the requested services',
      );
    }

    const { rows } = await client.query(
      `INSERT INTO queue_entries
         (location_id, client_id, guest_name, guest_phone,
          service_ids, preferred_staff_id, joined_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [
        request.locationId,
        request.clientId ?? null,
        request.guestName ?? null,
        request.guestPhone ?? null,
        request.serviceIds,
        request.preferredStaffId ?? null,
        now,
      ],
    );

    return toEntry(rows[0]);
  });
}

/**
 * Join and announce.
 *
 * The announce is a separate step after the write commits, because the queue
 * snapshot has to be recomputed from committed state — positions and ETAs for
 * everyone, not just the joiner.
 */
export async function joinQueueAndAnnounce(
  request: JoinQueueRequest,
): Promise<QueueEntry> {
  const entry = await joinQueue(request);
  await emitQueueChanged(request.locationId, request.now ?? Date.now());
  return entry;
}

export interface LiveQueue {
  entries: Array<QueueEntry & { estimate: QueueEstimate }>;
  quotedWaitMinutes: number | null;
}

/**
 * The live queue with estimates.
 *
 * Barbers' free-at times come from appointments actually in progress, so a
 * barber running late pushes every downstream estimate rather than only the
 * next one.
 */
export async function getLiveQueue(
  locationId: string,
  now: number = Date.now(),
  client?: Db,
): Promise<LiveQueue> {
  const db: Db = client ?? getPool();

  const { rows: entries } = await db.query(
    `SELECT * FROM queue_entries
      WHERE location_id = $1 AND status IN ('waiting','notified')
      ORDER BY priority DESC, joined_at`,
    [locationId],
  );

  // A barber is busy until their in-progress appointment finishes. Measuring
  // from when the client ACTUALLY sat down rather than the scheduled start
  // means a barber running twelve minutes late pushes every downstream
  // estimate, instead of the queue quietly pretending they are on time.
  const { rows: staffRows } = await db.query(
    `SELECT s.id,
            s.accepts_walkins,
            (SELECT max(coalesce(a.started_at, a.starts_at) + (a.ends_at - a.starts_at))
               FROM appointments a
              WHERE a.staff_id = s.id
                AND a.status = 'in_progress') AS busy_until
       FROM staff s
      WHERE s.location_id = $1 AND s.active`,
    [locationId],
  );

  // Service durations differ per barber; the queue quotes the location
  // default, since the barber is not yet decided.
  const serviceIds = [...new Set(entries.flatMap((e) => e.service_ids as string[]))];
  const durations = new Map<string, number>();

  if (serviceIds.length > 0) {
    const { rows } = await db.query(
      `SELECT id, duration_minutes FROM services WHERE id = ANY($1::uuid[])`,
      [serviceIds],
    );
    for (const row of rows) durations.set(row.id, row.duration_minutes);
  }

  const parties: QueueParty[] = entries.map((e) => ({
    id: e.id,
    serviceMinutes: (e.service_ids as string[]).reduce(
      (sum, id) => sum + (durations.get(id) ?? 0),
      0,
    ),
    preferredStaffId: e.preferred_staff_id,
    priority: e.priority,
    joinedAt: new Date(e.joined_at).getTime(),
  }));

  const barbers: BarberState[] = staffRows.map((s) => ({
    staffId: s.id,
    available: s.accepts_walkins,
    busyUntil: s.busy_until ? new Date(s.busy_until).getTime() : null,
  }));

  const estimates = estimateQueue(parties, barbers, now);
  const byId = new Map(estimates.map((e) => [e.partyId, e]));

  return {
    entries: entries.map((row) => ({
      ...toEntry(row),
      estimate: byId.get(row.id)!,
    })),
    quotedWaitMinutes: quotedWaitMinutes(estimates),
  };
}

/**
 * The public, no-auth view for a client watching from their phone.
 *
 * Deliberately narrow: position and ETA only. The queue page is reachable by
 * anyone holding the token, so it must not leak other clients' names or
 * numbers (docs/research/03-realtime.md §3.2).
 */
export async function getPublicQueueStatus(
  publicToken: string,
  now: number = Date.now(),
): Promise<{
  status: string;
  position: number | null;
  rangeStartMinutes: number | null;
  rangeEndMinutes: number | null;
} | null> {
  const { rows } = await getPool().query(
    `SELECT id, location_id, status FROM queue_entries WHERE public_token = $1`,
    [publicToken],
  );
  const entry = rows[0];
  if (!entry) return null;

  if (!['waiting', 'notified'].includes(entry.status)) {
    return {
      status: entry.status,
      position: null,
      rangeStartMinutes: null,
      rangeEndMinutes: null,
    };
  }

  const live = await getLiveQueue(entry.location_id, now);
  const mine = live.entries.find((e) => e.id === entry.id);
  if (!mine) return null;

  return {
    status: mine.status,
    position: mine.estimate.position,
    rangeStartMinutes: mine.estimate.rangeStartMinutes,
    rangeEndMinutes: mine.estimate.rangeEndMinutes,
  };
}

/**
 * Nudge parties who are nearly up.
 *
 * The whole point of a virtual queue is that clients wait elsewhere, so the
 * call-up must reach them before the chair is free.
 */
export async function notifyUpcoming(
  locationId: string,
  now: number = Date.now(),
): Promise<string[]> {
  const { rows: config } = await getPool().query(
    `SELECT queue_notify_ahead FROM locations WHERE id = $1`,
    [locationId],
  );
  const notifyAhead = config[0]?.queue_notify_ahead ?? 2;

  const live = await getLiveQueue(locationId, now);
  const alreadyNotified = new Set(
    live.entries.filter((e) => e.status === 'notified').map((e) => e.id),
  );

  const toNotify = partiesToNotify(
    live.entries.map((e) => e.estimate),
    notifyAhead,
    alreadyNotified,
  );

  for (const id of toNotify) {
    const entry = live.entries.find((e) => e.id === id)!;

    await notifyNow({
      locationId,
      clientId: entry.clientId,
      address: entry.guestPhone,
      template: 'queue_nearly_up',
      payload: {
        position: entry.estimate.position,
        rangeEndMinutes: entry.estimate.rangeEndMinutes,
      },
      dedupeKey: `queue:${id}:nearly_up`,
      urgent: true,
      queueEntryId: id,
      now,
    });

    await getPool().query(
      `UPDATE queue_entries SET status = 'notified', notified_at = $2 WHERE id = $1`,
      [id, new Date(now)],
    );

    await emitQueueCalled(locationId, {
      id,
      clientId: entry.clientId,
      name: entry.guestName,
      position: entry.estimate.position,
    });
  }

  if (toNotify.length > 0) await emitQueueChanged(locationId, now);
  return toNotify;
}

/**
 * Take the next party into a chair, creating a real appointment.
 *
 * The promotion goes through the same exclusion constraint as any booking, so
 * a walk-in cannot be seated on top of a booked client — and `fitsInGap`
 * checks it will finish before the next appointment starts.
 */
export async function promoteToAppointment(
  queueEntryId: string,
  staffId: string,
  now: number = Date.now(),
): Promise<{
  appointmentId: string;
  startsAt: Date;
  endsAt: Date;
  locationId: string;
}> {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM queue_entries WHERE id = $1 FOR UPDATE`,
      [queueEntryId],
    );
    const entry = rows[0];
    if (!entry) throw new BookingError('NOT_FOUND', 'Queue entry not found');
    if (!['waiting', 'notified'].includes(entry.status)) {
      throw new BookingError(
        'INVALID_STATE',
        `Cannot seat a queue entry that is ${entry.status}`,
      );
    }

    const date = await locationDate(entry.location_id, now, client);
    const { services, query } = await loadAvailability(
      {
        locationId: entry.location_id,
        serviceIds: entry.service_ids,
        date,
        staffId,
        now,
        includeOfflineOnly: true,
      },
      client,
    );

    const staffInput = query.staff.find((s) => s.staffId === staffId);
    if (!staffInput) {
      throw new BookingError(
        'NO_ELIGIBLE_STAFF',
        'That barber cannot take this walk-in right now',
      );
    }

    if (!fitsInGap(now, staffInput.durationMinutes, staffInput)) {
      throw new BookingError('SLOT_TAKEN', 'This walk-in will not fit before the next appointment', {
        durationMinutes: staffInput.durationMinutes,
      });
    }

    // A guest becomes a client record on being seated, so history, receipts
    // and rebooking all work from the first visit.
    const clientId =
      entry.client_id ?? (await upsertGuestClient(entry, client));

    const endsAt = new Date(now + staffInput.durationMinutes * 60_000);

    let appointment;
    try {
      const inserted = await client.query(
        `INSERT INTO appointments
           (location_id, staff_id, client_id, starts_at, ends_at,
            buffer_before_minutes, buffer_after_minutes,
            status, source, started_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'in_progress','walkin',$4)
         RETURNING *`,
        [
          entry.location_id,
          staffId,
          clientId,
          new Date(now),
          endsAt,
          services.bufferBeforeMinutes,
          services.bufferAfterMinutes,
        ],
      );
      appointment = inserted.rows[0];
    } catch (err) {
      if (isSlotConflict(err)) {
        throw new BookingError('SLOT_TAKEN', 'That barber was just booked');
      }
      throw err;
    }

    for (const [index, serviceId] of (entry.service_ids as string[]).entries()) {
      const { rows: svc } = await client.query(
        `SELECT s.name, s.duration_minutes, s.price_cents,
                ss.duration_minutes AS staff_duration, ss.price_cents AS staff_price
           FROM services s
           LEFT JOIN staff_services ss ON ss.service_id = s.id AND ss.staff_id = $2
          WHERE s.id = $1`,
        [serviceId, staffId],
      );
      const row = svc[0];
      await client.query(
        `INSERT INTO appointment_services
           (appointment_id, service_id, name, duration_minutes, price_cents, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          appointment.id,
          serviceId,
          row.name,
          row.staff_duration ?? row.duration_minutes,
          row.staff_price ?? row.price_cents,
          index,
        ],
      );
    }

    await client.query(
      `UPDATE queue_entries
          SET status = 'promoted', promoted_appointment_id = $2
        WHERE id = $1`,
      [queueEntryId, appointment.id],
    );

    await cancelForQueueEntry(queueEntryId, client);
    await emitAppointmentCreated(appointment, client);

    return {
      appointmentId: appointment.id,
      startsAt: new Date(appointment.starts_at),
      endsAt: new Date(appointment.ends_at),
      locationId: entry.location_id,
    };
  });
}

async function locationDate(
  locationId: string,
  now: number,
  client: Db,
): Promise<string> {
  const { rows } = await client.query(
    `SELECT timezone FROM locations WHERE id = $1`,
    [locationId],
  );
  return localDateOf(now, rows[0].timezone);
}

async function upsertGuestClient(
  entry: Record<string, any>,
  client: Db,
): Promise<string> {
  const { rows } = await client.query(
    `INSERT INTO clients (org_id, name, phone)
     SELECT l.org_id, $2, $3 FROM locations l WHERE l.id = $1
     ON CONFLICT (org_id, phone) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [entry.location_id, entry.guest_name, entry.guest_phone],
  );
  return rows[0].id;
}

/** Abandon a queue entry — the client left, or never came back. */
export async function abandonQueueEntry(
  queueEntryId: string,
): Promise<void> {
  const locationId = await withTransaction(async (client) => {
    const { rowCount, rows } = await client.query(
      `UPDATE queue_entries SET status = 'abandoned'
        WHERE id = $1 AND status IN ('waiting','notified')
      RETURNING location_id`,
      [queueEntryId],
    );
    if (rowCount === 0) {
      throw new BookingError('INVALID_STATE', 'Queue entry is no longer waiting');
    }
    await cancelForQueueEntry(queueEntryId, client);
    return rows[0]?.location_id as string | undefined;
  });
}

/** Manual reordering by the front desk, expressed as a priority bump. */
export async function bumpPriority(
  queueEntryId: string,
  priority: number,
): Promise<void> {
  const { rows } = await getPool().query(
    `UPDATE queue_entries SET priority = $2 WHERE id = $1 RETURNING location_id`,
    [queueEntryId, priority],
  );
  // Reordering moves everyone's estimate, not just this entry's.
  if (rows[0]) await emitQueueChanged(rows[0].location_id);
}
