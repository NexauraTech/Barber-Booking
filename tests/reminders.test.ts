import { describe, expect, it } from 'vitest';
import { deferPastQuietHours, planReminders } from '../src/domain/reminders.js';
import { chooseChannel } from '../src/domain/channels.js';

const HOUR = 3_600_000;
const START = 1_800_000_000_000;

const plan = (now: number, over: Partial<Parameters<typeof planReminders>[0]> = {}) =>
  planReminders({
    appointmentId: 'appt-1',
    appointmentStart: START,
    now,
    channel: 'sms',
    cancellationWindowHours: 24,
    ...over,
  });

describe('planReminders', () => {
  it('schedules the full ladder for a booking made well ahead', () => {
    const plans = plan(START - 7 * 24 * HOUR);
    expect(plans.map((p) => p.template)).toEqual([
      'reminder_48h',
      'reminder_24h',
      'reminder_2h',
    ]);
  });

  it('places each reminder the right distance before the appointment', () => {
    const plans = plan(START - 7 * 24 * HOUR);
    expect(plans[0]!.sendAt).toBe(START - 48 * HOUR);
    expect(plans[1]!.sendAt).toBe(START - 24 * HOUR);
    expect(plans[2]!.sendAt).toBe(START - 2 * HOUR);
  });

  it('skips rungs already in the past for a same-week booking', () => {
    const plans = plan(START - 30 * HOUR);
    expect(plans.map((p) => p.template)).toEqual(['reminder_24h', 'reminder_2h']);
  });

  it('sends one nudge, not three, for a same-day booking', () => {
    const plans = plan(START - 5 * HOUR);
    expect(plans.map((p) => p.template)).toEqual(['reminder_2h']);
  });

  it('schedules nothing for a booking made inside the last rung', () => {
    expect(plan(START - 30 * 60_000)).toEqual([]);
  });

  it('marks which reminders still allow a free cancellation', () => {
    const plans = plan(START - 7 * 24 * HOUR);
    expect(plans.find((p) => p.template === 'reminder_48h')!.cancellationStillFree).toBe(true);
    expect(plans.find((p) => p.template === 'reminder_24h')!.cancellationStillFree).toBe(true);
    expect(plans.find((p) => p.template === 'reminder_2h')!.cancellationStillFree).toBe(false);
  });

  it('tracks a tighter cancellation window', () => {
    const plans = plan(START - 7 * 24 * HOUR, { cancellationWindowHours: 2 });
    expect(plans.every((p) => p.cancellationStillFree)).toBe(true);
  });

  it('gives every rung a stable dedupe key', () => {
    const first = plan(START - 7 * 24 * HOUR);
    const second = plan(START - 7 * 24 * HOUR);
    expect(first.map((p) => p.dedupeKey)).toEqual(second.map((p) => p.dedupeKey));
    expect(new Set(first.map((p) => p.dedupeKey)).size).toBe(3);
  });
});

describe('deferPastQuietHours', () => {
  const at = (hour: number) => hour * 60;

  it('leaves a daytime message alone', () => {
    expect(deferPastQuietHours(START, at(14), at(22), at(8))).toBe(START);
  });

  it('holds a message sent inside overnight quiet hours', () => {
    // 03:00 with quiet hours 22:00-08:00 waits five hours.
    expect(deferPastQuietHours(START, at(3), at(22), at(8))).toBe(START + 5 * HOUR);
  });

  it('holds a message sent just after quiet hours begin', () => {
    // 23:00 waits nine hours until 08:00.
    expect(deferPastQuietHours(START, at(23), at(22), at(8))).toBe(START + 9 * HOUR);
  });

  it('handles a non-wrapping quiet window', () => {
    // Quiet 13:00-14:00; a 13:30 message waits 30 minutes.
    expect(deferPastQuietHours(START, at(13) + 30, at(13), at(14))).toBe(START + 30 * 60_000);
  });

  it('does nothing when quiet hours are unset', () => {
    expect(deferPastQuietHours(START, at(3), null, null)).toBe(START);
    expect(deferPastQuietHours(START, at(3), at(22), null)).toBe(START);
  });

  it('does nothing for a zero-length window', () => {
    expect(deferPastQuietHours(START, at(3), at(8), at(8))).toBe(START);
  });

  it('releases exactly at the boundary', () => {
    expect(deferPastQuietHours(START, at(8), at(22), at(8))).toBe(START);
  });
});

describe('chooseChannel', () => {
  const base = {
    phone: '+447700900100',
    locationPreferred: 'sms' as const,
  };

  it('prefers push when a device token exists', () => {
    const choice = chooseChannel({ ...base, pushToken: 'token-1' });
    expect(choice!.channel).toBe('push');
    expect(choice!.fallbacks[0]!.channel).toBe('sms');
  });

  it('falls back to the market default with no push token', () => {
    expect(chooseChannel(base)!.channel).toBe('sms');
  });

  it("uses WhatsApp where that is the shop's market default", () => {
    const choice = chooseChannel({ ...base, locationPreferred: 'whatsapp' });
    expect(choice!.channel).toBe('whatsapp');
  });

  it("honours the client's explicit preference over push", () => {
    const choice = chooseChannel({
      ...base,
      pushToken: 'token-1',
      clientPreferred: 'whatsapp',
    });
    expect(choice!.channel).toBe('whatsapp');
  });

  it('skips push for urgent messages', () => {
    // A call-up sitting in a killed app's tray is worse than useless.
    const choice = chooseChannel({ ...base, pushToken: 'token-1' }, { urgent: true });
    expect(choice!.channel).toBe('sms');
  });

  it('returns nothing when the client opted out of transactional messages', () => {
    expect(chooseChannel({ ...base, transactionalOptIn: false })).toBeNull();
  });

  it('requires separate consent for marketing', () => {
    expect(chooseChannel(base, { marketing: true })).toBeNull();
    expect(
      chooseChannel({ ...base, marketingOptIn: true }, { marketing: true })!.channel,
    ).toBe('sms');
  });

  it('returns nothing when there is no usable address', () => {
    expect(chooseChannel({ locationPreferred: 'sms' })).toBeNull();
  });

  it('falls back to email when only an email exists', () => {
    const choice = chooseChannel({ email: 'a@example.com', locationPreferred: 'sms' });
    expect(choice!.channel).toBe('email');
  });

  it('lists each channel once in the fallback chain', () => {
    const choice = chooseChannel({
      ...base,
      pushToken: 'token-1',
      email: 'a@example.com',
    });
    const all = [choice!.channel, ...choice!.fallbacks.map((f) => f.channel)];
    expect(new Set(all).size).toBe(all.length);
  });
});
