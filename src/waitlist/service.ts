/**
 * Waitlist with automatic cancellation fill.
 *
 * When a booking is cancelled the freed slot is offered to matching
 * waitlisted clients — best match first, with a short exclusive window, then
 * cascading to the next. This turns cancellations into revenue instead of
 * holes, and is the single most-praised feature in competitor reviews
 * (docs/research/02-scheduling-engine.md §2.8).
 *
 * The offer is a real `pending` appointment, so the slot is genuinely held
 * for the offered client by the same exclusion constraint that protects every
 * other booking. Nobody can book underneath an outstanding offer.
 */
import { getPool, withTransaction } from '../db/pool.js';
import type { PoolClient } from 'pg';
import { DateTime } from 'luxon';
import { availableSlots } from '../domain/availability.js';
import { loadAvailability, loadLocationPolicy } from '../db/availability-repo.js';
import { localDateOf } from '../domain/localtime.js';
import { BookingError, isSlotConflict } from '../booking/errors.js';
import { notifyNow } from '../notifications/scheduling.js';
import { emitWaitlistOffered, emitWaitlistResolved } from '../realtime/emit.js';

type Db = Pick<PoolClient, 'query'>;
const db = (client?: Db): Db => client ?? getPool();

export interface JoinWaitlistRequest {
  locationId: string;
  clientId: string;
  serviceIds: string[];
  /** Null means any barber. */
  staffId?: string | null;
  fromDate: string;
  toDate: string;
  /** Optional time-of-day window the client would accept. */
  earliestTime?: string | null;
  latestTime?: string | null;
}

export interface WaitlistEntry {
  id: string;
  locationId: string;
  clientId: string;
  serviceIds: string[];
  staffId: string | null;
  fromDate: string;
  toDate: string;
  status: string;
  offerExpiresAt: Date | null;
  offeredAppointmentId: string | null;
}

function toEntry(row: Record<string, any>): WaitlistEntry {
  return {
    id: row.id,
    locationId: row.location_id,
    clientId: row.client_id,
    serviceIds: row.service_ids,
    staffId: row.staff_id,
    fromDate: row.from_date,
    toDate: row.to_date,
    status: row.status,
    offerExpiresAt: row.offer_expires_at ? new Date(row.offer_expires_at) : null,
    offeredAppointmentId: row.offered_appointment_id,
  };
}

