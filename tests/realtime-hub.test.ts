import { describe, expect, it, vi } from 'vitest';
import { Hub, type Socket } from '../src/realtime/hub.js';
import { channelNames, type Viewer } from '../src/realtime/channels.js';
import type { RealtimeEvent } from '../src/realtime/events.js';

const LOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const STAFF = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CLIENT = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const DATE = '2026-10-01';

/** A socket that records what it was sent. */
function fakeSocket() {
  const sent: any[] = [];
  const socket: Socket & { sent: any[]; closed: boolean } = {
    sent,
    closed: false,
    send: (data: string) => sent.push(JSON.parse(data)),
    close: () => {
      socket.closed = true;
    },
  };
  return socket;
}

const barber: Viewer = {
  userId: 'u1',
  memberships: [{ staffId: STAFF, locationId: LOC, role: 'barber' }],
  clientIds: [],
};

const client: Viewer = { userId: 'u2', memberships: [], clientIds: [CLIENT] };

const appointmentEvent: RealtimeEvent = {
  type: 'appointment.created',
  seq: 10,
  at: '2026-09-30T10:00:00.000Z',
  locationId: LOC,
  appointmentId: 'appt-1',
  staffId: STAFF,
  clientId: CLIENT,
  clientName: 'Dave Sensitive',
  startsAt: '2026-10-01T09:00:00.000Z',
  endsAt: '2026-10-01T09:35:00.000Z',
  localDate: DATE,
  source: 'online',
};

