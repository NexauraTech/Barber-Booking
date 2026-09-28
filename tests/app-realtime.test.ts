import { describe, expect, it, vi } from 'vitest';
import {
  RealtimeClient,
  type RealtimeOptions,
  type WebSocketLike,
} from '../app/customer/src/api/realtime.js';

/** A fake socket the test drives directly. */
function fakeSocket() {
  const sent: any[] = [];
  let opened = false;

  const socket: WebSocketLike & {
    sent: any[];
    closed: boolean;
    open(): void;
    message(payload: unknown): void;
    die(): void;
  } = {
    sent,
    closed: false,
    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null,
    // A real WebSocket throws InvalidStateError on send() before OPEN, and the
    // client relies on that to defer the subscribe until the open handler.
    send: (data: string) => {
      if (!opened) throw new Error('InvalidStateError: socket is not open');
      sent.push(JSON.parse(data));
    },
    close: () => {
      socket.closed = true;
      opened = false;
    },
    open: () => {
      opened = true;
      socket.onopen?.();
    },
    message: (payload: unknown) =>
      socket.onmessage?.({ data: JSON.stringify(payload) }),
    die: () => socket.onclose?.(),
  };
  return socket;
}

function makeClient(overrides: Partial<RealtimeOptions> = {}) {
  const sockets: ReturnType<typeof fakeSocket>[] = [];
  const events: Array<{ channel: string; type: string }> = [];
  const resyncs: string[] = [];

  const client = new RealtimeClient({
    url: 'ws://test/realtime',
    onEvent: (channel, event) => events.push({ channel, type: event.type }),
    onResync: (reason) => resyncs.push(reason),
    socketFactory: () => {
      const socket = fakeSocket();
      sockets.push(socket);
      return socket;
    },
    ...overrides,
  });

  return { client, sockets, events, resyncs };
}

const event = (seq: number, type = 'availability.changed') => ({
  type: 'event',
  channel: 'shop:loc:availability:2026-10-01',
  event: { type, seq, at: '2026-09-30T10:00:00.000Z' },
});

describe('connecting', () => {
  it('opens a socket and reports status', () => {
    const statuses: string[] = [];
    const { client, sockets } = makeClient({
      onStatus: (status) => statuses.push(status),
    });

    client.connect();
    expect(sockets).toHaveLength(1);
    expect(statuses).toContain('connecting');

    sockets[0]!.open();
    expect(statuses).toContain('open');

    client.close();
  });

  it('puts the token in the url', () => {
    const urls: string[] = [];
    const client = new RealtimeClient({
      url: 'ws://test/realtime',
      token: 'tok-123',
      onEvent: () => {},
      socketFactory: (url) => {
        urls.push(url);
        return fakeSocket();
      },
    });

    client.connect();
    expect(urls[0]).toBe('ws://test/realtime?token=tok-123');
    client.close();
  });

  it('survives a socket factory that throws', () => {
    const client = new RealtimeClient({
      url: 'ws://test/realtime',
      onEvent: () => {},
      socketFactory: () => {
        throw new Error('no network');
      },
    });

    expect(() => client.connect()).not.toThrow();
    client.close();
  });
});