export async function joinWaitlist(
  request: JoinWaitlistRequest,
): Promise<WaitlistEntry> {
  const { rows } = await getPool().query(
    `INSERT INTO waitlist_entries
       (location_id, client_id, service_ids, staff_id,
        from_date, to_date, earliest_time, latest_time)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      request.locationId,
      request.clientId,
      request.serviceIds,
      request.staffId ?? null,
      request.fromDate,
      request.toDate,
      request.earliestTime ?? null,
      request.latestTime ?? null,
    ],
  );
  return toEntry(rows[0]);
}

export interface FreedSlot {
  locationId: string;
  staffId: string;
  start: number;
  serviceIds: string[];
}

/**
 * Candidates for a freed slot, best match first.
 *
 * Ranking rewards specificity: someone who asked for this exact barber is a
 * better match than someone who said "anyone", and an earlier join time wins
 * ties so the waitlist stays fair.
 */
async function findCandidates(
  slot: FreedSlot,
  date: string,
  localTime: string,
  client?: Db,
): Promise<WaitlistEntry[]> {
  const { rows } = await db(client).query(
    `SELECT * FROM waitlist_entries
      WHERE location_id = $1
        AND status = 'active'
        AND from_date <= $2::date
        AND to_date   >= $2::date
        AND (staff_id IS NULL OR staff_id = $3)
        AND (earliest_time IS NULL OR earliest_time <= $4::time)
        AND (latest_time   IS NULL OR latest_time   >= $4::time)
        AND service_ids <@ $5::uuid[]
        AND service_ids @> $5::uuid[]
      ORDER BY (staff_id IS NOT NULL) DESC, created_at`,
    [slot.locationId, date, slot.staffId, localTime, slot.serviceIds],
  );
  return rows.map(toEntry);
}

export interface OfferResult {
  waitlistEntryId: string;
  appointmentId: string;
  expiresAt: Date;
}

/**
 * Offer a freed slot to the best waiting match.
 *
 * Holds the slot as a `pending` appointment for the offer window so the
 * client is not sent chasing a slot someone else can take out from under
 * them. Returns null when nobody matches.
 */
export async function offerFreedSlot(
  slot: FreedSlot,
  now: number = Date.now(),
  skipEntryIds: ReadonlySet<string> = new Set(),
): Promise<OfferResult | null> {
  return withTransaction(async (client) => {
    const location = await loadLocationPolicy(slot.locationId, client);
    const date = localDateOf(slot.start, location.timezone);
    const localTime = DateTime.fromMillis(slot.start, {
      zone: location.timezone,
    }).toFormat('HH:mm:ss');

    const candidates = (await findCandidates(slot, date, localTime, client)).filter(
      (c) => !skipEntryIds.has(c.id),
    );
    if (candidates.length === 0) return null;

    // Confirm the slot really is free before promising it to anyone.
    const { services, query } = await loadAvailability(
      {
        locationId: slot.locationId,
        serviceIds: slot.serviceIds,
        date,
        staffId: slot.staffId,
        now,
        includeOfflineOnly: true,
      },
      client,
    );

    const match = availableSlots(query).find(
      (s) => s.start === slot.start && s.staffId === slot.staffId,
    );
    if (!match) return null;

    for (const candidate of candidates) {
      const expiresAt = new Date(now + location.waitlistOfferTtlSeconds * 1000);

      let appointmentId: string;
      try {
        const { rows } = await client.query(
          `INSERT INTO appointments
             (location_id, staff_id, client_id, starts_at, ends_at,
              buffer_before_minutes, buffer_after_minutes,
              status, source, hold_expires_at, hold_session_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'pending','online',$8,$9)
           RETURNING id`,
          [
            slot.locationId,
            slot.staffId,
            candidate.clientId,
            new Date(match.start),
            new Date(match.end),
            services.bufferBeforeMinutes,
            services.bufferAfterMinutes,
            expiresAt,
            `waitlist:${candidate.id}`,
          ],
        );
        appointmentId = rows[0].id;
      } catch (err) {
        // Someone booked it while we were choosing; no point offering on.
        if (isSlotConflict(err)) return null;
        throw err;
      }

      for (const [index, serviceId] of slot.serviceIds.entries()) {
        const { rows: svc } = await client.query(
          `SELECT s.name, s.duration_minutes, s.price_cents,
                  ss.duration_minutes AS staff_duration, ss.price_cents AS staff_price
             FROM services s
             LEFT JOIN staff_services ss
                    ON ss.service_id = s.id AND ss.staff_id = $2
            WHERE s.id = $1`,
          [serviceId, slot.staffId],
        );
        const row = svc[0];
        await client.query(
          `INSERT INTO appointment_services
             (appointment_id, service_id, name, duration_minutes, price_cents, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            appointmentId,
            serviceId,
            row.name,
            row.staff_duration ?? row.duration_minutes,
            row.staff_price ?? row.price_cents,
            index,
          ],
        );
      }

      await client.query(
        `UPDATE waitlist_entries
            SET status = 'offered', offered_at = $2,
                offer_expires_at = $3, offered_appointment_id = $4
          WHERE id = $1`,
        [candidate.id, new Date(now), expiresAt, appointmentId],
      );

      await notifyNow(
        {
          locationId: slot.locationId,
          clientId: candidate.clientId,
          template: 'waitlist_offer',
          payload: {
            appointmentId,
            startsAt: new Date(match.start).toISOString(),
            expiresAt: expiresAt.toISOString(),
          },
          dedupeKey: `waitlist:${candidate.id}:offer:${match.start}`,
          urgent: true,
          appointmentId,
          waitlistEntryId: candidate.id,
          now,
        },
        client,
      );

      await emitWaitlistOffered(
        {
          locationId: slot.locationId,
          waitlistEntryId: candidate.id,
          clientId: candidate.clientId,
          appointmentId,
          startsAt: new Date(match.start).toISOString(),
          expiresAt: expiresAt.toISOString(),
        },
        client,
      );

      return { waitlistEntryId: candidate.id, appointmentId, expiresAt };
    }

    return null;
  });
}