describe('Hub subscription', () => {
  it('admits an authorised subscription', () => {
    const hub = new Hub();
    const socket = fakeSocket();
    const connection = hub.add(socket, barber);

    const result = hub.subscribe(connection.id, channelNames.shopDay(LOC, DATE));
    expect(result.ok).toBe(true);
    expect(hub.channelCount(channelNames.shopDay(LOC, DATE))).toBe(1);
  });

  it('refuses an unauthorised subscription', () => {
    const hub = new Hub();
    const connection = hub.add(fakeSocket(), client);

    const result = hub.subscribe(connection.id, channelNames.shopDay(LOC, DATE));
    expect(result).toEqual({ ok: false, reason: 'forbidden' });
    expect(hub.channelCount(channelNames.shopDay(LOC, DATE))).toBe(0);
  });

  it('refuses a malformed channel name', () => {
    const hub = new Hub();
    const connection = hub.add(fakeSocket(), barber);
    expect(hub.subscribe(connection.id, 'shop:*')).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('lets anonymous connections watch public channels only', () => {
    const hub = new Hub();
    const connection = hub.add(fakeSocket(), null);

    expect(hub.subscribe(connection.id, channelNames.queue(LOC)).ok).toBe(true);
    expect(hub.subscribe(connection.id, channelNames.queueStaff(LOC)).ok).toBe(false);
  });

  it('unsubscribes cleanly', () => {
    const hub = new Hub();
    const connection = hub.add(fakeSocket(), barber);
    const channel = channelNames.shopDay(LOC, DATE);

    hub.subscribe(connection.id, channel);
    hub.unsubscribe(connection.id, channel);
    expect(hub.channelCount(channel)).toBe(0);
  });

  it('drops all subscriptions when a connection goes', () => {
    const hub = new Hub();
    const connection = hub.add(fakeSocket(), barber);
    hub.subscribe(connection.id, channelNames.shopDay(LOC, DATE));
    hub.subscribe(connection.id, channelNames.queueStaff(LOC));

    hub.remove(connection.id);

    expect(hub.connectionCount).toBe(0);
    expect(hub.channelCount(channelNames.shopDay(LOC, DATE))).toBe(0);
    expect(hub.channelCount(channelNames.queueStaff(LOC))).toBe(0);
  });

  it('ignores a subscribe from an unknown connection', () => {
    const hub = new Hub();
    expect(hub.subscribe('nope', channelNames.queue(LOC)).ok).toBe(false);
  });
});

describe('Hub dispatch', () => {
  it('delivers to subscribers of a channel the event belongs on', () => {
    const hub = new Hub();
    const socket = fakeSocket();
    const connection = hub.add(socket, barber);
    hub.subscribe(connection.id, channelNames.shopDay(LOC, DATE));

    hub.dispatch(appointmentEvent);

    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0].type).toBe('event');
    expect(socket.sent[0].channel).toBe(channelNames.shopDay(LOC, DATE));
    expect(socket.sent[0].event.clientName).toBe('Dave Sensitive');
  });

  it('does not deliver to a connection subscribed elsewhere', () => {
    const hub = new Hub();
    const socket = fakeSocket();
    const connection = hub.add(socket, barber);
    hub.subscribe(connection.id, channelNames.shopDay(LOC, '2026-10-02'));

    hub.dispatch(appointmentEvent);
    expect(socket.sent).toHaveLength(0);
  });

  it('redacts per channel, so two subscribers see different payloads', () => {
    const hub = new Hub();

    const staffSocket = fakeSocket();
    const staffConnection = hub.add(staffSocket, barber);
    hub.subscribe(staffConnection.id, channelNames.shopDay(LOC, DATE));

    const publicSocket = fakeSocket();
    const publicConnection = hub.add(publicSocket, null);
    hub.subscribe(publicConnection.id, channelNames.availability(LOC, DATE));

    hub.dispatch(appointmentEvent);

    expect(JSON.stringify(staffSocket.sent)).toContain('Dave Sensitive');
    // Same event, same dispatch — the anonymous watcher gets a bare delta.
    expect(JSON.stringify(publicSocket.sent)).not.toContain('Dave Sensitive');
    expect(publicSocket.sent[0].event.taken).toEqual(['2026-10-01T09:00:00.000Z']);
  });

  it('delivers once per subscribed channel', () => {
    const hub = new Hub();
    const socket = fakeSocket();
    const connection = hub.add(socket, barber);
    hub.subscribe(connection.id, channelNames.shopDay(LOC, DATE));
    hub.subscribe(connection.id, channelNames.staffDay(STAFF, DATE));

    hub.dispatch(appointmentEvent);

    // Two channels, two labelled frames — the calendar and the barber's own
    // column are different consumers even inside one app.
    expect(socket.sent).toHaveLength(2);
    expect(socket.sent.map((f) => f.channel).sort()).toEqual(
      [channelNames.shopDay(LOC, DATE), channelNames.staffDay(STAFF, DATE)].sort(),
    );
  });

  it('skips a channel the event says nothing to', () => {
    const hub = new Hub();
    const socket = fakeSocket();
    const connection = hub.add(socket, null);
    hub.subscribe(connection.id, channelNames.availability(LOC, DATE));

    hub.dispatch({
      type: 'appointment.status',
      seq: 11,
      at: '2026-09-30T10:00:00.000Z',
      locationId: LOC,
      appointmentId: 'appt-1',
      staffId: STAFF,
      clientId: CLIENT,
      clientName: 'Dave',
      startsAt: '2026-10-01T09:00:00.000Z',
      localDate: DATE,
      status: 'in_progress',
    });

    expect(socket.sent).toHaveLength(0);
  });

  it('tracks the highest seq delivered', () => {
    const hub = new Hub();
    const connection = hub.add(fakeSocket(), barber);
    hub.subscribe(connection.id, channelNames.shopDay(LOC, DATE));

    hub.dispatch(appointmentEvent);
    expect(connection.lastSeq).toBe(10);
  });

  it('drops a socket that throws, without blocking the others', () => {
    const hub = new Hub();

    const broken: Socket = {
      send: () => {
        throw new Error('socket is gone');
      },
      close: () => {},
    };
    const brokenConnection = hub.add(broken, barber);
    hub.subscribe(brokenConnection.id, channelNames.shopDay(LOC, DATE));

    const healthy = fakeSocket();
    const healthyConnection = hub.add(healthy, barber);
    hub.subscribe(healthyConnection.id, channelNames.shopDay(LOC, DATE));

    hub.dispatch(appointmentEvent);

    expect(healthy.sent).toHaveLength(1);
    expect(hub.connectionCount).toBe(1);
  });

  it('is a no-op when nobody is listening', () => {
    const hub = new Hub();
    expect(() => hub.dispatch(appointmentEvent)).not.toThrow();
  });

  it('closes every connection on shutdown', () => {
    const hub = new Hub();
    const a = fakeSocket();
    const b = fakeSocket();
    hub.add(a, barber);
    hub.add(b, null);

    hub.closeAll();

    expect(a.closed).toBe(true);
    expect(b.closed).toBe(true);
    expect(hub.connectionCount).toBe(0);
  });
});

describe('Hub bus wiring', () => {
  it('dispatches events the bus emits', () => {
    const hub = new Hub();
    let emit: ((event: RealtimeEvent) => void) | undefined;

    const fakeBus = {
      subscribe: (listener: (event: RealtimeEvent) => void) => {
        emit = listener;
        return () => {};
      },
    };
    hub.attach(fakeBus as never);

    const socket = fakeSocket();
    const connection = hub.add(socket, barber);
    hub.subscribe(connection.id, channelNames.shopDay(LOC, DATE));

    emit!(appointmentEvent);
    expect(socket.sent).toHaveLength(1);
  });

  it('stops dispatching once detached', () => {
    const hub = new Hub();
    const unsubscribe = vi.fn();
    hub.attach({ subscribe: () => unsubscribe } as never);
    hub.detach();
    expect(unsubscribe).toHaveBeenCalled();
  });
});
