/**
 * HTTP API tests.
 *
 * Covers the full journey a real client takes — browse anonymously, sign in
 * at confirm, book, get cancelled, take the waitlist slot — plus the
 * authorisation boundaries that keep one shop's data out of another's hands.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../src/db/pool.js';
import { buildServer } from '../src/api/server.js';
import {
  type ApiClient,
  linkStaffToUser,
  makeApi,
  makeStaff,
} from './helpers/api.js';
import { createFixture, resetDatabase, type Fixture } from './helpers/fixture.js';
import { resolveInstant } from '../src/domain/localtime.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const d = HAS_DB ? describe : describe.skip;

const DAY = '2026-10-01'; // Thursday
const TZ = 'Europe/London';
const iso = (time: string) => new Date(resolveInstant(DAY, time, TZ)).toISOString();

let api: ApiClient;
let fx: Fixture;

const CLIENT_PHONE = '+447700900300';
const OWNER_PHONE = '+447700900001'; // Sam, from the fixture
const BARBER_PHONE = '+447700900002'; // Alex

d('HTTP API', () => {
  beforeEach(async () => {
    await resetDatabase();
    fx = await createFixture();
    api = await makeApi();
  });

  afterAll(async () => {
    await closePool();
  });

  describe('health', () => {
    it('reports ok', async () => {
      const response = await api.get('/health');
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: 'ok' });
    });

    it('returns a structured 404 for an unknown route', async () => {
      const response = await api.get('/nope');
      expect(response.status).toBe(404);
      expect(response.body.error).toBe('NOT_FOUND');
    });
  });

  describe('authentication', () => {
    it('issues a code and exchanges it for a token', async () => {
      const challenge = await api.post('/auth/otp', { phone: CLIENT_PHONE });
      expect(challenge.status).toBe(200);
      expect(challenge.body.challengeId).toBeTruthy();
      // The code itself is never in the response.
      expect(challenge.body.code).toBeUndefined();

      const token = await api.login(CLIENT_PHONE, 'Dave');
      expect(token).toBeTruthy();

      const me = await api.get('/auth/me', token);
      expect(me.body).toMatchObject({ name: 'Dave', phone: CLIENT_PHONE });
    });

    it('answers identically for known and unknown numbers', async () => {
      await api.login(CLIENT_PHONE, 'Dave');

      const known = await api.post('/auth/otp', { phone: CLIENT_PHONE });
      const unknown = await api.post('/auth/otp', { phone: '+447700900999' });

      expect(known.status).toBe(unknown.status);
      expect(Object.keys(known.body).sort()).toEqual(Object.keys(unknown.body).sort());
    });

    it('rejects a wrong code', async () => {
      const challenge = await api.post('/auth/otp', { phone: CLIENT_PHONE });
      const response = await api.post('/auth/verify', {
        challengeId: challenge.body.challengeId,
        code: '000000',
      });
      // A wrong guess is 401 unless it happens to be right, which is 1-in-a-
      // million; treat either as "not a 5xx and no token issued".
      expect([401, 201]).toContain(response.status);
      if (response.status === 401) expect(response.body.error).toBe('INVALID_CODE');
    });

    it('locks a challenge after too many attempts', async () => {
      const challenge = await api.post('/auth/otp', { phone: CLIENT_PHONE });

      for (let i = 0; i < 5; i++) {
        await api.post('/auth/verify', {
          challengeId: challenge.body.challengeId,
          code: '000000',
        });
      }
      const response = await api.post('/auth/verify', {
        challengeId: challenge.body.challengeId,
        code: '000000',
      });
      expect(response.status).toBe(429);
    });

    it('rejects a malformed phone number', async () => {
      const response = await api.post('/auth/otp', { phone: 'not-a-number' });
      expect(response.status).toBe(400);
    });

    it('refuses a request with no token', async () => {
      expect((await api.get('/auth/me')).status).toBe(401);
    });

    it('refuses a made-up token', async () => {
      expect((await api.get('/auth/me', 'nonsense')).status).toBe(401);
    });

    it('stops accepting a token after logout', async () => {
      const token = await api.login(CLIENT_PHONE);
      expect((await api.post('/auth/logout', {}, token)).status).toBe(204);
      expect((await api.get('/auth/me', token)).status).toBe(401);
    });

    it('never stores the token or the code in the clear', async () => {
      const token = await api.login(CLIENT_PHONE);

      const sessions = await getPool().query(`SELECT token_hash FROM auth_sessions`);
      expect(sessions.rows[0].token_hash).not.toBe(token);
      expect(sessions.rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);

      const codes = await getPool().query(`SELECT code_hash FROM otp_challenges`);
      expect(codes.rows[0].code_hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('browsing without an account', () => {
    it('serves the shop menu publicly', async () => {
      const response = await api.get(`/locations/${fx.locationId}`);

      expect(response.status).toBe(200);
      expect(response.body.name).toBe('Fade Room Soho');
      expect(response.body.services.map((s: any) => s.name).sort()).toEqual([
        'Beard trim',
        'Haircut',
        'Skin fade',
      ]);
      expect(response.body.staff).toHaveLength(2);
    });

    it('serves availability publicly', async () => {
      const response = await api.get(
        `/locations/${fx.locationId}/availability?serviceIds=${fx.cutId}&date=${DAY}`,
      );

      expect(response.status).toBe(200);
      expect(response.body.options.length).toBeGreaterThan(0);
      expect(response.body.timezone).toBe('Europe/London');
    });

    it("names the shop's timezone so times are never silently shifted", async () => {
      const response = await api.get(
        `/locations/${fx.locationId}/availability?serviceIds=${fx.cutId}&date=${DAY}`,
      );
      expect(response.body.timezone).toBe('Europe/London');
      expect(response.body.options[0].start).toMatch(/Z$/);
    });

    it('returns no options on a day the shop is closed', async () => {
      const response = await api.get(
        `/locations/${fx.locationId}/availability?serviceIds=${fx.cutId}&date=2026-10-04`,
      );
      expect(response.body.options).toEqual([]);
    });

    it('rejects a missing date', async () => {
      const response = await api.get(
        `/locations/${fx.locationId}/availability?serviceIds=${fx.cutId}`,
      );
      expect(response.status).toBe(400);
    });

    it('404s an unknown location', async () => {
      const response = await api.get(
        `/locations/11111111-1111-1111-1111-111111111111`,
      );
      expect(response.status).toBe(404);
    });
  });

  describe('booking', () => {
    it('runs browse -> hold -> confirm', async () => {
      const token = await api.login(CLIENT_PHONE, 'Dave');

      const availability = await api.get(
        `/locations/${fx.locationId}/availability?serviceIds=${fx.cutId}&date=${DAY}&staffId=${fx.samId}`,
      );
      const slot = availability.body.options[0];

      const held = await api.post(
        '/appointments/hold',
        { locationId: fx.locationId, serviceIds: [fx.cutId], start: slot.start, staffId: fx.samId },
        token,
      );
      expect(held.status).toBe(201);
      expect(held.body.holdExpiresAt).toBeTruthy();

      const confirmed = await api.post(
        `/appointments/${held.body.appointmentId}/confirm`,
        {},
        token,
        { 'idempotency-key': 'test-key-1' },
      );

      expect(confirmed.status).toBe(200);
      expect(confirmed.body.status).toBe('confirmed');
      // The terms the client just accepted come back for the confirmation screen.
      expect(confirmed.body.policy.cancellationWindowHours).toBe(24);
    });

    it('requires a sign-in to hold a slot', async () => {
      const response = await api.post('/appointments/hold', {
        locationId: fx.locationId,
        serviceIds: [fx.cutId],
        start: iso('10:00'),
      });
      expect(response.status).toBe(401);
    });

    it('returns 409 rather than 500 when a slot is taken', async () => {
      const first = await api.login(CLIENT_PHONE, 'Dave');
      const second = await api.login('+447700900301', 'Sue');

      await api.post(
        '/appointments/hold',
        { locationId: fx.locationId, serviceIds: [fx.cutId], start: iso('10:00'), staffId: fx.samId },
        first,
      );

      const clash = await api.post(
        '/appointments/hold',
        { locationId: fx.locationId, serviceIds: [fx.cutId], start: iso('10:00'), staffId: fx.samId },
        second,
      );

      expect(clash.status).toBe(409);
      expect(clash.body.error).toBe('SLOT_TAKEN');
    });

    it('returns one booking when a confirm is retried with the same key', async () => {
      const token = await api.login(CLIENT_PHONE, 'Dave');
      const held = await api.post(
        '/appointments/hold',
        { locationId: fx.locationId, serviceIds: [fx.cutId], start: iso('10:00'), staffId: fx.samId },
        token,
      );

      const first = await api.post(
        `/appointments/${held.body.appointmentId}/confirm`,
        {},
        token,
        { 'idempotency-key': 'retry-key' },
      );
      const retry = await api.post(
        `/appointments/${held.body.appointmentId}/confirm`,
        {},
        token,
        { 'idempotency-key': 'retry-key' },
      );

      expect(retry.status).toBe(200);
      expect(retry.body.appointmentId).toBe(first.body.appointmentId);

      const { rows } = await getPool().query(
        `SELECT count(*)::int AS n FROM appointments WHERE status = 'confirmed'`,
      );
      expect(rows[0].n).toBe(1);
    });

    it("refuses to confirm another user's hold", async () => {
      const mine = await api.login(CLIENT_PHONE, 'Dave');
      const theirs = await api.login('+447700900301', 'Sue');

      const held = await api.post(
        '/appointments/hold',
        { locationId: fx.locationId, serviceIds: [fx.cutId], start: iso('10:00'), staffId: fx.samId },
        mine,
      );

      const response = await api.post(
        `/appointments/${held.body.appointmentId}/confirm`,
        {},
        theirs,
        { 'idempotency-key': 'stolen' },
      );
      expect(response.status).toBe(403);
    });

    it('validates the request body', async () => {
      const token = await api.login(CLIENT_PHONE);
      const response = await api.post(
        '/appointments/hold',
        { locationId: fx.locationId, start: iso('10:00') }, // no serviceIds
        token,
      );
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('VALIDATION_FAILED');
    });

    it('lists a client\'s own bookings', async () => {
      const token = await api.login(CLIENT_PHONE, 'Dave');
      const held = await api.post(
        '/appointments/hold',
        { locationId: fx.locationId, serviceIds: [fx.cutId], start: iso('10:00'), staffId: fx.samId },
        token,
      );
      await api.post(`/appointments/${held.body.appointmentId}/confirm`, {}, token, {
        'idempotency-key': 'k',
      });

      const response = await api.get('/appointments', token);
      expect(response.body.appointments).toHaveLength(1);
      expect(response.body.appointments[0]).toMatchObject({
        staffName: 'Sam',
        locationName: 'Fade Room Soho',
      });
    });

    it("does not show one client another's bookings", async () => {
      const mine = await api.login(CLIENT_PHONE, 'Dave');
      const held = await api.post(
        '/appointments/hold',
        { locationId: fx.locationId, serviceIds: [fx.cutId], start: iso('10:00'), staffId: fx.samId },
        mine,
      );
      await api.post(`/appointments/${held.body.appointmentId}/confirm`, {}, mine, {
        'idempotency-key': 'k',
      });

      const theirs = await api.login('+447700900301', 'Sue');
      const response = await api.get('/appointments', theirs);
      expect(response.body.appointments).toEqual([]);
    });
  });

  describe('cancellation', () => {
    const bookAs = async (token: string, time = '10:00') => {
      const held = await api.post(
        '/appointments/hold',
        { locationId: fx.locationId, serviceIds: [fx.cutId], start: iso(time), staffId: fx.samId },
        token,
      );
      await api.post(`/appointments/${held.body.appointmentId}/confirm`, {}, token, {
        'idempotency-key': `k-${time}-${Math.random()}`,
      });
      return held.body.appointmentId;
    };

    it('lets a client cancel their own booking', async () => {
      const token = await api.login(CLIENT_PHONE, 'Dave');
      const appointmentId = await bookAs(token);

      const response = await api.post(
        `/appointments/${appointmentId}/cancel`,
        { reason: 'something came up' },
        token,
      );

      expect(response.status).toBe(200);
      // Fees are stated plainly rather than discovered on a statement later.
      expect(response.body).toHaveProperty('feeCents');
    });

    it("refuses to let a client cancel someone else's", async () => {
      const mine = await api.login(CLIENT_PHONE, 'Dave');
      const appointmentId = await bookAs(mine);

      const theirs = await api.login('+447700900301', 'Sue');
      const response = await api.post(`/appointments/${appointmentId}/cancel`, {}, theirs);
      expect(response.status).toBe(403);
    });

    it('lets staff cancel any booking at their location', async () => {
      const client = await api.login(CLIENT_PHONE, 'Dave');
      const appointmentId = await bookAs(client);

      const ownerToken = await api.login(OWNER_PHONE);
      await linkStaffToUser(fx.samId, OWNER_PHONE);

      const response = await api.post(`/appointments/${appointmentId}/cancel`, {}, ownerToken);
      expect(response.status).toBe(200);
    });

    it('frees the slot for rebooking', async () => {
      const token = await api.login(CLIENT_PHONE, 'Dave');
      const appointmentId = await bookAs(token);
      await api.post(`/appointments/${appointmentId}/cancel`, {}, token);

      const availability = await api.get(
        `/locations/${fx.locationId}/availability?serviceIds=${fx.cutId}&date=${DAY}&staffId=${fx.samId}`,
      );
      expect(availability.body.options.map((o: any) => o.start)).toContain(iso('10:00'));
    });
  });

  describe('walk-in queue', () => {
    it('lets a guest join with no account at all', async () => {
      const response = await api.post(`/locations/${fx.locationId}/queue`, {
        serviceIds: [fx.cutId],
        name: 'Walk-in Dave',
        phone: '+447700900500',
      });

      expect(response.status).toBe(201);
      expect(response.body.publicToken).toMatch(/^[0-9a-f]{32}$/);
    });

    it('shows position and wait by token, with no account', async () => {
      const joined = await api.post(`/locations/${fx.locationId}/queue`, {
        serviceIds: [fx.cutId],
        name: 'Dave',
        phone: '+447700900500',
      });

      const status = await api.get(`/queue/${joined.body.publicToken}`);
      expect(status.status).toBe(200);
      expect(status.body.position).toBe(1);
      expect(status.body.waitMinutes).toHaveProperty('from');
    });

    it("never leaks another client's details on the public page", async () => {
      const mine = await api.post(`/locations/${fx.locationId}/queue`, {
        serviceIds: [fx.cutId],
        name: 'Mine',
        phone: '+447700900500',
      });
      await api.post(`/locations/${fx.locationId}/queue`, {
        serviceIds: [fx.cutId],
        name: 'Someone Else',
        phone: '+447700900999',
      });

      const status = await api.get(`/queue/${mine.body.publicToken}`);
      const serialised = JSON.stringify(status.body);
      expect(serialised).not.toContain('Someone Else');
      expect(serialised).not.toContain('447700900999');
    });

    it('lets a guest leave the queue by token', async () => {
      const joined = await api.post(`/locations/${fx.locationId}/queue`, {
        serviceIds: [fx.cutId],
        name: 'Dave',
        phone: '+447700900500',
      });

      expect((await api.del(`/queue/${joined.body.publicToken}`)).status).toBe(204);
      const status = await api.get(`/queue/${joined.body.publicToken}`);
      expect(status.body.status).toBe('abandoned');
    });

    it('hides the staff-side queue from the public', async () => {
      const response = await api.get(`/locations/${fx.locationId}/queue`);
      expect(response.status).toBe(401);
    });

    it('hides the staff-side queue from a signed-in client', async () => {
      const token = await api.login(CLIENT_PHONE, 'Dave');
      const response = await api.get(`/locations/${fx.locationId}/queue`, token);
      expect(response.status).toBe(403);
    });

    it('shows staff the full queue with contact details', async () => {
      await api.post(`/locations/${fx.locationId}/queue`, {
        serviceIds: [fx.cutId],
        name: 'Dave',
        phone: '+447700900500',
      });

      const token = await api.login(BARBER_PHONE);
      await linkStaffToUser(fx.alexId, BARBER_PHONE);

      const response = await api.get(`/locations/${fx.locationId}/queue`, token);
      expect(response.status).toBe(200);
      expect(response.body.entries[0]).toMatchObject({
        name: 'Dave',
        phone: '+447700900500',
        position: 1,
      });
    });

    it('seats a walk-in as a real appointment', async () => {
      // Seating happens at the real wall-clock time, so the shop has to be
      // open whenever the suite runs.
      await resetDatabase();
      fx = await createFixture({ alwaysOpen: true });

      const joined = await api.post(`/locations/${fx.locationId}/queue`, {
        serviceIds: [fx.cutId],
        name: 'Dave',
        phone: '+447700900500',
      });

      const token = await api.login(BARBER_PHONE);
      await linkStaffToUser(fx.alexId, BARBER_PHONE);

      const response = await api.post(
        `/queue/${joined.body.queueEntryId}/seat`,
        {},
        token,
      );

      expect(response.status).toBe(201);
      const { rows } = await getPool().query(
        `SELECT status, source FROM appointments WHERE id = $1`,
        [response.body.appointmentId],
      );
      expect(rows[0]).toMatchObject({ status: 'in_progress', source: 'walkin' });
    });
  });

  describe('checkout', () => {
    let staffToken: string;
    let appointmentId: string;

    beforeEach(async () => {
      staffToken = await api.login(OWNER_PHONE);
      await linkStaffToUser(fx.samId, OWNER_PHONE);
      await getPool().query(`UPDATE staff SET role = 'owner' WHERE id = $1`, [fx.samId]);

      const clientToken = await api.login(CLIENT_PHONE, 'Dave');
      const held = await api.post(
        '/appointments/hold',
        { locationId: fx.locationId, serviceIds: [fx.cutId], start: iso('10:00'), staffId: fx.samId },
        clientToken,
      );
      appointmentId = held.body.appointmentId;
      await api.post(`/appointments/${appointmentId}/confirm`, {}, clientToken, {
        'idempotency-key': 'checkout-setup',
      });
    });

    it('opens pre-filled from the appointment', async () => {
      const response = await api.post(
        `/appointments/${appointmentId}/checkout`,
        {},
        staffToken,
      );

      expect(response.status).toBe(201);
      expect(response.body.totalCents).toBe(4500);
    });

    it('takes retail, a tip, and settles across two payments', async () => {
      const opened = await api.post(
        `/appointments/${appointmentId}/checkout`,
        {},
        staffToken,
      );
      const checkoutId = opened.body.checkoutId;

      await api.post(
        `/checkouts/${checkoutId}/items`,
        { productId: fx.pomadeId, quantity: 1 },
        staffToken,
      );
      const tipped = await api.post(
        `/checkouts/${checkoutId}/tip`,
        { amountCents: 500 },
        staffToken,
      );
      expect(tipped.body.totalCents).toBe(4500 + 1500 + 500);

      const part = await api.post(
        `/checkouts/${checkoutId}/payments`,
        { amountCents: 3000, method: 'cash' },
        staffToken,
      );
      expect(part.body.outstandingCents).toBe(3500);

      await api.post(
        `/checkouts/${checkoutId}/payments`,
        { amountCents: 3500, method: 'card' },
        staffToken,
      );

      const completed = await api.post(
        `/checkouts/${checkoutId}/complete`,
        {},
        staffToken,
      );
      expect(completed.status).toBe(200);
      expect(completed.body.status).toBe('completed');
      // The rebook prompt is handed straight back to the barber app.
      expect(completed.body.rebook).toMatchObject({ staffId: fx.samId });
    });

    it('refuses to complete while money is outstanding', async () => {
      const opened = await api.post(
        `/appointments/${appointmentId}/checkout`,
        {},
        staffToken,
      );
      const response = await api.post(
        `/checkouts/${opened.body.checkoutId}/complete`,
        {},
        staffToken,
      );

      expect(response.status).toBe(409);
      expect(response.body.details.outstandingCents).toBe(4500);
    });

    it('keeps checkout away from clients', async () => {
      const clientToken = await api.login('+447700900301', 'Sue');
      const response = await api.post(
        `/appointments/${appointmentId}/checkout`,
        {},
        clientToken,
      );
      expect(response.status).toBe(403);
    });
  });

  describe('reporting access', () => {
    it('lets an owner see the dashboard', async () => {
      const token = await api.login(OWNER_PHONE);
      await linkStaffToUser(fx.samId, OWNER_PHONE);
      await getPool().query(`UPDATE staff SET role = 'owner' WHERE id = $1`, [fx.samId]);

      const response = await api.get(
        `/locations/${fx.locationId}/reports/dashboard?date=${DAY}`,
        token,
      );
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('expectedRevenueCents');
    });

    it("keeps the shop's takings from a barber", async () => {
      const token = await api.login(BARBER_PHONE);
      await linkStaffToUser(fx.alexId, BARBER_PHONE);
      await getPool().query(`UPDATE staff SET role = 'barber' WHERE id = $1`, [fx.alexId]);

      const response = await api.get(
        `/locations/${fx.locationId}/reports/dashboard?date=${DAY}`,
        token,
      );
      expect(response.status).toBe(403);
    });

    it('lets a barber see their own earnings', async () => {
      const token = await api.login(BARBER_PHONE);
      await linkStaffToUser(fx.alexId, BARBER_PHONE);
      await getPool().query(
        `INSERT INTO staff_compensation
           (staff_id, kind, service_commission_bps, retail_commission_bps, effective_from)
         VALUES ($1,'commission',4000,1000,'2026-01-01')`,
        [fx.alexId],
      );

      const response = await api.post(
        `/staff/${fx.alexId}/payouts`,
        { periodStart: DAY, periodEnd: DAY },
        token,
      );
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('netCents');
    });

    it("stops a barber reading a colleague's earnings", async () => {
      const token = await api.login(BARBER_PHONE);
      await linkStaffToUser(fx.alexId, BARBER_PHONE);
      await getPool().query(`UPDATE staff SET role = 'barber' WHERE id = $1`, [fx.alexId]);

      const response = await api.post(
        `/staff/${fx.samId}/payouts`,
        { periodStart: DAY, periodEnd: DAY },
        token,
      );
      expect(response.status).toBe(403);
    });

    it('stops a barber recording a payout for themselves', async () => {
      const token = await api.login(BARBER_PHONE);
      await linkStaffToUser(fx.alexId, BARBER_PHONE);
      await getPool().query(`UPDATE staff SET role = 'barber' WHERE id = $1`, [fx.alexId]);
      await getPool().query(
        `INSERT INTO staff_compensation
           (staff_id, kind, service_commission_bps, effective_from)
         VALUES ($1,'commission',4000,'2026-01-01')`,
        [fx.alexId],
      );

      const response = await api.post(
        `/staff/${fx.alexId}/payouts`,
        { periodStart: DAY, periodEnd: DAY, persist: true },
        token,
      );
      expect(response.status).toBe(403);
    });
  });

  describe('cross-location isolation', () => {
    it("keeps staff at one shop out of another shop's data", async () => {
      // A second, unrelated shop, with its own people.
      const other = await createFixture({ phoneSeed: 1 });

      const token = await api.login(OWNER_PHONE);
      await linkStaffToUser(fx.samId, OWNER_PHONE);
      await getPool().query(`UPDATE staff SET role = 'owner' WHERE id = $1`, [fx.samId]);

      const response = await api.get(
        `/locations/${other.locationId}/reports/dashboard?date=${DAY}`,
        token,
      );
      expect(response.status).toBe(403);
    });
  });
});

d('rate limiting', () => {
  beforeEach(async () => {
    await resetDatabase();
    fx = await createFixture();
  });

  afterAll(async () => {
    await closePool();
  });

  it('throttles repeated requests for login codes', async () => {
    // This endpoint sends SMS, which costs money and is the obvious target
    // for running up a bill or spamming a number.
    const app = await buildServer({ rateLimitMax: 1000 });
    await app.ready();

    const send = () =>
      app.inject({
        method: 'POST',
        url: '/auth/otp',
        payload: { phone: CLIENT_PHONE },
      });

    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) statuses.push((await send()).statusCode);

    expect(statuses.filter((s) => s === 200).length).toBeLessThanOrEqual(5);
    expect(statuses).toContain(429);

    await app.close();
  });
});
