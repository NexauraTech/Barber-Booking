/**
 * Database-backed realtime tests.
 *
 * The behaviour that only a real Postgres demonstrates: that NOTIFY is
 * transactional, so an event can never describe a write that rolled back.
 * That property is the entire reason the bus is Postgres rather than an
 * in-process emitter or a separate broker.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool, withTransaction } from '../src/db/pool.js';
import { EventBus, publish } from '../src/realtime/bus.js';
import type { RealtimeEvent } from '../src/realtime/events.js';
import { confirmAppointment, holdSlot, markNoShow } from '../src/booking/commands.js';
import { cancelAndRefill } from '../src/booking/cancel-and-refill.js';
import { joinQueueAndAnnounce } from '../src/queue/service.js';
import { createFixture, resetDatabase, type Fixture } from './helpers/fixture.js';
import { resolveInstant } from '../src/domain/localtime.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const d = HAS_DB ? describe : describe.skip;

const DAY = '2026-10-01';
const TZ = 'Europe/London';
const t = (time: string) => resolveInstant(DAY, time, TZ);
const BEFORE = resolveInstant('2026-09-29', '09:00', TZ);

let fx: Fixture;
let bus: EventBus;
let received: RealtimeEvent[];

/** Wait until `predicate` holds over the received events, or time out. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `Timed out waiting for events. Received: ${received.map((e) => e.type).join(', ') || '(none)'}`,
  );
}

const ofType = (type: string) => received.filter((e) => e.type === type);

d('realtime bus', () => {
  beforeEach(async () => {
    await resetDatabase();
    fx = await createFixture();

    received = [];
    bus = new EventBus();
    await bus.start();
    bus.subscribe((event) => received.push(event));
    // LISTEN is registered on connect; give it a moment to be live.
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  afterEach(async () => {
    await bus.stop();
  });

  afterAll(async () => {
    await closePool();
  });

  describe('delivery', () => {
    it('delivers a published event to a listener', async () => {
      await publish({
        type: 'staff.presence',
        locationId: fx.locationId,
        staffId: fx.samId,
        state: 'available',
      });

      await waitFor(() => ofType('staff.presence').length === 1);
      expect(received[0]).toMatchObject({
        type: 'staff.presence',
        staffId: fx.samId,
        state: 'available',
      });
    });

    it('stamps a monotonically increasing seq', async () => {
      for (const state of ['available', 'on_break', 'available'] as const) {
        await publish({
          type: 'staff.presence',
          locationId: fx.locationId,
          staffId: fx.samId,
          state,
        });
      }

      await waitFor(() => ofType('staff.presence').length === 3);
      const seqs = received.map((e) => e.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
      expect(new Set(seqs).size).toBe(3);
    });

    it('stamps an ISO timestamp', async () => {
      await publish({
        type: 'staff.presence',
        locationId: fx.locationId,
        staffId: fx.samId,
        state: 'off',
      });

      await waitFor(() => received.length === 1);
      expect(new Date(received[0]!.at).toISOString()).toBe(received[0]!.at);
    });

    it('delivers to several listeners', async () => {
      const second: RealtimeEvent[] = [];
      bus.subscribe((event) => second.push(event));

      await publish({
        type: 'staff.presence',
        locationId: fx.locationId,
        staffId: fx.samId,
        state: 'available',
      });

      await waitFor(() => received.length === 1 && second.length === 1);
    });

    it('stops delivering after unsubscribe', async () => {
      const dropped: RealtimeEvent[] = [];
      const unsubscribe = bus.subscribe((event) => dropped.push(event));
      unsubscribe();

      await publish({
        type: 'staff.presence',
        locationId: fx.locationId,
        staffId: fx.samId,
        state: 'available',
      });

      await waitFor(() => received.length === 1);
      expect(dropped).toHaveLength(0);
    });

    it('replaces an oversized payload with a resync rather than dropping it', async () => {
      // A queue snapshot far larger than the 8000-byte NOTIFY ceiling.
      await publish({
        type: 'queue.changed',
        locationId: fx.locationId,
        quotedWaitMinutes: 60,
        entries: Array.from({ length: 400 }, (_, i) => ({
          queueEntryId: `entry-${i}-${'x'.repeat(40)}`,
          position: i + 1,
          name: `A client with a fairly long name ${i}`,
          phone: '+447700900500',
          clientId: null,
          status: 'waiting',
          assignedStaffId: fx.samId,
          waitFromMinutes: i,
          waitToMinutes: i + 5,
        })),
      });

      await waitFor(() => received.length === 1);
      // Told to refetch, rather than silently missing the change.
      expect(received[0]!.type).toBe('resync');
      expect((received[0] as { reason: string }).reason).toContain('queue.changed');
    });
  });

  describe('transactional delivery', () => {
    it('does not deliver an event whose transaction rolled back', async () => {
      await expect(
        withTransaction(async (client) => {
          await publish(
            {
              type: 'staff.presence',
              locationId: fx.locationId,
              staffId: fx.samId,
              state: 'available',
            },
            client,
          );
          throw new Error('deliberate rollback');
        }),
      ).rejects.toThrow('deliberate rollback');

      // Postgres discards notifications from a rolled-back transaction, so a
      // failed write can never announce itself.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(received).toHaveLength(0);
    });

    it('delivers an event once its transaction commits', async () => {
      await withTransaction(async (client) => {
        await publish(
          {
            type: 'staff.presence',
            locationId: fx.locationId,
            staffId: fx.samId,
            state: 'with_client',
          },
          client,
        );
      });

      await waitFor(() => received.length === 1);
      expect(received[0]).toMatchObject({ state: 'with_client' });
    });

    it('holds the event until commit, not before', async () => {
      let seenDuringTransaction = 0;

      await withTransaction(async (client) => {
        await publish(
          {
            type: 'staff.presence',
            locationId: fx.locationId,
            staffId: fx.samId,
            state: 'available',
          },
          client,
        );
        // Still inside the transaction: nothing should have arrived yet.
        await new Promise((resolve) => setTimeout(resolve, 200));
        seenDuringTransaction = received.length;
      });

      expect(seenDuringTransaction).toBe(0);
      await waitFor(() => received.length === 1);
    });
  });

  describe('lifecycle', () => {
    it('reports connected state', () => {
      expect(bus.connected).toBe(true);
    });

    it('is inert after stopping', async () => {
      await bus.stop();
      expect(bus.connected).toBe(false);

      await publish({
        type: 'staff.presence',
        locationId: fx.locationId,
        staffId: fx.samId,
        state: 'off',
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(received).toHaveLength(0);
    });

    it('survives being stopped twice', async () => {
      await bus.stop();
      await expect(bus.stop()).resolves.toBeUndefined();
    });
  });
});

d('realtime events from the write path', () => {
  beforeEach(async () => {
    await resetDatabase();
    fx = await createFixture();

    received = [];
    bus = new EventBus();
    await bus.start();
    bus.subscribe((event) => received.push(event));
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  afterEach(async () => {
    await bus.stop();
  });

  afterAll(async () => {
    await closePool();
  });

  const book = async (time = '10:00') => {
    const key = `rt-${Math.random()}`;
    const held = await holdSlot({
      locationId: fx.locationId,
      serviceIds: [fx.cutId],
      clientId: fx.clientA,
      start: t(time),
      staffId: fx.samId,
      sessionId: key,
      now: BEFORE,
    });
    await confirmAppointment({
      appointmentId: held.id,
      sessionId: key,
      idempotencyKey: key,
      now: BEFORE,
    });
    return held.id;
  };

  it('announces a confirmed booking, not a hold', async () => {
    const key = 'hold-only';
    await holdSlot({
      locationId: fx.locationId,
      serviceIds: [fx.cutId],
      clientId: fx.clientA,
      start: t('11:00'),
      staffId: fx.samId,
      sessionId: key,
      now: BEFORE,
    });

    // A hold is not news — it may never become a booking.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(ofType('appointment.created')).toHaveLength(0);

    await book('10:00');
    await waitFor(() => ofType('appointment.created').length === 1);

    const event = ofType('appointment.created')[0] as any;
    expect(event.staffId).toBe(fx.samId);
    expect(event.localDate).toBe(DAY);
    expect(event.clientName).toBe('Client A');
  });

  it('announces a cancellation with the freed slot', async () => {
    const appointmentId = await book('10:00');
    received.length = 0;

    await cancelAndRefill({ appointmentId, now: BEFORE });

    await waitFor(() => ofType('appointment.cancelled').length > 0);
    const event = ofType('appointment.cancelled').at(-1) as any;
    expect(event.localDate).toBe(DAY);
    expect(event.refilled).toBe(false);
  });

  it('announces a no-show', async () => {
    const appointmentId = await book('10:00');
    received.length = 0;

    await markNoShow(appointmentId);

    await waitFor(() => ofType('appointment.status').length === 1);
    expect((ofType('appointment.status')[0] as any).status).toBe('no_show');
  });

  it('announces the whole queue when someone joins', async () => {
    await joinQueueAndAnnounce({
      locationId: fx.locationId,
      serviceIds: [fx.cutId],
      guestName: 'Walk-in Dave',
      guestPhone: '+447700900500',
      now: t('10:00'),
    });

    await waitFor(() => ofType('queue.changed').length === 1);
    const event = ofType('queue.changed')[0] as any;
    // A snapshot, because one arrival re-estimates everyone behind them.
    expect(event.entries).toHaveLength(1);
    expect(event.entries[0]).toMatchObject({ position: 1, name: 'Walk-in Dave' });
  });

  it('does not announce a booking whose confirmation failed', async () => {
    const held = await holdSlot({
      locationId: fx.locationId,
      serviceIds: [fx.cutId],
      clientId: fx.clientA,
      start: t('10:00'),
      staffId: fx.samId,
      sessionId: 'mine',
      now: BEFORE,
    });

    // Wrong session: the confirm throws and its transaction rolls back.
    await expect(
      confirmAppointment({
        appointmentId: held.id,
        sessionId: 'someone-else',
        idempotencyKey: 'k',
        now: BEFORE,
      }),
    ).rejects.toThrow();

    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(ofType('appointment.created')).toHaveLength(0);
  });
});