/** Accept an outstanding offer, converting the held slot into a booking. */
export async function acceptOffer(
  waitlistEntryId: string,
  now: number = Date.now(),
): Promise<{ appointmentId: string }> {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM waitlist_entries WHERE id = $1 FOR UPDATE`,
      [waitlistEntryId],
    );
    const entry = rows[0];
    if (!entry) throw new BookingError('NOT_FOUND', 'Waitlist entry not found');
    if (entry.status !== 'offered') {
      throw new BookingError('INVALID_STATE', 'There is no offer to accept');
    }
    if (new Date(entry.offer_expires_at).getTime() <= now) {
      throw new BookingError('HOLD_EXPIRED', 'This offer has expired');
    }

    await client.query(
      `UPDATE appointments
          SET status = 'confirmed', hold_expires_at = NULL, hold_session_id = NULL
        WHERE id = $1 AND status = 'pending'`,
      [entry.offered_appointment_id],
    );

    await client.query(
      `UPDATE waitlist_entries SET status = 'accepted' WHERE id = $1`,
      [waitlistEntryId],
    );

    await emitWaitlistResolved(
      {
        locationId: entry.location_id,
        waitlistEntryId,
        clientId: entry.client_id,
        outcome: 'accepted',
      },
      client,
    );

    return { appointmentId: entry.offered_appointment_id };
  });
}

/**
 * Expire offers nobody accepted and cascade each slot to the next match.
 *
 * Run on a timer. Returns the offers that were re-offered, so a caller can
 * see the cascade working.
 */
export async function expireAndCascadeOffers(
  now: number = Date.now(),
): Promise<Array<{ expiredEntryId: string; reoffered: OfferResult | null }>> {
  const { rows: expired } = await getPool().query(
    `SELECT w.id, w.offered_appointment_id, w.location_id, w.client_id,
            w.service_ids, a.staff_id, a.starts_at
       FROM waitlist_entries w
       JOIN appointments a ON a.id = w.offered_appointment_id
      WHERE w.status = 'offered' AND w.offer_expires_at <= $1`,
    [new Date(now)],
  );

  const results: Array<{ expiredEntryId: string; reoffered: OfferResult | null }> = [];

  for (const row of expired) {
    await withTransaction(async (client) => {
      // Release the held slot, then mark the offer expired.
      await client.query(
        `UPDATE appointments
            SET status = 'cancelled', cancelled_at = $2,
                cancellation_reason = 'waitlist offer expired',
                hold_expires_at = NULL, hold_session_id = NULL
          WHERE id = $1 AND status = 'pending'`,
        [row.offered_appointment_id, new Date(now)],
      );
      await client.query(
        `UPDATE waitlist_entries SET status = 'expired' WHERE id = $1`,
        [row.id],
      );
      await emitWaitlistResolved(
        {
          locationId: row.location_id,
          waitlistEntryId: row.id,
          clientId: row.client_id,
          outcome: 'expired',
        },
        client,
      );
    });

    // Cascade: the same slot goes to the next best match, skipping whoever
    // just let it lapse.
    const reoffered = await offerFreedSlot(
      {
        locationId: row.location_id,
        staffId: row.staff_id,
        start: new Date(row.starts_at).getTime(),
        serviceIds: row.service_ids,
      },
      now,
      new Set([row.id]),
    );

    results.push({ expiredEntryId: row.id, reoffered });
  }

  return results;
}

export async function cancelWaitlistEntry(id: string): Promise<void> {
  await getPool().query(
    `UPDATE waitlist_entries SET status = 'cancelled'
      WHERE id = $1 AND status IN ('active','offered')`,
    [id],
  );
}
