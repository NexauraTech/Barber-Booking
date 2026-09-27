/**
 * Database-backed waitlist and no-show economics.
 *
 * These are the behaviours the product is sold on: a cancellation becomes
 * someone else's appointment within minutes, deposits fall on strangers
 * rather than regulars, and fees are raised automatically but always
 * waivable.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../src/db/pool.js';
import { confirmAppointment, holdSlot, markNoShow } from '../src/booking/commands.js';
import { cancelAndRefill } from '../src/booking/cancel-and-refill.js';
import { listPayments, waiveFee } from '../src/booking/policy-service.js';
import {
  acceptOffer,
  cancelWaitlistEntry,
  expireAndCascadeOffers,
  joinWaitlist,
  offerFreedSlot,
} from '../src/waitlist/service.js';
import { listForAppointment } from '../src/notifications/outbox.js';
import { createFixture, resetDatabase, type Fixture } from './helpers/fixture.js';
import { resolveInstant } from '../src/domain/localtime.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const d = HAS_DB ? describe : describe.skip;

const DAY = '2026-10-01';
const TZ = 'Europe/London';
const t = (time: string) => resolveInstant(DAY, time, TZ);
const DAY_BEFORE = resolveInstant('2026-09-29', '09:00', TZ);

let fx: Fixture;

/** Book and confirm a slot for a client. */
async function book(
  clientId: string,
  time: string,
  staffId: string,
  now = DAY_BEFORE,
  key = `k-${Math.random()}`,
) {
  const held = await holdSlot({
    locationId: fx.locationId,
    serviceIds: [fx.cutId],
    clientId,
    start: t(time),
    staffId,
    sessionId: `s-${key}`,
    now,
  });
  await confirmAppointment({
    appointmentId: held.id,
    sessionId: `s-${key}`,
    idempotencyKey: key,
    now,
  });
  return held;
}