describe('subscriptions', () => {
  it('sends a subscribe once open', () => {
    const { client, sockets } = makeClient();
    client.connect();
    sockets[0]!.open();

    client.subscribe('shop:loc:queue');
    expect(sockets[0]!.sent).toContainEqual({
      action: 'subscribe',
      channel: 'shop:loc:queue',
    });

    client.close();
  });

  it('queues a subscription made before the socket opens', () => {
    const { client, sockets } = makeClient();
    client.connect();

    // Subscribed while still connecting.
    client.subscribe('shop:loc:queue');
    expect(sockets[0]!.sent).toHaveLength(0);

    sockets[0]!.open();
    expect(sockets[0]!.sent).toContainEqual({
      action: 'subscribe',
      channel: 'shop:loc:queue',
    });

    client.close();
  });

  it('re-sends every subscription after a reconnect', () => {
    vi.useFakeTimers();
    const { client, sockets } = makeClient();

    client.connect();
    sockets[0]!.open();
    client.subscribe('shop:loc:queue');
    client.subscribe('shop:loc:availability:2026-10-01');

    sockets[0]!.die();
    vi.advanceTimersByTime(2000);

    // A new socket starts with no subscriptions server-side, so they must all
    // be re-sent rather than assumed.
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    expect(sockets[1]!.sent.map((m) => m.channel).sort()).toEqual([
      'shop:loc:availability:2026-10-01',
      'shop:loc:queue',
    ]);

    client.close();
    vi.useRealTimers();
  });

  it('swaps the whole subscription set', () => {
    const { client, sockets } = makeClient();
    client.connect();
    sockets[0]!.open();

    client.subscribe('shop:loc:availability:2026-10-01');
    sockets[0]!.sent.length = 0;

    client.setChannels(['shop:loc:availability:2026-10-02']);

    expect(sockets[0]!.sent).toContainEqual({
      action: 'unsubscribe',
      channel: 'shop:loc:availability:2026-10-01',
    });
    expect(sockets[0]!.sent).toContainEqual({
      action: 'subscribe',
      channel: 'shop:loc:availability:2026-10-02',
    });
    expect(client.subscribedChannels).toEqual(['shop:loc:availability:2026-10-02']);

    client.close();
  });

  it('does not re-subscribe a channel it already holds', () => {
    const { client, sockets } = makeClient();
    client.connect();
    sockets[0]!.open();
    client.subscribe('shop:loc:queue');
    sockets[0]!.sent.length = 0;

    client.setChannels(['shop:loc:queue']);
    expect(sockets[0]!.sent).toHaveLength(0);

    client.close();
  });
});

describe('events', () => {
  it('delivers an event to handlers', () => {
    const { client, sockets, events } = makeClient();
    client.connect();
    sockets[0]!.open();
    sockets[0]!.message(event(1));

    expect(events).toEqual([
      { channel: 'shop:loc:availability:2026-10-01', type: 'availability.changed' },
    ]);

    client.close();
  });

  it('delivers to several registered handlers', () => {
    const { client, sockets } = makeClient();
    const seen: string[] = [];
    client.onEvent(() => seen.push('a'));
    client.onEvent(() => seen.push('b'));

    client.connect();
    sockets[0]!.open();
    sockets[0]!.message(event(1));

    expect(seen).toEqual(['a', 'b']);
    client.close();
  });

  it('stops delivering to a deregistered handler', () => {
    const { client, sockets } = makeClient();
    const seen: string[] = [];
    const off = client.onEvent(() => seen.push('a'));
    off();

    client.connect();
    sockets[0]!.open();
    sockets[0]!.message(event(1));

    expect(seen).toEqual([]);
    client.close();
  });

  it('keeps delivering when one handler throws', () => {
    const { client, sockets } = makeClient();
    const seen: string[] = [];
    client.onEvent(() => {
      throw new Error('render failed');
    });
    client.onEvent(() => seen.push('survived'));

    client.connect();
    sockets[0]!.open();
    sockets[0]!.message(event(1));

    expect(seen).toEqual(['survived']);
    client.close();
  });

  it('ignores malformed json', () => {
    const { client, sockets, events } = makeClient();
    client.connect();
    sockets[0]!.open();
    sockets[0]!.onmessage?.({ data: 'not json' });

    expect(events).toEqual([]);
    client.close();
  });

  it('ignores a frame with no event payload', () => {
    const { client, sockets, events } = makeClient();
    client.connect();
    sockets[0]!.open();
    sockets[0]!.message({ type: 'subscribed', channel: 'shop:loc:queue' });

    // A subscription ack carries a channel but is not a delivery.
    expect(events).toEqual([]);
    client.close();
  });
});

