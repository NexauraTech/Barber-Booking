/**
 * Database-backed tests: the concurrency, hold and idempotency guarantees
 * that only a real Postgres can demonstrate.
 *
 * Covers the test cases listed in docs/research/05-reference-architecture.md §5.6.
 * Requires DATABASE_URL; skipped automatically when it is unset.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { closePool, getPool } from '../src/db/pool.js';
import {
  cancelAppointment,
  confirmAppointment,
  expireStaleHolds,
  getAvailability,
  holdSlot,
  markNoShow,
} from '../src/booking/commands.js';
import { BookingError } from '../src/booking/errors.js';
import { createFixture, resetDatabase, type Fixture } from './helpers/fixture.js';
import { resolveInstant } from '../src/domain/localtime.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const d = HAS_DB ? describe : describe.skip;

const DAY = '2026-10-01'; // Thursday
const TZ = 'Europe/London';
const t = (time: string, date = DAY) => resolveInstant(date, time, TZ);
const hhmm = (ms: number | Date) =>
  DateTime.fromMillis(ms instanceof Date ? ms.getTime() : ms, { zone: TZ }).toFormat('HH:mm');

// A fixed "now" well before the test day, so lead time never interferes.
const NOW = resolveInstant('2026-09-30', '08:00', TZ);

let fx: Fixture;

d('booking commands', () => {
  beforeEach(async () => {
    await resetDatabase();
    fx = await createFixture();
  });

  afterAll(async () => {
    await closePool();
  });

  describe('availability', () => {
    it('offers per-barber durations for the same service', async () => {
      const { slots } = await getAvailability({
        locationId: fx.locationId,
        serviceIds: [fx.cutId],
        date: DAY,
        now: NOW,
      });

      const sam = slots.filter((s) => s.staffId === fx.samId);
      const alex = slots.filter((s) => s.staffId === fx.alexId);

      expect(sam[0]!.durationMinutes).toBe(35);
      expect(alex[0]!.durationMinutes).toBe(55);
      expect(hhmm(sam[0]!.start)).toBe('09:00');
    });

    it("excludes Sam's lunch break but not Alex's time", async () => {
      const { slots } = await getAvailability({
        locationId: fx.locationId,
        serviceIds: [fx.cutId],
        date: DAY,
        now: NOW,
      });

      const samStarts = slots.filter((s) => s.staffId === fx.samId).map((s) => hhmm(s.start));
      const alexStarts = slots.filter((s) => s.staffId === fx.alexId).map((s) => hhmm(s.start));

      // Sam's 35m cut cannot start at 12:45 (would run into the 13:00 break).
      expect(samStarts).not.toContain('12:45');
      expect(samStarts).toContain('13:30');
      // Alex has no break, but a 55m cut from 12:45 ends 13:40 — fine.
      expect(alexStarts).toContain('12:45');
    });

    it('sums durations for a multi-service booking', async () => {
      const { slots } = await getAvailability({
        locationId: fx.locationId,
        serviceIds: [fx.cutId, fx.beardId],
        date: DAY,
        staffId: fx.samId,
        now: NOW,
      });
      expect(slots[0]!.durationMinutes).toBe(50); // 35 + 15
    });

    it('returns nothing on a Sunday, when the shop is shut', async () => {
      const { slots } = await getAvailability({
        locationId: fx.locationId,
        serviceIds: [fx.cutId],
        date: '2026-10-04',
        now: NOW,
      });
      expect(slots).toEqual([]);
    });

    it('respects a dated closure', async () => {
      await getPool().query(
        `INSERT INTO closures (location_id, on_date, reason) VALUES ($1,$2,'Holiday')`,
        [fx.locationId, DAY],
      );
      const { slots } = await getAvailability({
        locationId: fx.locationId,
        serviceIds: [fx.cutId],
        date: DAY,
        now: NOW,
      });
      expect(slots).toEqual([]);
    });

    it('respects approved time off but ignores pending requests', async () => {
      await getPool().query(
        `INSERT INTO time_off (staff_id, starts_at, ends_at, status)
         VALUES ($1, $2, $3, 'pending')`,
        [fx.samId, new Date(t('09:00')), new Date(t('17:00'))],
      );

      let result = await getAvailability({
        locationId: fx.locationId,
        serviceIds: [fx.cutId],
        date: DAY,
        staffId: fx.samId,
        now: NOW,
      });
      expect(result.slots.length).toBeGreaterThan(0);

      await getPool().query(`UPDATE time_off SET status = 'approved'`);

      result = await getAvailability({
        locationId: fx.locationId,
        serviceIds: [fx.cutId],
        date: DAY,
        staffId: fx.samId,
        now: NOW,
      });
      expect(result.slots).toEqual([]);
    });

    it('honours a fortnightly shift rotation', async () => {
      await getPool().query(`DELETE FROM shifts WHERE staff_id = $1`, [fx.samId]);
      await getPool().query(
        `INSERT INTO shifts (staff_id, weekday, starts_at, ends_at,
                             repeat_interval_weeks, anchor_date, effective_from)
         VALUES ($1, 4, '09:00', '17:00', 2, '2026-10-01', '2026-01-01')`,
        [fx.samId],
      );

      const onWeek = await getAvailability({
        locationId: fx.locationId, serviceIds: [fx.cutId], date: '2026-10-01',
        staffId: fx.samId, now: NOW,
      });
      const offWeek = await getAvailability({
        locationId: fx.locationId, serviceIds: [fx.cutId], date: '2026-10-08',
        staffId: fx.samId, now: NOW,
      });
      const nextOnWeek = await getAvailability({
        locationId: fx.locationId, serviceIds: [fx.cutId], date: '2026-10-15',
        staffId: fx.samId, now: NOW,
      });

      expect(onWeek.slots.length).toBeGreaterThan(0);
      expect(offWeek.slots).toEqual([]);
      expect(nextOnWeek.slots.length).toBeGreaterThan(0);
    });

    it('excludes a barber who has online booking switched off', async () => {
      await getPool().query(
        `UPDATE staff SET accepts_online = false WHERE id = $1`,
        [fx.samId],
      );
      const { slots } = await getAvailability({
        locationId: fx.locationId,
        serviceIds: [fx.cutId],
        date: DAY,
        now: NOW,
      });
      expect(slots.every((s) => s.staffId === fx.alexId)).toBe(true);
    });
  });

  describe('holds', () => {
    it('reserves the slot so a second client cannot take it', async () => {
      await holdSlot({
        locationId: fx.locationId, serviceIds: [fx.cutId], clientId: fx.clientA,
        start: t('10:00'), staffId: fx.samId, sessionId: 'session-a', now: NOW,
      });

      await expect(
        holdSlot({
          locationId: fx.locationId, serviceIds: [fx.cutId], clientId: fx.clientB,
          start: t('10:00'), staffId: fx.samId, sessionId: 'session-b', now: NOW,
        }),
      ).rejects.toThrow(BookingError);
    });

    it('releases the slot once the hold expires', async () => {
      const held = await holdSlot({
        locationId: fx.locationId, serviceIds: [fx.cutId], clientId: fx.clientA,
        start: t('10:00'), staffId: fx.samId, sessionId: 'session-a', now: NOW,
      });

      const afterExpiry = held.holdExpiresAt!.getTime() + 1000;

      // Availability already ignores expired holds...
      const { slots } = await getAvailability({
        locationId: fx.locationId, serviceIds: [fx.cutId], date: DAY,
        staffId: fx.samId, now: afterExpiry,
      });
      expect(slots.map((s) => hhmm(s.start))).toContain('10:00');

      // ...and the sweeper frees the row for the constraint.
      expect(await expireStaleHolds(new Date(afterExpiry))).toBe(1);

      const rebooked = await holdSlot({
        locationId: fx.locationId, serviceIds: [fx.cutId], clientId: fx.clientB,
        start: t('10:00'), staffId: fx.samId, sessionId: 'session-b', now: afterExpiry,
      });
      expect(rebooked.clientId).toBe(fx.clientB);
    });

    it('assigns a barber automatically for an "any barber" hold', async () => {
      const held = await holdSlot({
        locationId: fx.locationId, serviceIds: [fx.cutId], clientId: fx.clientA,
        start: t('10:00'), sessionId: 'session-a', now: NOW,
      });
      expect([fx.samId, fx.alexId]).toContain(held.staffId);
    });

    it('rejects a start time that is not on the grid', async () => {
      await expect(
        holdSlot({
          locationId: fx.locationId, serviceIds: [fx.cutId], clientId: fx.clientA,
          start: t('10:07'), staffId: fx.samId, sessionId: 'session-a', now: NOW,
        }),
      ).rejects.toMatchObject({ code: 'SLOT_TAKEN' });
    });

    it('rejects a booking outside opening hours', async () => {
      await expect(
        holdSlot({
          locationId: fx.locationId, serviceIds: [fx.cutId], clientId: fx.clientA,
          start: t('20:00'), staffId: fx.samId, sessionId: 'session-a', now: NOW,
        }),
      ).rejects.toMatchObject({ code: 'SLOT_TAKEN' });
    });
  });

  describe('confirm', () => {
    const hold = () =>
      holdSlot({
        locationId: fx.locationId, serviceIds: [fx.cutId], clientId: fx.clientA,
        start: t('10:00'), staffId: fx.samId, sessionId: 'session-a', now: NOW,
      });

    it('promotes a hold to a confirmed booking', async () => {
      const held = await hold();
      const confirmed = await confirmAppointment({
        appointmentId: held.id, sessionId: 'session-a',
        idempotencyKey: 'key-1', now: NOW,
      });

      expect(confirmed.status).toBe('confirmed');
      expect(confirmed.holdExpiresAt).toBeNull();
    });

    it('returns the same appointment when a request is retried', async () => {
      const held = await hold();
      const first = await confirmAppointment({
        appointmentId: held.id, sessionId: 'session-a', idempotencyKey: 'key-1', now: NOW,
      });
      const retry = await confirmAppointment({
        appointmentId: held.id, sessionId: 'session-a', idempotencyKey: 'key-1', now: NOW,
      });

      expect(retry.id).toBe(first.id);

      const { rows } = await getPool().query(
        `SELECT count(*)::int AS n FROM appointments WHERE status = 'confirmed'`,
      );
      expect(rows[0].n).toBe(1);
    });

    it('refuses a hold belonging to another session', async () => {
      const held = await hold();
      await expect(
        confirmAppointment({
          appointmentId: held.id, sessionId: 'someone-else',
          idempotencyKey: 'key-2', now: NOW,
        }),
      ).rejects.toMatchObject({ code: 'HOLD_NOT_YOURS' });
    });

    it('refuses an expired hold', async () => {
      const held = await hold();
      await expect(
        confirmAppointment({
          appointmentId: held.id, sessionId: 'session-a', idempotencyKey: 'key-3',
          now: held.holdExpiresAt!.getTime() + 1000,
        }),
      ).rejects.toMatchObject({ code: 'HOLD_EXPIRED' });
    });

    it('snapshots service name, duration and price at booking time', async () => {
      const held = await hold();
      await confirmAppointment({
        appointmentId: held.id, sessionId: 'session-a', idempotencyKey: 'key-4', now: NOW,
      });

      await getPool().query(
        `UPDATE services SET name = 'Renamed', price_cents = 9999 WHERE id = $1`,
        [fx.cutId],
      );

      const { rows } = await getPool().query(
        `SELECT name, duration_minutes, price_cents FROM appointment_services
          WHERE appointment_id = $1`,
        [held.id],
      );
      expect(rows[0]).toMatchObject({
        name: 'Haircut',
        duration_minutes: 35,
        price_cents: 4500, // Sam's master-tier price, not the base price
      });
    });
  });

  describe('cancellation and no-shows', () => {
    it('makes the slot bookable again after a cancellation', async () => {
      const held = await holdSlot({
        locationId: fx.locationId, serviceIds: [fx.cutId], clientId: fx.clientA,
        start: t('10:00'), staffId: fx.samId, sessionId: 'session-a', now: NOW,
      });
      await confirmAppointment({
        appointmentId: held.id, sessionId: 'session-a', idempotencyKey: 'k', now: NOW,
      });

      let result = await getAvailability({
        locationId: fx.locationId, serviceIds: [fx.cutId], date: DAY,
        staffId: fx.samId, now: NOW,
      });
      expect(result.slots.map((s) => hhmm(s.start))).not.toContain('10:00');

      await cancelAppointment({ appointmentId: held.id, reason: 'client cancelled' });

      result = await getAvailability({
        locationId: fx.locationId, serviceIds: [fx.cutId], date: DAY,
        staffId: fx.samId, now: NOW,
      });
      expect(result.slots.map((s) => hhmm(s.start))).toContain('10:00');

      // And the freed time can actually be resold.
      const resold = await holdSlot({
        locationId: fx.locationId, serviceIds: [fx.cutId], clientId: fx.clientB,
        start: t('10:00'), staffId: fx.samId, sessionId: 'session-b', now: NOW,
      });
      expect(resold.clientId).toBe(fx.clientB);
    });

    it('increments the reputation counters', async () => {
      const held = await holdSlot({
        locationId: fx.locationId, serviceIds: [fx.cutId], clientId: fx.clientA,
        start: t('11:00'), staffId: fx.samId, sessionId: 's', now: NOW,
      });
      await confirmAppointment({
        appointmentId: held.id, sessionId: 's', idempotencyKey: 'k2', now: NOW,
      });
      await markNoShow(held.id);

      const { rows } = await getPool().query(
        `SELECT no_show_count FROM clients WHERE id = $1`,
        [fx.clientA],
      );
      expect(rows[0].no_show_count).toBe(1);
    });

    it('refuses to cancel an already-cancelled booking', async () => {
      const held = await holdSlot({
        locationId: fx.locationId, serviceIds: [fx.cutId], clientId: fx.clientA,
        start: t('12:00'), staffId: fx.samId, sessionId: 's', now: NOW,
      });
      await cancelAppointment({ appointmentId: held.id });
      await expect(cancelAppointment({ appointmentId: held.id })).rejects.toMatchObject({
        code: 'INVALID_STATE',
      });
    });
  });

  describe('buffers', () => {
    it("blocks the slot covered by a previous booking's trailing buffer", async () => {
      // Skin fade: 35m for Sam, plus a 10m post-buffer.
      await holdSlot({
        locationId: fx.locationId, serviceIds: [fx.fadeId], clientId: fx.clientA,
        start: t('10:00'), staffId: fx.samId, sessionId: 's', now: NOW,
      });

      const { slots } = await getAvailability({
        locationId: fx.locationId, serviceIds: [fx.fadeId], date: DAY,
        staffId: fx.samId, now: NOW,
      });
      const starts = slots.map((s) => hhmm(s.start));

      // Occupied 10:00-10:45 including the buffer, so 10:30 is unavailable
      // and the next grid start is 10:45.
      expect(starts).not.toContain('10:30');
      expect(starts).toContain('10:45');
    });
  });

  describe('concurrency', () => {
    it('lets exactly one of two simultaneous holds win', async () => {
      const attempt = (clientId: string, sessionId: string) =>
        holdSlot({
          locationId: fx.locationId, serviceIds: [fx.cutId], clientId,
          start: t('10:00'), staffId: fx.samId, sessionId, now: NOW,
        }).then(
          (a) => ({ ok: true as const, a }),
          (e) => ({ ok: false as const, e }),
        );

      const results = await Promise.all([
        attempt(fx.clientA, 'session-a'),
        attempt(fx.clientB, 'session-b'),
      ]);

      expect(results.filter((r) => r.ok)).toHaveLength(1);

      const loser = results.find((r) => !r.ok)!;
      expect(loser.ok).toBe(false);
      if (!loser.ok) expect(loser.e).toMatchObject({ code: 'SLOT_TAKEN' });

      const { rows } = await getPool().query(
        `SELECT count(*)::int AS n FROM appointments
          WHERE staff_id = $1 AND status <> 'cancelled'`,
        [fx.samId],
      );
      expect(rows[0].n).toBe(1);
    });

    it('survives a burst of ten concurrent attempts on one slot', async () => {
      const attempts = Array.from({ length: 10 }, (_, i) =>
        holdSlot({
          locationId: fx.locationId, serviceIds: [fx.cutId],
          clientId: i % 2 === 0 ? fx.clientA : fx.clientB,
          start: t('14:00'), staffId: fx.samId, sessionId: `s-${i}`, now: NOW,
        }).then(() => 'ok' as const, () => 'failed' as const),
      );

      const results = await Promise.all(attempts);
      expect(results.filter((r) => r === 'ok')).toHaveLength(1);

      const { rows } = await getPool().query(
        `SELECT count(*)::int AS n FROM appointments
          WHERE staff_id = $1 AND starts_at = $2 AND status <> 'cancelled'`,
        [fx.samId, new Date(t('14:00'))],
      );
      expect(rows[0].n).toBe(1);
    });

    it('allows concurrent holds on different barbers at the same time', async () => {
      const results = await Promise.all([
        holdSlot({
          locationId: fx.locationId, serviceIds: [fx.cutId], clientId: fx.clientA,
          start: t('10:00'), staffId: fx.samId, sessionId: 'a', now: NOW,
        }),
        holdSlot({
          locationId: fx.locationId, serviceIds: [fx.cutId], clientId: fx.clientB,
          start: t('10:00'), staffId: fx.alexId, sessionId: 'b', now: NOW,
        }),
      ]);
      expect(results).toHaveLength(2);
    });
  });

  describe('resource capacity', () => {
    it('stops a third simultaneous booking when the shop has two chairs', async () => {
      // Both barbers take a fade at 10:00, using both chairs.
      await holdSlot({
        locationId: fx.locationId, serviceIds: [fx.fadeId], clientId: fx.clientA,
        start: t('10:00'), staffId: fx.samId, sessionId: 'a', now: NOW,
      });
      await holdSlot({
        locationId: fx.locationId, serviceIds: [fx.fadeId], clientId: fx.clientB,
        start: t('10:00'), staffId: fx.alexId, sessionId: 'b', now: NOW,
      });

      // A third barber would have no chair free at 10:00.
      const user = await getPool().query(
        `INSERT INTO users (phone, name) VALUES ('+447700900003','Jo') RETURNING id`,
      );
      const jo = await getPool().query(
        `INSERT INTO staff (user_id, location_id, display_name)
         VALUES ($1,$2,'Jo') RETURNING id`,
        [user.rows[0].id, fx.locationId],
      );
      const joId = jo.rows[0].id;
      await getPool().query(
        `INSERT INTO shifts (staff_id, weekday, starts_at, ends_at, anchor_date, effective_from)
         VALUES ($1, 4, '09:00', '17:00', '2026-01-05', '2026-01-01')`,
        [joId],
      );
      await getPool().query(
        `INSERT INTO staff_services (staff_id, service_id) VALUES ($1,$2)`,
        [joId, fx.fadeId],
      );

      const { slots } = await getAvailability({
        locationId: fx.locationId, serviceIds: [fx.fadeId], date: DAY,
        staffId: joId, now: NOW,
      });

      expect(slots.map((s) => hhmm(s.start))).not.toContain('10:00');
    });
  });

  describe('timezones', () => {
    it('books a Karachi shop at the correct instant', async () => {
      await resetDatabase();
      fx = await createFixture({ timezone: 'Asia/Karachi' });

      const start = resolveInstant(DAY, '10:00', 'Asia/Karachi');
      const held = await holdSlot({
        locationId: fx.locationId, serviceIds: [fx.cutId], clientId: fx.clientA,
        start, staffId: fx.samId, sessionId: 's',
        now: resolveInstant('2026-09-30', '08:00', 'Asia/Karachi'),
      });

      const local = DateTime.fromJSDate(held.startsAt, { zone: 'Asia/Karachi' });
      expect(local.toFormat('HH:mm ZZ')).toBe('10:00 +05:00');
      // Same instant, rendered in the client's zone.
      expect(
        DateTime.fromJSDate(held.startsAt, { zone: 'America/New_York' }).toFormat('HH:mm'),
      ).toBe('01:00');
    });
  });
});