d('waitlist and no-show economics', () => {
  beforeEach(async () => {
    await resetDatabase();
    fx = await createFixture();
  });

  afterAll(async () => {
    await closePool();
  });

  describe('deposits', () => {
    it('asks a first-time client for a deposit', async () => {
      await getPool().query(
        `UPDATE services SET deposit_policy = '{"kind":"percent","percent":25}'::jsonb
          WHERE id = $1`,
        [fx.cutId],
      );

      const held = await book(fx.clientA, '10:00', fx.samId);
      const payments = await listPayments(held.id);

      // Sam's haircut is £45; 25% is £11.25.
      expect(payments).toHaveLength(1);
      expect(payments[0]).toMatchObject({ kind: 'deposit', amountCents: 1125 });
    });

    it('does not ask a returning client for a deposit', async () => {
      await getPool().query(
        `UPDATE services SET deposit_policy = '{"kind":"percent","percent":25}'::jsonb
          WHERE id = $1`,
        [fx.cutId],
      );

      // A completed visit makes them a known regular.
      const first = await book(fx.clientA, '10:00', fx.samId, DAY_BEFORE, 'k1');
      await getPool().query(
        `UPDATE appointments SET status = 'completed' WHERE id = $1`,
        [first.id],
      );

      const second = await book(fx.clientA, '11:00', fx.samId, DAY_BEFORE, 'k2');
      expect(await listPayments(second.id)).toEqual([]);
    });

    it('asks a client with a no-show history for a deposit', async () => {
      await getPool().query(
        `UPDATE services SET deposit_policy = '{"kind":"fixed","amountCents":1000}'::jsonb
          WHERE id = $1`,
        [fx.cutId],
      );
      // Known client, but has previously failed to turn up.
      await getPool().query(
        `UPDATE clients SET no_show_count = 2 WHERE id = $1`,
        [fx.clientA],
      );
      await getPool().query(
        `INSERT INTO appointments (location_id, staff_id, client_id, starts_at, ends_at, status)
         VALUES ($1,$2,$3,$4,$5,'completed')`,
        [fx.locationId, fx.samId, fx.clientA, new Date(t('08:00')), new Date(t('08:30'))],
      );

      const held = await book(fx.clientA, '10:00', fx.samId);
      const payments = await listPayments(held.id);
      expect(payments[0]).toMatchObject({ kind: 'deposit', amountCents: 1000 });
    });

    it('takes no deposit when the shop has them switched off', async () => {
      await getPool().query(
        `UPDATE locations SET deposit_applies_to = 'never' WHERE id = $1`,
        [fx.locationId],
      );
      await getPool().query(
        `UPDATE services SET deposit_policy = '{"kind":"percent","percent":50}'::jsonb
          WHERE id = $1`,
        [fx.cutId],
      );

      const held = await book(fx.clientA, '10:00', fx.samId);
      expect(await listPayments(held.id)).toEqual([]);
    });

    it('freezes the policy onto the appointment', async () => {
      const held = await book(fx.clientA, '10:00', fx.samId);

      const { rows } = await getPool().query(
        `SELECT policy_snapshot FROM appointments WHERE id = $1`,
        [held.id],
      );
      expect(rows[0].policy_snapshot).toMatchObject({
        version: 1,
        cancellationWindowHours: 24,
        lateCancelFeePercent: 50,
        serviceTotalCents: 4500,
      });
    });

    it('judges a later cancellation by the frozen policy, not the current one', async () => {
      const held = await book(fx.clientA, '10:00', fx.samId);

      // Shop tightens its policy after the booking was made.
      await getPool().query(
        `UPDATE locations SET cancellation_window_hours = 72, late_cancel_fee_percent = 100
          WHERE id = $1`,
        [fx.locationId],
      );

      // 48 hours' notice: free under the accepted 24h policy.
      const result = await cancelAndRefill({
        appointmentId: held.id,
        now: t('10:00') - 48 * 3_600_000,
      });
      expect(result.feeCents).toBe(0);
    });
  });

  describe('reminders', () => {
    it('queues the ladder on confirmation', async () => {
      const held = await book(fx.clientA, '10:00', fx.samId, resolveInstant('2026-09-27', '09:00', TZ));
      const messages = await listForAppointment(held.id);

      expect(messages.map((m) => m.template)).toEqual([
        'reminder_48h',
        'reminder_24h',
        'reminder_2h',
      ]);
      expect(messages.every((m) => m.status === 'scheduled')).toBe(true);
    });

    it('withdraws unsent reminders when the booking is cancelled', async () => {
      const held = await book(fx.clientA, '10:00', fx.samId, resolveInstant('2026-09-27', '09:00', TZ));
      await cancelAndRefill({ appointmentId: held.id, now: DAY_BEFORE });

      const messages = await listForAppointment(held.id);
      expect(messages.every((m) => m.status === 'cancelled')).toBe(true);
    });

    it('does not double-queue reminders on a retried confirmation', async () => {
      const held = await holdSlot({
        locationId: fx.locationId, serviceIds: [fx.cutId], clientId: fx.clientA,
        start: t('10:00'), staffId: fx.samId, sessionId: 's', now: DAY_BEFORE,
      });
      await confirmAppointment({
        appointmentId: held.id, sessionId: 's', idempotencyKey: 'k', now: DAY_BEFORE,
      });
      await confirmAppointment({
        appointmentId: held.id, sessionId: 's', idempotencyKey: 'k', now: DAY_BEFORE,
      });

      // Booked 49 hours out, so all three rungs apply — and confirming twice
      // must not produce six.
      const messages = await listForAppointment(held.id);
      expect(messages).toHaveLength(3);
      expect(new Set(messages.map((m) => m.template)).size).toBe(3);
    });
  });

  describe('cancellation fees', () => {
    it('charges nothing outside the notice window', async () => {
      const held = await book(fx.clientA, '10:00', fx.samId);
      const result = await cancelAndRefill({
        appointmentId: held.id,
        now: t('10:00') - 48 * 3_600_000,
      });
      expect(result.feeCents).toBe(0);
    });

    it('charges the late percentage inside the window', async () => {
      const held = await book(fx.clientA, '10:00', fx.samId);
      const result = await cancelAndRefill({
        appointmentId: held.id,
        now: t('08:00'),
      });
      expect(result.feeCents).toBe(2250); // 50% of £45
    });

    it('counts a late cancellation against the client', async () => {
      const held = await book(fx.clientA, '10:00', fx.samId);
      await cancelAndRefill({ appointmentId: held.id, now: t('08:00') });

      const { rows } = await getPool().query(
        `SELECT late_cancel_count FROM clients WHERE id = $1`,
        [fx.clientA],
      );
      expect(rows[0].late_cancel_count).toBe(1);
    });
  });

  describe('no-show fees', () => {
    it('raises the fee automatically', async () => {
      const held = await book(fx.clientA, '10:00', fx.samId);
      const result = await markNoShow(held.id);

      expect(result.feeCents).toBe(4500); // 100% of £45
      expect(result.feePaymentId).not.toBeNull();
    });

    it('credits a deposit already taken', async () => {
      await getPool().query(
        `UPDATE services SET deposit_policy = '{"kind":"percent","percent":25}'::jsonb
          WHERE id = $1`,
        [fx.cutId],
      );
      const held = await book(fx.clientA, '10:00', fx.samId);
      const result = await markNoShow(held.id);

      // £45 fee less the £11.25 deposit already held.
      expect(result.feeCents).toBe(3375);
    });

    it('lets a barber waive the fee, keeping the record', async () => {
      const held = await book(fx.clientA, '10:00', fx.samId);
      const result = await markNoShow(held.id);

      await waiveFee(result.feePaymentId!, null, 'regular client, car broke down');

      const payments = await listPayments(held.id);
      const fee = payments.find((p) => p.kind === 'no_show_fee')!;
      expect(fee.status).toBe('waived');

      const { rows } = await getPool().query(
        `SELECT waived_reason FROM payments WHERE id = $1`,
        [result.feePaymentId],
      );
      expect(rows[0].waived_reason).toContain('car broke down');
    });

    it('does not raise a second fee if marked twice', async () => {
      const held = await book(fx.clientA, '10:00', fx.samId);
      await markNoShow(held.id);
      await expect(markNoShow(held.id)).rejects.toMatchObject({ code: 'INVALID_STATE' });

      const fees = (await listPayments(held.id)).filter((p) => p.kind === 'no_show_fee');
      expect(fees).toHaveLength(1);
    });
  });

  describe('waitlist matching', () => {
    const waitFor = (clientId: string, staffId: string | null = null) =>
      joinWaitlist({
        locationId: fx.locationId,
        clientId,
        serviceIds: [fx.cutId],
        staffId,
        fromDate: DAY,
        toDate: DAY,
      });

    it('offers a freed slot to a waiting client', async () => {
      const booked = await book(fx.clientA, '10:00', fx.samId);
      await waitFor(fx.clientB);

      const result = await cancelAndRefill({ appointmentId: booked.id, now: DAY_BEFORE });

      expect(result.offer).not.toBeNull();
      const { rows } = await getPool().query(
        `SELECT client_id, status, starts_at FROM appointments WHERE id = $1`,
        [result.offer!.appointmentId],
      );
      expect(rows[0].client_id).toBe(fx.clientB);
      expect(rows[0].status).toBe('pending');
    });

    it('holds the slot so nobody can book underneath the offer', async () => {
      const booked = await book(fx.clientA, '10:00', fx.samId);
      await waitFor(fx.clientB);
      await cancelAndRefill({ appointmentId: booked.id, now: DAY_BEFORE });

      // A third party tries for the same slot while the offer stands.
      const { rows } = await getPool().query(
        `INSERT INTO clients (org_id, name, phone) VALUES ($1,'Interloper','+447700900900')
         RETURNING id`,
        [fx.orgId],
      );
      await expect(
        holdSlot({
          locationId: fx.locationId, serviceIds: [fx.cutId], clientId: rows[0].id,
          start: t('10:00'), staffId: fx.samId, sessionId: 'x', now: DAY_BEFORE,
        }),
      ).rejects.toMatchObject({ code: 'SLOT_TAKEN' });
    });

    it('notifies the offered client', async () => {
      const booked = await book(fx.clientA, '10:00', fx.samId);
      await waitFor(fx.clientB);
      const result = await cancelAndRefill({ appointmentId: booked.id, now: DAY_BEFORE });

      const { rows } = await getPool().query(
        `SELECT template, status FROM notifications WHERE waitlist_entry_id = $1`,
        [result.offer!.waitlistEntryId],
      );
      expect(rows[0]).toMatchObject({ template: 'waitlist_offer', status: 'scheduled' });
    });

    it('prefers someone who asked for that specific barber', async () => {
      const booked = await book(fx.clientA, '10:00', fx.samId);
      await waitFor(fx.clientB); // any barber
      const { rows } = await getPool().query(
        `INSERT INTO clients (org_id, name, phone) VALUES ($1,'Picky','+447700900901')
         RETURNING id`,
        [fx.orgId],
      );
      await waitFor(rows[0].id, fx.samId); // specifically Sam

      const result = await cancelAndRefill({ appointmentId: booked.id, now: DAY_BEFORE });

      const { rows: appt } = await getPool().query(
        `SELECT client_id FROM appointments WHERE id = $1`,
        [result.offer!.appointmentId],
      );
      expect(appt[0].client_id).toBe(rows[0].id);
    });

    it('skips a client whose date window does not cover the slot', async () => {
      const booked = await book(fx.clientA, '10:00', fx.samId);
      await joinWaitlist({
        locationId: fx.locationId, clientId: fx.clientB, serviceIds: [fx.cutId],
        fromDate: '2026-10-05', toDate: '2026-10-09',
      });

      const result = await cancelAndRefill({ appointmentId: booked.id, now: DAY_BEFORE });
      expect(result.offer).toBeNull();
    });

    it('skips a client whose time-of-day window excludes the slot', async () => {
      const booked = await book(fx.clientA, '10:00', fx.samId);
      await joinWaitlist({
        locationId: fx.locationId, clientId: fx.clientB, serviceIds: [fx.cutId],
        fromDate: DAY, toDate: DAY,
        earliestTime: '14:00', latestTime: '17:00',
      });

      const result = await cancelAndRefill({ appointmentId: booked.id, now: DAY_BEFORE });
      expect(result.offer).toBeNull();
    });

    it('skips a client who asked for a different service', async () => {
      const booked = await book(fx.clientA, '10:00', fx.samId);
      await joinWaitlist({
        locationId: fx.locationId, clientId: fx.clientB, serviceIds: [fx.beardId],
        fromDate: DAY, toDate: DAY,
      });

      const result = await cancelAndRefill({ appointmentId: booked.id, now: DAY_BEFORE });
      expect(result.offer).toBeNull();
    });

    it('cancels cleanly when nobody is waiting', async () => {
      const booked = await book(fx.clientA, '10:00', fx.samId);
      const result = await cancelAndRefill({ appointmentId: booked.id, now: DAY_BEFORE });

      expect(result.offer).toBeNull();
      const { rows } = await getPool().query(
        `SELECT status FROM appointments WHERE id = $1`,
        [booked.id],
      );
      expect(rows[0].status).toBe('cancelled');
    });

    it('ignores a withdrawn waitlist entry', async () => {
      const booked = await book(fx.clientA, '10:00', fx.samId);
      const entry = await waitFor(fx.clientB);
      await cancelWaitlistEntry(entry.id);

      const result = await cancelAndRefill({ appointmentId: booked.id, now: DAY_BEFORE });
      expect(result.offer).toBeNull();
    });
  });

  describe('accepting and cascading offers', () => {
    it('turns an accepted offer into a confirmed booking', async () => {
      const booked = await book(fx.clientA, '10:00', fx.samId);
      await joinWaitlist({
        locationId: fx.locationId, clientId: fx.clientB, serviceIds: [fx.cutId],
        fromDate: DAY, toDate: DAY,
      });
      const result = await cancelAndRefill({ appointmentId: booked.id, now: DAY_BEFORE });

      const accepted = await acceptOffer(result.offer!.waitlistEntryId, DAY_BEFORE);

      const { rows } = await getPool().query(
        `SELECT status, client_id, hold_expires_at FROM appointments WHERE id = $1`,
        [accepted.appointmentId],
      );
      expect(rows[0]).toMatchObject({ status: 'confirmed', client_id: fx.clientB });
      expect(rows[0].hold_expires_at).toBeNull();
    });

    it('refuses an offer that has already expired', async () => {
      const booked = await book(fx.clientA, '10:00', fx.samId);
      await joinWaitlist({
        locationId: fx.locationId, clientId: fx.clientB, serviceIds: [fx.cutId],
        fromDate: DAY, toDate: DAY,
      });
      const result = await cancelAndRefill({ appointmentId: booked.id, now: DAY_BEFORE });

      await expect(
        acceptOffer(result.offer!.waitlistEntryId, result.offer!.expiresAt.getTime() + 1000),
      ).rejects.toMatchObject({ code: 'HOLD_EXPIRED' });
    });

    it('cascades an unaccepted offer to the next match', async () => {
      const booked = await book(fx.clientA, '10:00', fx.samId);

      const first = await joinWaitlist({
        locationId: fx.locationId, clientId: fx.clientB, serviceIds: [fx.cutId],
        fromDate: DAY, toDate: DAY,
      });
      const { rows } = await getPool().query(
        `INSERT INTO clients (org_id, name, phone) VALUES ($1,'Next Up','+447700900902')
         RETURNING id`,
        [fx.orgId],
      );
      await joinWaitlist({
        locationId: fx.locationId, clientId: rows[0].id, serviceIds: [fx.cutId],
        fromDate: DAY, toDate: DAY,
      });

      const result = await cancelAndRefill({ appointmentId: booked.id, now: DAY_BEFORE });
      expect(result.offer!.waitlistEntryId).toBe(first.id);

      // Nobody accepted; the offer lapses and moves on.
      const cascade = await expireAndCascadeOffers(
        result.offer!.expiresAt.getTime() + 1000,
      );

      expect(cascade).toHaveLength(1);
      expect(cascade[0]!.expiredEntryId).toBe(first.id);
      expect(cascade[0]!.reoffered).not.toBeNull();

      const { rows: appt } = await getPool().query(
        `SELECT client_id FROM appointments WHERE id = $1`,
        [cascade[0]!.reoffered!.appointmentId],
      );
      expect(appt[0].client_id).toBe(rows[0].id);
    });

    it('releases the slot when the last offer lapses', async () => {
      const booked = await book(fx.clientA, '10:00', fx.samId);
      await joinWaitlist({
        locationId: fx.locationId, clientId: fx.clientB, serviceIds: [fx.cutId],
        fromDate: DAY, toDate: DAY,
      });
      const result = await cancelAndRefill({ appointmentId: booked.id, now: DAY_BEFORE });

      await expireAndCascadeOffers(result.offer!.expiresAt.getTime() + 1000);

      // With nobody left waiting, the slot goes back on sale.
      const { rows } = await getPool().query(
        `SELECT status FROM appointments WHERE id = $1`,
        [result.offer!.appointmentId],
      );
      expect(rows[0].status).toBe('cancelled');

      const rebooked = await holdSlot({
        locationId: fx.locationId, serviceIds: [fx.cutId], clientId: fx.clientA,
        start: t('10:00'), staffId: fx.samId, sessionId: 'new', now: DAY_BEFORE,
      });
      expect(rebooked.id).toBeTruthy();
    });

    it('does nothing for offers that are still live', async () => {
      const booked = await book(fx.clientA, '10:00', fx.samId);
      await joinWaitlist({
        locationId: fx.locationId, clientId: fx.clientB, serviceIds: [fx.cutId],
        fromDate: DAY, toDate: DAY,
      });
      await cancelAndRefill({ appointmentId: booked.id, now: DAY_BEFORE });

      expect(await expireAndCascadeOffers(DAY_BEFORE)).toEqual([]);
    });
  });

  describe('offerFreedSlot directly', () => {
    it('declines to offer a slot that is not actually free', async () => {
      await book(fx.clientA, '10:00', fx.samId);
      await joinWaitlist({
        locationId: fx.locationId, clientId: fx.clientB, serviceIds: [fx.cutId],
        fromDate: DAY, toDate: DAY,
      });

      const offer = await offerFreedSlot(
        {
          locationId: fx.locationId,
          staffId: fx.samId,
          start: t('10:00'),
          serviceIds: [fx.cutId],
        },
        DAY_BEFORE,
      );
      expect(offer).toBeNull();
    });
  });
});
