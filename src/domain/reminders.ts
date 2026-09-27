/**
 * Reminder scheduling.
 *
 * Layered reminders at 48h, 24h and 2h (docs/research/02-scheduling-engine.md §2.8):
 * the 48h and 24h messages land while cancelling is still free or cheap, so a
 * client who cannot make it converts into a RESELLABLE slot rather than a
 * no-show. The 2h message is a pure nudge.
 *
 * Every reminder carries one-tap confirm and reschedule actions. A client who
 * cancels 24 hours out is worth far more than one who silently fails to turn
 * up, so the messaging must make cancelling easy rather than discouraging it.
 *
 * Pure: no database, no clock of its own.
 */
import type { NotificationChannel } from './channels.js';

export type ReminderTemplate = 'reminder_48h' | 'reminder_24h' | 'reminder_2h';

export interface ReminderPlan {
  readonly template: ReminderTemplate;
  readonly sendAt: number;
  /** Hours before the appointment this message represents. */
  readonly hoursBefore: number;
  /** Whether cancelling at this point is still free under the policy. */
  readonly cancellationStillFree: boolean;
  readonly channel: NotificationChannel;
  /** Stable identity, so re-running the scheduler cannot double-send. */
  readonly dedupeKey: string;
}

const LADDER: ReadonlyArray<{ template: ReminderTemplate; hoursBefore: number }> = [
  { template: 'reminder_48h', hoursBefore: 48 },
  { template: 'reminder_24h', hoursBefore: 24 },
  { template: 'reminder_2h', hoursBefore: 2 },
];

export interface ReminderOptions {
  readonly appointmentId: string;
  readonly appointmentStart: number;
  /** Now; reminders whose time has already passed are not scheduled. */
  readonly now: number;
  readonly channel: NotificationChannel;
  readonly cancellationWindowHours: number;
  /** Skip rungs closer together than this, for same-day bookings. */
  readonly minimumNoticeMinutes?: number;
}

/**
 * The reminders worth sending for one appointment.
 *
 * A booking made two hours out gets one nudge, not three that all fire at
 * once — a burst of messages for a single appointment reads as spam and
 * trains people to ignore the channel.
 */
export function planReminders(options: ReminderOptions): ReminderPlan[] {
  const {
    appointmentId,
    appointmentStart,
    now,
    channel,
    cancellationWindowHours,
  } = options;

  const minimumNotice = (options.minimumNoticeMinutes ?? 30) * 60_000;
  const plans: ReminderPlan[] = [];

  for (const rung of LADDER) {
    const sendAt = appointmentStart - rung.hoursBefore * 3_600_000;

    // Already in the past, or too close to the appointment to be useful.
    if (sendAt <= now) continue;
    if (appointmentStart - sendAt < minimumNotice) continue;

    plans.push({
      template: rung.template,
      sendAt,
      hoursBefore: rung.hoursBefore,
      cancellationStillFree: rung.hoursBefore >= cancellationWindowHours,
      channel,
      dedupeKey: `appt:${appointmentId}:${rung.template}`,
    });
  }

  return plans;
}

/**
 * Hold a non-urgent message until quiet hours end.
 *
 * Quiet hours are local wall-clock minutes-from-midnight and may wrap past
 * midnight (22:00-08:00). Urgent messages — a queue call-up, a barber
 * cancelling — bypass this entirely; they are useless late.
 */
export function deferPastQuietHours(
  sendAt: number,
  localMinutesAtSendAt: number,
  quietStartMinutes: number | null,
  quietEndMinutes: number | null,
): number {
  if (quietStartMinutes === null || quietEndMinutes === null) return sendAt;
  if (quietStartMinutes === quietEndMinutes) return sendAt;

  const wraps = quietStartMinutes > quietEndMinutes;
  const inQuiet = wraps
    ? localMinutesAtSendAt >= quietStartMinutes || localMinutesAtSendAt < quietEndMinutes
    : localMinutesAtSendAt >= quietStartMinutes && localMinutesAtSendAt < quietEndMinutes;

  if (!inQuiet) return sendAt;

  const minutesUntilEnd =
    localMinutesAtSendAt < quietEndMinutes
      ? quietEndMinutes - localMinutesAtSendAt
      : 24 * 60 - localMinutesAtSendAt + quietEndMinutes;

  return sendAt + minutesUntilEnd * 60_000;
}
