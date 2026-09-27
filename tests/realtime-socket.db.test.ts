/**
 * WebSocket endpoint tests over a real socket on a real port.
 *
 * `inject()` cannot exercise an upgrade, so these bind a port. They are the
 * only tests in the suite that do.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import { closePool } from '../src/db/pool.js';
import { buildServer } from '../src/api/server.js';
import { publish } from '../src/realtime/bus.js';
import { channelNames } from '../src/realtime/channels.js';
import { createFixture, resetDatabase, type Fixture } from './helpers/fixture.js';
import { linkStaffToUser, makeApi, type ApiClient } from './helpers/api.js';
import { resolveInstant } from '../src/domain/localtime.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const d = HAS_DB ? describe : describe.skip;

const DAY = '2026-10-01';
const TZ = 'Europe/London';

let app: FastifyInstance;
let port: number;
let fx: Fixture;
let api: ApiClient;
const sockets: WebSocket[] = [];

/** A connected client that records every frame it receives. */
async function connect(token?: string): Promise<{
  ws: WebSocket;
  frames: any[];
  send(message: unknown): void;
  waitFor(predicate: (frames: any[]) => boolean, timeoutMs?: number): Promise<void>;
}> {
  const url = token
    ? `ws://127.0.0.1:${port}/realtime?token=${encodeURIComponent(token)}`
    : `ws://127.0.0.1:${port}/realtime`;

  const ws = new WebSocket(url);
  sockets.push(ws);
  const frames: any[] = [];

  ws.on('message', (data) => {
    frames.push(JSON.parse(data.toString()));
  });

  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });

  const waitFor = async (
    predicate: (frames: any[]) => boolean,
    timeoutMs = 3000,
  ): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate(frames)) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Timed out. Frames: ${JSON.stringify(frames)}`);
  };

  // The welcome frame proves the connection is registered server-side.
  await waitFor((f) => f.some((frame) => frame.type === 'welcome'));

  return {
    ws,
    frames,
    send: (message) => ws.send(JSON.stringify(message)),
    waitFor,
  };
}

d('realtime websocket', () => {
  beforeEach(async () => {
    await resetDatabase();
    fx = await createFixture();
    api = await makeApi();

    app = await buildServer({ rateLimitMax: 10_000, realtime: true });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    port = typeof address === 'object' && address ? address.port : 0;
  });

  afterEach(async () => {
    for (const ws of sockets.splice(0)) {
      ws.close();
    }
    await app.close();
    await api.app.close();
  });

  afterAll(async () => {
    await closePool();
  });

  describe('connecting', () => {
    it('accepts an anonymous connection', async () => {
      const client = await connect();
      const welcome = client.frames.find((f) => f.type === 'welcome');
      expect(welcome.authenticated).toBe(false);
      expect(welcome.connectionId).toBeTruthy();
    });

    it('recognises a token', async () => {
      const token = await api.login('+447700900300', 'Dave');
      const client = await connect(token);
      expect(client.frames.find((f) => f.type === 'welcome').authenticated).toBe(true);
    });

    it('treats a bad token as anonymous rather than refusing', async () => {
      // Browsing must keep working even with a stale token in storage.
      const client = await connect('not-a-real-token');
      expect(client.frames.find((f) => f.type === 'welcome').authenticated).toBe(false);
    });
  });

  describe('subscribing', () => {
    it('lets an anonymous client watch a public queue', async () => {
      const client = await connect();
      client.send({ action: 'subscribe', channel: channelNames.queue(fx.locationId) });

      await client.waitFor((f) => f.some((frame) => frame.type === 'subscribed'));
    });

    it('refuses an anonymous client the staff queue', async () => {
      const client = await connect();
      client.send({
        action: 'subscribe',
        channel: channelNames.queueStaff(fx.locationId),
      });

      await client.waitFor((f) => f.some((frame) => frame.type === 'error'));
      expect(client.frames.find((f) => f.type === 'error').error).toBe('FORBIDDEN');
    });

    it('refuses a signed-in client the staff calendar', async () => {
      const token = await api.login('+447700900300', 'Dave');
      const client = await connect(token);
      client.send({
        action: 'subscribe',
        channel: channelNames.shopDay(fx.locationId, DAY),
      });

      await client.waitFor((f) => f.some((frame) => frame.type === 'error'));
      expect(client.frames.find((f) => f.type === 'error').error).toBe('FORBIDDEN');
    });

    it('lets staff watch the staff calendar', async () => {
      const token = await api.login('+447700900001');
      await linkStaffToUser(fx.samId, '+447700900001');

      const client = await connect(token);
      client.send({
        action: 'subscribe',
        channel: channelNames.shopDay(fx.locationId, DAY),
      });

      await client.waitFor((f) => f.some((frame) => frame.type === 'subscribed'));
    });

    it('reports a malformed channel the same way as a forbidden one', async () => {
      const client = await connect();
      client.send({ action: 'subscribe', channel: 'shop:*' });

      await client.waitFor((f) => f.some((frame) => frame.type === 'error'));
      // INVALID_CHANNEL vs FORBIDDEN both mean "no", and neither reveals
      // whether the channel exists.
      expect(['INVALID_CHANNEL', 'FORBIDDEN']).toContain(
        client.frames.find((f) => f.type === 'error').error,
      );
    });

    it('unsubscribes on request', async () => {
      const client = await connect();
      const channel = channelNames.queue(fx.locationId);

      client.send({ action: 'subscribe', channel });
      await client.waitFor((f) => f.some((frame) => frame.type === 'subscribed'));

      client.send({ action: 'unsubscribe', channel });
      await client.waitFor((f) => f.some((frame) => frame.type === 'unsubscribed'));
    });

    it('caps how many channels one connection may hold', async () => {
      const client = await connect();

      // 20 valid distinct channels, then one more.
      for (let i = 0; i < 21; i++) {
        const date = `2026-11-${String(i + 1).padStart(2, '0')}`;
        client.send({
          action: 'subscribe',
          channel: channelNames.availability(fx.locationId, date),
        });
      }

      await client.waitFor((f) =>
        f.some((frame) => frame.error === 'TOO_MANY_SUBSCRIPTIONS'),
      );
    });
  });

  describe('the socket is read-only', () => {
    it('rejects an unknown action', async () => {
      const client = await connect();
      client.send({ action: 'publish', event: { type: 'appointment.created' } });

      await client.waitFor((f) => f.some((frame) => frame.type === 'error'));
      expect(client.frames.find((f) => f.type === 'error').error).toBe('UNKNOWN_ACTION');
    });

    it('rejects malformed json', async () => {
      const client = await connect();
      client.ws.send('not json at all');

      await client.waitFor((f) => f.some((frame) => frame.error === 'BAD_JSON'));
    });

    it('rejects an oversized message', async () => {
      const client = await connect();
      client.send({ action: 'subscribe', channel: 'x'.repeat(5000) });

      await client.waitFor((f) => f.some((frame) => frame.error === 'MESSAGE_TOO_LARGE'));
    });

    it('answers a ping', async () => {
      const client = await connect();
      client.send({ action: 'ping' });
      await client.waitFor((f) => f.some((frame) => frame.type === 'pong'));
    });
  });

  describe('receiving events', () => {
    it('delivers a queue change to an anonymous watcher, redacted', async () => {
      const client = await connect();
      client.send({ action: 'subscribe', channel: channelNames.queue(fx.locationId) });
      await client.waitFor((f) => f.some((frame) => frame.type === 'subscribed'));

      await publish({
        type: 'queue.changed',
        locationId: fx.locationId,
        quotedWaitMinutes: 20,
        entries: [
          {
            queueEntryId: 'q1',
            position: 1,
            name: 'Dave Sensitive',
            phone: '+447700900500',
            clientId: null,
            status: 'waiting',
            assignedStaffId: fx.samId,
            waitFromMinutes: 0,
            waitToMinutes: 5,
          },
        ],
      });

      await client.waitFor((f) => f.some((frame) => frame.type === 'event'));

      const frame = client.frames.find((f) => f.type === 'event')!;
      expect(frame.event.quotedWaitMinutes).toBe(20);
      // Redaction survives the whole path: publish -> NOTIFY -> hub -> socket.
      expect(JSON.stringify(frame)).not.toContain('Dave Sensitive');
      expect(JSON.stringify(frame)).not.toContain('447700900500');
    });

    it('delivers full detail to staff on the same underlying event', async () => {
      const token = await api.login('+447700900001');
      await linkStaffToUser(fx.samId, '+447700900001');

      const client = await connect(token);
      client.send({
        action: 'subscribe',
        channel: channelNames.queueStaff(fx.locationId),
      });
      await client.waitFor((f) => f.some((frame) => frame.type === 'subscribed'));

      await publish({
        type: 'queue.changed',
        locationId: fx.locationId,
        quotedWaitMinutes: 20,
        entries: [
          {
            queueEntryId: 'q1',
            position: 1,
            name: 'Dave Sensitive',
            phone: '+447700900500',
            clientId: null,
            status: 'waiting',
            assignedStaffId: fx.samId,
            waitFromMinutes: 0,
            waitToMinutes: 5,
          },
        ],
      });

      await client.waitFor((f) => f.some((frame) => frame.type === 'event'));
      expect(JSON.stringify(client.frames)).toContain('Dave Sensitive');
    });

    it('does not deliver a channel the connection never subscribed to', async () => {
      const client = await connect();
      // Subscribed to nothing at all.
      await publish({
        type: 'staff.presence',
        locationId: fx.locationId,
        staffId: fx.samId,
        state: 'available',
      });

      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(client.frames.filter((f) => f.type === 'event')).toHaveLength(0);
    });

    it('carries a seq on every frame so gaps are detectable', async () => {
      const client = await connect();
      client.send({ action: 'subscribe', channel: channelNames.queue(fx.locationId) });
      await client.waitFor((f) => f.some((frame) => frame.type === 'subscribed'));

      for (const wait of [10, 20]) {
        await publish({
          type: 'queue.changed',
          locationId: fx.locationId,
          quotedWaitMinutes: wait,
          entries: [],
        });
      }

      await client.waitFor((f) => f.filter((frame) => frame.type === 'event').length === 2);
      const seqs = client.frames.filter((f) => f.type === 'event').map((f) => f.event.seq);
      expect(seqs[1]).toBeGreaterThan(seqs[0]);
    });

    it('stops delivering after the client disconnects', async () => {
      const client = await connect();
      client.send({ action: 'subscribe', channel: channelNames.queue(fx.locationId) });
      await client.waitFor((f) => f.some((frame) => frame.type === 'subscribed'));

      const hub = app.realtimeHub!;
      expect(hub.channelCount(channelNames.queue(fx.locationId))).toBe(1);

      client.ws.close();
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(hub.channelCount(channelNames.queue(fx.locationId))).toBe(0);
    });
  });

  describe('end to end', () => {
    it('pushes an availability delta to a client watching a day', async () => {
      const watcher = await connect();
      watcher.send({
        action: 'subscribe',
        channel: channelNames.availability(fx.locationId, DAY),
      });
      await watcher.waitFor((f) => f.some((frame) => frame.type === 'subscribed'));

      // A different client books through the HTTP API.
      const token = await api.login('+447700900300', 'Dave');
      const start = new Date(resolveInstant(DAY, '10:00', TZ)).toISOString();
      const held = await api.post(
        '/appointments/hold',
        {
          locationId: fx.locationId,
          serviceIds: [fx.cutId],
          start,
          staffId: fx.samId,
        },
        token,
      );
      expect(held.status).toBe(201);

      await api.post(`/appointments/${held.body.appointmentId}/confirm`, {}, token, {
        'idempotency-key': 'ws-e2e',
      });

      await watcher.waitFor((f) => f.some((frame) => frame.type === 'event'));

      const frame = watcher.frames.find((f) => f.type === 'event')!;
      expect(frame.event.type).toBe('availability.changed');
      expect(frame.event.taken).toEqual([start]);
      // The watcher learns a slot went, and nothing about who took it.
      expect(JSON.stringify(frame)).not.toContain('Dave');
    });
  });
});
