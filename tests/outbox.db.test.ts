/**
 * Outbox delivery semantics: idempotent queueing, retry, and the worker loop.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../src/db/pool.js';
import { enqueue, claimDue, markSent } from '../src/notifications/outbox.js';
import {
  FailingTransport,
  RecordingTransport,
  drainOnce,
} from '../src/notifications/worker.js';
import { createFixture, resetDatabase, type Fixture } from './helpers/fixture.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const d = HAS_DB ? describe : describe.skip;

const NOW = new Date('2026-10-01T09:00:00Z');
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

let fx: Fixture;

const message = (dedupeKey: string, scheduledFor: Date) => ({
  locationId: fx.locationId,
  clientId: fx.clientA,
  address: '+447700900100',
  channel: 'sms' as const,
  template: 'reminder_24h',
  scheduledFor,
  dedupeKey,
});

d('notification outbox', () => {
  beforeEach(async () => {
    await resetDatabase();
    fx = await createFixture();
  });

  afterAll(async () => {
    await closePool();
  });

  it('queues a message', async () => {
    const queued = await enqueue(message('k1', later(10)));
    expect(queued.channel).toBe('sms');
    expect(queued.attempts).toBe(0);
  });

  it('is idempotent on the dedupe key', async () => {
    const first = await enqueue(message('k1', later(10)));
    const second = await enqueue(message('k1', later(10)));

    expect(second.id).toBe(first.id);
    const { rows } = await getPool().query(`SELECT count(*)::int AS n FROM notifications`);
    expect(rows[0].n).toBe(1);
  });

  it('claims only messages that are due', async () => {
    await enqueue(message('past', later(-5)));
    await enqueue(message('future', later(30)));

    const claimed = await claimDue(NOW);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.attempts).toBe(1);
  });

  it('does not hand the same message to two simultaneous workers', async () => {
    await enqueue(message('k1', later(-1)));

    const [a, b] = await Promise.all([claimDue(NOW), claimDue(NOW)]);
    expect(a.length + b.length).toBe(1);
  });

  it('does not re-send a message whose claim lease is still live', async () => {
    await enqueue(message('k1', later(-1)));

    // First worker claims, then dies before recording an outcome.
    expect(await claimDue(NOW)).toHaveLength(1);

    // A later poll must not pick it up while the lease holds.
    expect(await claimDue(later(1))).toEqual([]);
  });

  it('reclaims a message whose lease has lapsed', async () => {
    await enqueue(message('k1', later(-1)));
    await claimDue(NOW, 100, 60);

    // Past the 60-second lease, the abandoned message is fair game again.
    const reclaimed = await claimDue(later(5), 100, 60);
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]!.attempts).toBe(2);
  });

  it('stops claiming a message once it is sent', async () => {
    await enqueue(message('k1', later(-1)));
    const claimed = await claimDue(NOW);
    await markSent(claimed[0]!.id, NOW);

    expect(await claimDue(NOW)).toEqual([]);
  });

  describe('worker', () => {
    it('sends due messages and records them', async () => {
      await enqueue(message('k1', later(-1)));
      await enqueue(message('k2', later(-2)));

      const transport = new RecordingTransport();
      const result = await drainOnce(transport, { now: () => NOW });

      expect(result).toMatchObject({ claimed: 2, sent: 2, failed: 0, retrying: 0 });
      expect(transport.sent).toHaveLength(2);
    });

    it('leaves a failed message scheduled for another attempt', async () => {
      await enqueue(message('k1', later(-1)));

      const result = await drainOnce(new FailingTransport(), { now: () => NOW });
      expect(result).toMatchObject({ claimed: 1, sent: 0, retrying: 1 });

      const { rows } = await getPool().query(
        `SELECT status, attempts, last_error FROM notifications`,
      );
      expect(rows[0]).toMatchObject({ status: 'scheduled', attempts: 1 });
      expect(rows[0].last_error).toContain('transport unavailable');
    });

    it('parks a message after too many attempts', async () => {
      await enqueue(message('k1', later(-1)));

      // Each failure backs the next attempt off by a minute, so the clock
      // has to move for the retry to become due.
      for (let i = 0; i < 3; i++) {
        await drainOnce(new FailingTransport(), {
          now: () => later(i * 10),
          maxAttempts: 3,
        });
      }

      const { rows } = await getPool().query(`SELECT status, attempts FROM notifications`);
      expect(rows[0]).toMatchObject({ status: 'failed', attempts: 3 });
    });

    it('recovers when the transport comes back', async () => {
      await enqueue(message('k1', later(-1)));
      await drainOnce(new FailingTransport(), { now: () => NOW });

      const transport = new RecordingTransport();
      const result = await drainOnce(transport, { now: () => later(10) });

      expect(result.sent).toBe(1);
      expect(transport.sent[0]!.attempts).toBe(2);
    });

    it('lets one bad message through without blocking the batch', async () => {
      await enqueue(message('good', later(-1)));
      await enqueue(message('bad', later(-2)));

      // Fails only the message addressed to the blocked number.
      const transport = {
        sent: [] as string[],
        async send(m: { id: string; template: string }) {
          if (this.sent.length === 0) {
            this.sent.push(m.id);
            throw new Error('first one fails');
          }
          this.sent.push(m.id);
        },
      };

      const result = await drainOnce(transport, { now: () => NOW });
      expect(result.claimed).toBe(2);
      expect(result.sent).toBe(1);
      expect(result.retrying).toBe(1);
    });

    it('does nothing when the outbox is empty', async () => {
      const result = await drainOnce(new RecordingTransport(), { now: () => NOW });
      expect(result).toMatchObject({ claimed: 0, sent: 0 });
    });
  });
});
