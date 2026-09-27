/**
 * Turning bookings into scheduled messages.
 *
 * Resolves the client's channel and consent, applies quiet hours to
 * non-urgent messages, and writes the reminder ladder into the outbox.
 */
import type { PoolClient } from 'pg';
import { DateTime } from 'luxon';
import { getPool } from '../db/pool.js';
import { type ChannelContext, chooseChannel } from '../domain/channels.js';
import { deferPastQuietHours, planReminders } from '../domain/reminders.js';
import { enqueue } from './outbox.js';

type Db = Pick<PoolClient, 'query'>;
const db = (client?: Db): Db => client ?? getPool();

export interface RecipientContext extends ChannelContext {
  clientId: string | null;
  timezone: string;
  quietStartMinutes: number | null;
  quietEndMinutes: number | null;
}

function toMinutes(time: string | null): number | null {
  if (!time) return null;
  const [h, m] = time.split(':');
  return Number(h) * 60 + Number(m ?? 0);
}

/** Load a client's contact details, preferences and consent. */
export async function loadRecipient(
  clientId: string,
  locationId: string,
  client?: Db,
): Promise<RecipientContext | null> {
  const { rows } = await db(client).query(
    `SELECT c.id, c.phone, c.email,
            p.preferred_channel, p.push_token, p.transactional_opt_in,
            p.marketing_opt_in, p.quiet_hours_start, p.quiet_hours_end,
            l.timezone, l.preferred_message_channel
       FROM clients c
       CROSS JOIN locations l
       LEFT JOIN client_contact_preferences p ON p.client_id = c.id
      WHERE c.id = $1 AND l.id = $2`,
    [clientId, locationId],
  );

  const row = rows[0];
  if (!row) return null;

  return {
    clientId: row.id,
    phone: row.phone,
    email: row.email,
    pushToken: row.push_token,
    clientPreferred: row.preferred_channel,
    locationPreferred: row.preferred_message_channel,
    transactionalOptIn: row.transactional_opt_in ?? true,
    marketingOptIn: row.marketing_opt_in ?? false,
    timezone: row.timezone,
    quietStartMinutes: toMinutes(row.quiet_hours_start),
    quietEndMinutes: toMinutes(row.quiet_hours_end),
  };
}

export interface ScheduleRemindersRequest {
  appointmentId: string;
  locationId: string;
  clientId: string;
  appointmentStart: number;
  cancellationWindowHours: number;
  now?: number;
}

/**
 * Queue the reminder ladder for a confirmed appointment.
 *
 * Safe to call repeatedly: each rung has a stable dedupe key, so a retry or a
 * reschedule re-run cannot double-send.
 */
export async function scheduleReminders(
  request: ScheduleRemindersRequest,
  client?: Db,
): Promise<number> {
  const recipient = await loadRecipient(request.clientId, request.locationId, client);
  if (!recipient) return 0;

  const choice = chooseChannel(recipient);
  if (!choice) return 0; // opted out of transactional messages

  const plans = planReminders({
    appointmentId: request.appointmentId,
    appointmentStart: request.appointmentStart,
    now: request.now ?? Date.now(),
    channel: choice.channel,
    cancellationWindowHours: request.cancellationWindowHours,
  });

  for (const plan of plans) {
    const localMinutes = DateTime.fromMillis(plan.sendAt, { zone: recipient.timezone })
      .set({ second: 0, millisecond: 0 })
      .diff(
        DateTime.fromMillis(plan.sendAt, { zone: recipient.timezone }).startOf('day'),
        'minutes',
      ).minutes;

    const sendAt = deferPastQuietHours(
      plan.sendAt,
      Math.round(localMinutes),
      recipient.quietStartMinutes,
      recipient.quietEndMinutes,
    );

    await enqueue(
      {
        locationId: request.locationId,
        clientId: request.clientId,
        address: choice.address,
        channel: plan.channel,
        template: plan.template,
        payload: {
          appointmentId: request.appointmentId,
          hoursBefore: plan.hoursBefore,
          cancellationStillFree: plan.cancellationStillFree,
          // Every reminder carries one-tap actions: a cancellation is a
          // resellable slot, a no-show is lost revenue.
          actions: ['confirm', 'reschedule', 'cancel'],
        },
        scheduledFor: sendAt,
        dedupeKey: plan.dedupeKey,
        appointmentId: request.appointmentId,
      },
      client,
    );
  }

  return plans.length;
}

/**
 * Send an immediate message (queue call-up, waitlist offer, cancellation
 * notice). Urgent messages bypass push-first ordering and quiet hours.
 */
export async function notifyNow(
  params: {
    locationId: string;
    clientId?: string | null;
    address?: string | null;
    template: string;
    payload?: Record<string, unknown>;
    dedupeKey: string;
    urgent?: boolean;
    appointmentId?: string | null;
    queueEntryId?: string | null;
    waitlistEntryId?: string | null;
    now?: number;
  },
  client?: Db,
): Promise<boolean> {
  let channel: 'push' | 'sms' | 'whatsapp' | 'email' = 'sms';
  let address = params.address ?? null;

  if (params.clientId) {
    const recipient = await loadRecipient(params.clientId, params.locationId, client);
    if (!recipient) return false;

    const choice = chooseChannel(recipient, { urgent: params.urgent ?? true });
    if (!choice) return false;

    channel = choice.channel;
    address = choice.address;
  }

  if (!address) return false;

  await enqueue(
    {
      locationId: params.locationId,
      clientId: params.clientId ?? null,
      address,
      channel,
      template: params.template,
      payload: params.payload ?? {},
      scheduledFor: params.now ?? Date.now(),
      dedupeKey: params.dedupeKey,
      appointmentId: params.appointmentId ?? null,
      queueEntryId: params.queueEntryId ?? null,
      waitlistEntryId: params.waitlistEntryId ?? null,
    },
    client,
  );

  return true;
}