describe('detecting missed events', () => {
  it('asks for a resync on a seq gap', () => {
    const { client, sockets, resyncs } = makeClient();
    client.connect();
    sockets[0]!.open();

    sockets[0]!.message(event(1));
    sockets[0]!.message(event(5)); // 2, 3 and 4 never arrived

    expect(resyncs).toHaveLength(1);
    client.close();
  });

  it('does not ask for a resync on consecutive events', () => {
    const { client, sockets, resyncs } = makeClient();
    client.connect();
    sockets[0]!.open();

    sockets[0]!.message(event(1));
    sockets[0]!.message(event(2));
    sockets[0]!.message(event(3));

    expect(resyncs).toEqual([]);
    client.close();
  });

  it('does not ask for a resync on the very first event', () => {
    // There is no baseline to compare against yet.
    const { client, sockets, resyncs } = makeClient();
    client.connect();
    sockets[0]!.open();
    sockets[0]!.message(event(9999));

    expect(resyncs).toEqual([]);
    client.close();
  });

  it('asks for a resync when the server is ahead after a reconnect', () => {
    const { client, sockets, resyncs } = makeClient();
    client.connect();
    sockets[0]!.open();
    sockets[0]!.message(event(10));

    // Reconnected, and the server has moved on while we were away.
    sockets[0]!.message({ type: 'welcome', serverSeq: 42 });

    expect(resyncs).toHaveLength(1);
    client.close();
  });

  it('does not ask for a resync when the server is level', () => {
    const { client, sockets, resyncs } = makeClient();
    client.connect();
    sockets[0]!.open();
    sockets[0]!.message(event(10));
    sockets[0]!.message({ type: 'welcome', serverSeq: 10 });

    expect(resyncs).toEqual([]);
    client.close();
  });

  it("honours the server's own resync signal", () => {
    const { client, sockets, resyncs, events } = makeClient();
    client.connect();
    sockets[0]!.open();
    sockets[0]!.message(event(1, 'resync'));

    expect(resyncs).toHaveLength(1);
    // A resync is an instruction to refetch, not an event to apply.
    expect(events).toEqual([]);
    client.close();
  });
});

describe('reconnection', () => {
  it('reconnects after the socket closes', () => {
    vi.useFakeTimers();
    const { client, sockets } = makeClient();

    client.connect();
    sockets[0]!.open();
    sockets[0]!.die();

    vi.advanceTimersByTime(1000);
    expect(sockets.length).toBeGreaterThan(1);

    client.close();
    vi.useRealTimers();
  });

  it('backs off further on each successive failure', () => {
    vi.useFakeTimers();
    const { client, sockets } = makeClient();

    client.connect();
    for (let i = 0; i < 4; i++) {
      sockets.at(-1)!.die();
      vi.advanceTimersByTime(60_000);
    }

    // Each attempt waits longer, so a persistent outage is not hammered.
    expect(sockets.length).toBe(5);

    client.close();
    vi.useRealTimers();
  });

  it('stops reconnecting once closed', () => {
    vi.useFakeTimers();
    const { client, sockets } = makeClient();

    client.connect();
    sockets[0]!.open();
    client.close();
    sockets[0]!.die();

    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);

    vi.useRealTimers();
  });

  it('clears subscriptions on close', () => {
    const { client, sockets } = makeClient();
    client.connect();
    sockets[0]!.open();
    client.subscribe('shop:loc:queue');

    client.close();
    expect(client.subscribedChannels).toEqual([]);
  });
});

describe('connection status', () => {
  it('reports the current status immediately on subscribe', () => {
    const { client, sockets } = makeClient();
    const seen: string[] = [];

    client.connect();
    sockets[0]!.open();
    client.onStatusChange((status) => seen.push(status));

    // A late subscriber learns the state rather than waiting for a change.
    expect(seen).toEqual(['open']);
    client.close();
  });

  it('reports closing', () => {
    const { client, sockets } = makeClient();
    const seen: string[] = [];
    client.onStatusChange((status) => seen.push(status));

    client.connect();
    sockets[0]!.open();
    sockets[0]!.die();

    expect(seen).toContain('closed');
    client.close();
  });
});
