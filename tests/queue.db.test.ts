/**
 * Database-backed walk-in queue tests.
 *
 * The behaviours that matter: joining without an account, honest ETAs,
 * promotion into a real appointment that respects the exclusion constraint,
 * and the public status page not leaking other clients' details.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../src/db/pool.js';
import {
  abandonQueueEntry,
  bumpPriority,
  getLiveQueue,
  getPublicQueueStatus,
  joinQueue,
  notifyUpcoming,
  promoteToAppointment,
} from '../src/queue/service.js';
import { holdSlot, confirmAppointment } from '../src/booking/commands.js';
import { listForAppointment } from '../src/notifications/outbox.js';
import { createFixture, resetDatabase, type Fixture } from './helpers/fixture.js';
import { resolveInstant } from '../src/domain/localtime.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const d = HAS_DB ? describe : describe.skip;

const DAY = '2026-10-01'; // Thursday, shop open 09:00-17:00
const TZ = 'Europe/London';
const t = (time: string) => resolveInstant(DAY, time, TZ);

let fx: Fixture;

d('walk-in queue', () => {
  beforeEach(async () => {
    await resetDatabase();
    fx = await createFixture();
  });

  afterAll(async () => {
    await closePool();
  });

  describe('joining', () => {
    it('lets a guest join with no account', async () => {
      const entry = await joinQueue({
        locationId: fx.locationId,
        serviceIds: [fx.cutId],
        guestName: 'Walk-in Dave',
        guestPhone: '+447700900500',
        now: t('10:00'),
      });

      expect(entry.clientId).toBeNull();
      expect(entry.status).toBe('waiting');
      expect(entry.publicToken).toMatch(/^[0-9a-f]{32}$/);
    });

    it('lets a known client join', async () => {
      const entry = await joinQueue({
        locationId: fx.locationId,
        serviceIds: [fx.cutId],
        clientId: fx.clientA,
        now: t('10:00'),
      });
      expect(entry.clientId).toBe(fx.clientA);
    });

    it('refuses an entry with neither client nor guest details', async () => {
      await expect(
        joinQueue({ locationId: fx.locationId, serviceIds: [fx.cutId], now: t('10:00') }),
      ).rejects.toMatchObject({ code: 'NOT_BOOKABLE' });
    });

    it('refuses a service nobody at the shop performs', async () => {
      const { rows } = await getPool().query(
        `INSERT INTO services (location_id, name, duration_minutes, price_cents)
         VALUES ($1, 'Hot towel', 15, 1000) RETURNING id`,
        [fx.locationId],
      );
      await expect(
        joinQueue({
          locationId: fx.locationId,
          serviceIds: [rows[0].id],
          guestName: 'Dave',
          guestPhone: '+447700900501',
          now: t('10:00'),
        }),
      ).rejects.toMatchObject({ code: 'NO_ELIGIBLE_STAFF' });
    });
  });

  describe('live queue', () => {
    const join = (name: string, phone: string, at: string, staffId?: string) =>
      joinQueue({
        locationId: fx.locationId,
        serviceIds: [fx.cutId],
        guestName: name,
        guestPhone: phone,
        preferredStaffId: staffId ?? null,
        now: t(at),
      });

    it('orders by arrival and numbers positions from one', async () => {
      await join('First', '+447700900501', '10:00');
      await join('Second', '+447700900502', '10:05');

      const live = await getLiveQueue(fx.locationId, t('10:10'));
      expect(live.entries.map((e) => e.guestName)).toEqual(['First', 'Second']);
      expect(live.entries.map((e) => e.estimate.position)).toEqual([1, 2]);
    });

    it('seats the first two immediately when both barbers are free', async () => {
      await join('First', '+447700900501', '10:00');
      await join('Second', '+447700900502', '10:05');

      const live = await getLiveQueue(fx.locationId, t('10:10'));
      expect(live.entries[0]!.estimate.rangeStartMinutes).toBe(0);
      expect(live.entries[1]!.estimate.rangeStartMinutes).toBe(0);
    });

    it('quotes a wait once both barbers are taken', async () => {
      await join('First', '+447700900501', '10:00');
      await join('Second', '+447700900502', '10:01');
      await join('Third', '+447700900503', '10:02');

      const live = await getLiveQueue(fx.locationId, t('10:10'));
      const third = live.entries[2]!;
      expect(third.estimate.rangeEndMinutes).toBeGreaterThan(0);
      expect(live.quotedWaitMinutes).toBeGreaterThan(0);
    });

    it('respects a manual priority bump', async () => {
      await join('First', '+447700900501', '10:00');
      const second = await join('Second', '+447700900502', '10:05');
      await bumpPriority(second.id, 10);

      const live = await getLiveQueue(fx.locationId, t('10:10'));
      expect(live.entries[0]!.guestName).toBe('Second');
    });

    it('drops an abandoned entry out of the queue', async () => {
      const first = await join('First', '+447700900501', '10:00');
      await join('Second', '+447700900502', '10:05');
      await abandonQueueEntry(first.id);

      const live = await getLiveQueue(fx.locationId, t('10:10'));
      expect(live.entries.map((e) => e.guestName)).toEqual(['Second']);
      expect(live.entries[0]!.estimate.position).toBe(1);
    });

    it('refuses to abandon an entry twice', async () => {
      const entry = await join('First', '+447700900501', '10:00');
      await abandonQueueEntry(entry.id);
      await expect(abandonQueueEntry(entry.id)).rejects.toMatchObject({
        code: 'INVALID_STATE',
      });
    });

    it('makes a client wait for the barber they asked for', async () => {
      // Sam is mid-cut until 10:35; Alex is free.
      const held = await holdSlot({
        locationId: fx.locationId, serviceIds: [fx.cutId], clientId: fx.clientA,
        start: t('10:00'), staffId: fx.samId, sessionId: 's', now: t('09:00'),
      });
      await confirmAppointment({
        appointmentId: held.id, sessionId: 's', idempotencyKey: 'k', now: t('09:00'),
      });
      await getPool().query(
        `UPDATE appointments SET status = 'in_progress', started_at = $2 WHERE id = $1`,
        [held.id, new Date(t('10:00'))],
      );

      await join('Wants Sam', '+447700900501', '10:05', fx.samId);

      const live = await getLiveQueue(fx.locationId, t('10:05'));
      expect(live.entries[0]!.estimate.staffId).toBe(fx.samId);
      expect(live.entries[0]!.estimate.rangeEndMinutes).toBeGreaterThan(0);
    });
  });

  describe('public status page', () => {
    it('shows position and ETA without any account', async () => {
      const entry = await joinQueue({
        locationId: fx.locationId,
        serviceIds: [fx.cutId],
        guestName: 'Dave',
        guestPhone: '+447700900500',
        now: t('10:00'),
      });

      const status = await getPublicQueueStatus(entry.publicToken, t('10:05'));
      expect(status).toMatchObject({ status: 'waiting', position: 1 });
      expect(status!.rangeEndMinutes).not.toBeNull();
    });

    it('leaks nothing about other people in the queue', async () => {
      const mine = await joinQueue({
        locationId: fx.locationId, serviceIds: [fx.cutId],
        guestName: 'Mine', guestPhone: '+447700900500', now: t('10:00'),
      });
      await joinQueue({
        locationId: fx.locationId, serviceIds: [fx.cutId],
        guestName: 'Someone Else', guestPhone: '+447700900999', now: t('10:01'),
      });

      const status = await getPublicQueueStatus(mine.publicToken, t('10:05'));
      expect(JSON.stringify(status)).not.toContain('Someone Else');
      expect(JSON.stringify(status)).not.toContain('447700900999');
      expect(Object.keys(status!).sort()).toEqual([
        'position',
        'rangeEndMinutes',
        'rangeStartMinutes',
        'status',
      ]);
    });

    it('returns null for an unknown token', async () => {
      expect(await getPublicQueueStatus('deadbeef'.repeat(4), t('10:00'))).toBeNull();
    });
  });

  describe('call-up notifications', () => {
    it('nudges the parties near the front, once each', async () => {
      const first = await joinQueue({
        locationId: fx.locationId, serviceIds: [fx.cutId],
        guestName: 'First', guestPhone: '+447700900501', now: t('10:00'),
      });
      await joinQueue({
        locationId: fx.locationId, serviceIds: [fx.cutId],
        guestName: 'Second', guestPhone: '+447700900502', now: t('10:01'),
      });

      const notified = await notifyUpcoming(fx.locationId, t('10:05'));
      expect(notified).toContain(first.id);

      // Running again must not re-notify the same people.
      expect(await notifyUpcoming(fx.locationId, t('10:06'))).toEqual([]);

      const { rows } = await getPool().query(
        `SELECT count(*)::int AS n FROM notifications WHERE template = 'queue_nearly_up'`,
      );
      expect(rows[0].n).toBe(2);
    });

    it('marks notified entries so the barber app can show it', async () => {
      await joinQueue({
        locationId: fx.locationId, serviceIds: [fx.cutId],
        guestName: 'First', guestPhone: '+447700900501', now: t('10:00'),
      });
      await notifyUpcoming(fx.locationId, t('10:05'));

      const live = await getLiveQueue(fx.locationId, t('10:06'));
      expect(live.entries[0]!.status).toBe('notified');
    });
  });

  describe('promotion into an appointment', () => {
    it('seats a walk-in as a real in-progress appointment', async () => {
      const entry = await joinQueue({
        locationId: fx.locationId, serviceIds: [fx.cutId],
        guestName: 'Dave', guestPhone: '+447700900500', now: t('10:00'),
      });

      const result = await promoteToAppointment(entry.id, fx.samId, t('10:05'));

      const { rows } = await getPool().query(
        `SELECT status, source, staff_id, started_at FROM appointments WHERE id = $1`,
        [result.appointmentId],
      );
      expect(rows[0]).toMatchObject({ status: 'in_progress', source: 'walkin' });
      expect(rows[0].staff_id).toBe(fx.samId);
      expect(rows[0].started_at).not.toBeNull();
    });

    it('creates a client record for a guest, so history works from visit one', async () => {
      const entry = await joinQueue({
        locationId: fx.locationId, serviceIds: [fx.cutId],
        guestName: 'Dave', guestPhone: '+447700900500', now: t('10:00'),
      });
      const result = await promoteToAppointment(entry.id, fx.samId, t('10:05'));

      const { rows } = await getPool().query(
        `SELECT c.name, c.phone FROM appointments a
           JOIN clients c ON c.id = a.client_id
          WHERE a.id = $1`,
        [result.appointmentId],
      );
      expect(rows[0]).toMatchObject({ name: 'Dave', phone: '+447700900500' });
    });

    it('snapshots the services onto the appointment', async () => {
      const entry = await joinQueue({
        locationId: fx.locationId, serviceIds: [fx.cutId, fx.beardId],
        guestName: 'Dave', guestPhone: '+447700900500', now: t('10:00'),
      });
      const result = await promoteToAppointment(entry.id, fx.samId, t('10:05'));

      const { rows } = await getPool().query(
        `SELECT name, duration_minutes, price_cents FROM appointment_services
          WHERE appointment_id = $1 ORDER BY sort_order`,
        [result.appointmentId],
      );
      // Sam's master-tier durations and prices, not the base ones.
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ name: 'Haircut', duration_minutes: 35, price_cents: 4500 });
      expect(rows[1]).toMatchObject({ name: 'Beard trim', duration_minutes: 15, price_cents: 2000 });
    });

    it('refuses a walk-in that would run into the next appointment', async () => {
      // Sam has a booking at 10:30; a 35-minute cut at 10:05 would overrun.
      const held = await holdSlot({
        locationId: fx.locationId, serviceIds: [fx.cutId], clientId: fx.clientA,
        start: t('10:30'), staffId: fx.samId, sessionId: 's', now: t('09:00'),
      });
      await confirmAppointment({
        appointmentId: held.id, sessionId: 's', idempotencyKey: 'k', now: t('09:00'),
      });

      const entry = await joinQueue({
        locationId: fx.locationId, serviceIds: [fx.cutId],
        guestName: 'Dave', guestPhone: '+447700900500', now: t('10:00'),
      });

      await expect(
        promoteToAppointment(entry.id, fx.samId, t('10:05')),
      ).rejects.toMatchObject({ code: 'SLOT_TAKEN' });
    });

    it('fits a walk-in into a gap that is big enough', async () => {
      // Sam's next booking is at 11:30; a 35-minute cut at 10:05 fits.
      const held = await holdSlot({
        locationId: fx.locationId, serviceIds: [fx.cutId], clientId: fx.clientA,
        start: t('11:30'), staffId: fx.samId, sessionId: 's', now: t('09:00'),
      });
      await confirmAppointment({
        appointmentId: held.id, sessionId: 's', idempotencyKey: 'k', now: t('09:00'),
      });

      const entry = await joinQueue({
        locationId: fx.locationId, serviceIds: [fx.cutId],
        guestName: 'Dave', guestPhone: '+447700900500', now: t('10:00'),
      });

      const result = await promoteToAppointment(entry.id, fx.samId, t('10:05'));
      expect(result.appointmentId).toBeTruthy();
    });

    it('removes a promoted entry from the queue', async () => {
      const entry = await joinQueue({
        locationId: fx.locationId, serviceIds: [fx.cutId],
        guestName: 'Dave', guestPhone: '+447700900500', now: t('10:00'),
      });
      await promoteToAppointment(entry.id, fx.samId, t('10:05'));

      const live = await getLiveQueue(fx.locationId, t('10:06'));
      expect(live.entries).toHaveLength(0);
    });

    it('withdraws pending call-up messages once seated', async () => {
      const entry = await joinQueue({
        locationId: fx.locationId, serviceIds: [fx.cutId],
        guestName: 'Dave', guestPhone: '+447700900500', now: t('10:00'),
      });
      await notifyUpcoming(fx.locationId, t('10:01'));
      await promoteToAppointment(entry.id, fx.samId, t('10:05'));

      const { rows } = await getPool().query(
        `SELECT status FROM notifications WHERE queue_entry_id = $1`,
        [entry.id],
      );
      expect(rows.every((r) => r.status !== 'scheduled')).toBe(true);
    });

    it('cannot seat the same entry twice', async () => {
      const entry = await joinQueue({
        locationId: fx.locationId, serviceIds: [fx.cutId],
        guestName: 'Dave', guestPhone: '+447700900500', now: t('10:00'),
      });
      await promoteToAppointment(entry.id, fx.samId, t('10:05'));

      await expect(
        promoteToAppointment(entry.id, fx.alexId, t('10:06')),
      ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    });

    it('refuses a barber who cannot perform the service', async () => {
      await getPool().query(
        `DELETE FROM staff_services WHERE staff_id = $1 AND service_id = $2`,
        [fx.alexId, fx.cutId],
      );
      const entry = await joinQueue({
        locationId: fx.locationId, serviceIds: [fx.cutId],
        guestName: 'Dave', guestPhone: '+447700900500', now: t('10:00'),
      });

      await expect(
        promoteToAppointment(entry.id, fx.alexId, t('10:05')),
      ).rejects.toMatchObject({ code: 'NO_ELIGIBLE_STAFF' });
    });

    it('does not schedule reminders for a walk-in already in the chair', async () => {
      const entry = await joinQueue({
        locationId: fx.locationId, serviceIds: [fx.cutId],
        guestName: 'Dave', guestPhone: '+447700900500', now: t('10:00'),
      });
      const result = await promoteToAppointment(entry.id, fx.samId, t('10:05'));

      const messages = await listForAppointment(result.appointmentId);
      expect(messages.filter((m) => m.template.startsWith('reminder_'))).toEqual([]);
    });
  });
});
