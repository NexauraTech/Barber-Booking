/**
 * Notification outbox.
 *
 * Messages become rows before they become sends. A crashed worker retries
 * instead of silently dropping a reminder, a cancelled appointment withdraws
 * its unsent reminders, and the whole thing is idempotent through
 * `dedupe_key` — re-running the scheduler for an appointment cannot produce a
 * second copy of the same message.
 *
 * Delivery itself (Twilio, WhatsApp Business API, FCM/APNs) is deliberately
 * not implemented here: `claimDue` hands a worker the rows to send and
 * `markSent`/`markFailed` record the outcome, so the transport is a plug.
 */
import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../db/pool.js';
import type { NotificationChannel } from '../domain/channels.js';

type Db = Pick<PoolClient, 'query'>;

const db = (client?: Db): Db => client ?? getPool();

export interface EnqueueRequest {
  locationId: string;
  clientId?: string | null;
  staffId?: string | null;
  address: string;
  channel: NotificationChannel;
  template: string;
  payload?: Record<string, unknown>;
  scheduledFor: Date | number;
  dedupeKey: string;
  appointmentId?: string | null;
  queueEntryId?: string | null;
  waitlistEntryId?: string | null;
}

export interface QueuedNotification {
  id: string;
  channel: NotificationChannel;
  address: string;
  template: string;
  payload: Record<string, unknown>;
  scheduledFor: Date;
  attempts: number;
}

/**
 * Queue a message. Re-enqueuing the same `dedupeKey` is a no-op and returns
 * the existing row, which is what makes reminder scheduling safe to retry.
 */
export async function enqueue(
  request: EnqueueRequest,
  client?: Db,
): Promise<QueuedNotification> {
  const scheduledFor =
    request.scheduledFor instanceof Date
      ? request.scheduledFor
      : new Date(request.scheduledFor);

  const { rows } = await db(client).query(
    `INSERT INTO notifications
       (location_id, client_id, staff_id, address, channel, template, payload,
        scheduled_for, dedupe_key, appointment_id, queue_entry_id, waitlist_entry_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (dedupe_key) DO UPDATE
        SET dedupe_key = EXCLUDED.dedupe_key   -- no-op, so RETURNING yields the row
     RETURNING id, channel, address, template, payload, scheduled_for, attempts`,
    [
      request.locationId,
      request.clientId ?? null,
      request.staffId ?? null,
      request.address,
      request.channel,
      request.template,
      JSON.stringify(request.payload ?? {}),
      scheduledFor,
      request.dedupeKey,
      request.appointmentId ?? null,
      request.queueEntryId ?? null,
      request.waitlistEntryId ?? null,
    ],
  );

  const row = rows[0];
  return {
    id: row.id,
    channel: row.channel,
    address: row.address,
    template: row.template,
    payload: row.payload,
    scheduledFor: new Date(row.scheduled_for),
    attempts: row.attempts,
  };
}

/** How long a claimed message stays leased before another worker may retry it. */
export const DEFAULT_LEASE_SECONDS = 300;

/**
 * Claim messages due for sending.
 *
 * Two mechanisms, and both are needed. `FOR UPDATE SKIP LOCKED` stops two
 * workers grabbing the same row in the same instant. The `claimed_at` lease
 * stops a worker that claimed, committed and then died from having its
 * message re-sent by the next poll — the lock is gone by then, but the lease
 * is not.
 */
export async function claimDue(
  now: Date = new Date(),
  limit = 100,
  leaseSeconds = DEFAULT_LEASE_SECONDS,
): Promise<QueuedNotification[]> {
  const leaseCutoff = new Date(now.getTime() - leaseSeconds * 1000);

  const { rows } = await getPool().query(
    `UPDATE notifications
        SET attempts = attempts + 1, claimed_at = $1
      WHERE id IN (
            SELECT id FROM notifications
             WHERE status = 'scheduled'
               AND scheduled_for <= $1
               AND (claimed_at IS NULL OR claimed_at <= $2)
             ORDER BY scheduled_for
             LIMIT $3
             FOR UPDATE SKIP LOCKED
          )
    RETURNING id, channel, address, template, payload, scheduled_for, attempts`,
    [now, leaseCutoff, limit],
  );

  return rows.map((row) => ({
    id: row.id,
    channel: row.channel,
    address: row.address,
    template: row.template,
    payload: row.payload,
    scheduledFor: new Date(row.scheduled_for),
    attempts: row.attempts,
  }));
}

export async function markSent(id: string, at: Date = new Date()): Promise<void> {
  await getPool().query(
    `UPDATE notifications SET status = 'sent', sent_at = $2 WHERE id = $1`,
    [id, at],
  );
}

/**
 * Record a failed send.
 *
 * Below `maxAttempts` the message goes back on the queue with a linear
 * backoff and its lease released, so it retries soon but not in a tight loop.
 * At the limit it is parked as failed rather than retried forever.
 */
export async function markFailed(
  id: string,
  error: string,
  maxAttempts = 5,
  at: Date = new Date(),
): Promise<'retrying' | 'failed'> {
  const { rows } = await getPool().query(
    `UPDATE notifications
        SET status = CASE WHEN attempts >= $3 THEN 'failed'::notification_status
                          ELSE 'scheduled'::notification_status END,
            failed_at = CASE WHEN attempts >= $3 THEN $4::timestamptz END,
            -- Release the lease so the retry is not held up by it, and push
            -- the next attempt out by a minute per failure.
            claimed_at = NULL,
            scheduled_for = CASE
                WHEN attempts >= $3 THEN scheduled_for
                ELSE $4::timestamptz + make_interval(mins => attempts)
            END,
            last_error = $2
      WHERE id = $1
    RETURNING status`,
    [id, error, maxAttempts, at],
  );
  return rows[0]?.status === 'failed' ? 'failed' : 'retrying';
}

/**
 * Withdraw unsent messages for an appointment.
 *
 * Reminding someone about an appointment they already cancelled is the kind
 * of small betrayal that loses a client, so cancellation must reach into the
 * outbox rather than only the calendar.
 */
export async function cancelForAppointment(
  appointmentId: string,
  client?: Db,
): Promise<number> {
  const { rowCount } = await db(client).query(
    `UPDATE notifications
        SET status = 'cancelled'
      WHERE appointment_id = $1 AND status = 'scheduled'`,
    [appointmentId],
  );
  return rowCount ?? 0;
}

export async function cancelForQueueEntry(
  queueEntryId: string,
  client?: Db,
): Promise<number> {
  const { rowCount } = await db(client).query(
    `UPDATE notifications
        SET status = 'cancelled'
      WHERE queue_entry_id = $1 AND status = 'scheduled'`,
    [queueEntryId],
  );
  return rowCount ?? 0;
}

/** Messages queued for an appointment, for tests and the barber app timeline. */
export async function listForAppointment(
  appointmentId: string,
): Promise<Array<{ template: string; status: string; scheduledFor: Date }>> {
  const { rows } = await getPool().query(
    `SELECT template, status, scheduled_for FROM notifications
      WHERE appointment_id = $1 ORDER BY scheduled_for`,
    [appointmentId],
  );
  return rows.map((r) => ({
    template: r.template,
    status: r.status,
    scheduledFor: new Date(r.scheduled_for),
  }));
}
