import { describe, expect, it } from 'vitest';
import {
  type Viewer,
  canSubscribe,
  channelNames,
  channelsForEvent,
  parseChannel,
  projectForChannel,
} from '../src/realtime/channels.js';
import { slotDelta } from '../src/realtime/events.js';
import type { RealtimeEvent } from '../src/realtime/events.js';

const LOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_LOC = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const STAFF = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_STAFF = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CLIENT = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const DATE = '2026-10-01';

const viewer = (over: Partial<Viewer> = {}): Viewer => ({
  userId: 'user-1',
  memberships: [],
  clientIds: [],
  ...over,
});

const barberAt = (locationId = LOC, staffId = STAFF) =>
  viewer({ memberships: [{ staffId, locationId, role: 'barber' }] });

const ownerAt = (locationId = LOC, staffId = STAFF) =>
  viewer({ memberships: [{ staffId, locationId, role: 'owner' }] });

const appointmentCreated: RealtimeEvent = {
  type: 'appointment.created',
  seq: 1,
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

const queueChanged: RealtimeEvent = {
  type: 'queue.changed',
  seq: 2,
  at: '2026-09-30T10:00:00.000Z',
  locationId: LOC,
  quotedWaitMinutes: 35,
  entries: [
    {
      queueEntryId: 'q1',
      position: 1,
      name: 'Dave Sensitive',
      phone: '+447700900500',
      clientId: null,
      status: 'waiting',
      assignedStaffId: STAFF,
      waitFromMinutes: 0,
      waitToMinutes: 5,
    },
  ],
};

describe('parseChannel', () => {
  it('parses every channel shape', () => {
    expect(parseChannel(channelNames.shopDay(LOC, DATE))?.kind).toBe('shop_day');
    expect(parseChannel(channelNames.availability(LOC, DATE))?.kind).toBe('availability');
    expect(parseChannel(channelNames.queue(LOC))?.kind).toBe('queue');
    expect(parseChannel(channelNames.queueStaff(LOC))?.kind).toBe('queue_staff');
    expect(parseChannel(channelNames.staffDay(STAFF, DATE))?.kind).toBe('staff_day');
    expect(parseChannel(channelNames.client(CLIENT))?.kind).toBe('client');
    expect(parseChannel(channelNames.presence(LOC))?.kind).toBe('presence');
  });

  it('extracts the parts', () => {
    const channel = parseChannel(channelNames.shopDay(LOC, DATE))!;
    expect(channel.locationId).toBe(LOC);
    expect(channel.localDate).toBe(DATE);
  });

  it('rejects a non-uuid id', () => {
    expect(parseChannel('shop:not-a-uuid:queue')).toBeNull();
    expect(parseChannel('client:12345')).toBeNull();
  });

  it('rejects a malformed date', () => {
    expect(parseChannel(`shop:${LOC}:day:2026-1-1`)).toBeNull();
    expect(parseChannel(`shop:${LOC}:day:tomorrow`)).toBeNull();
  });

  it('rejects trailing or missing segments rather than matching loosely', () => {
    expect(parseChannel(`shop:${LOC}:queue:staff:extra`)).toBeNull();
    expect(parseChannel(`shop:${LOC}`)).toBeNull();
    expect(parseChannel(`shop:${LOC}:day`)).toBeNull();
    expect(parseChannel(`client:${CLIENT}:extra`)).toBeNull();
  });

  it('rejects anything it does not recognise, with no wildcards', () => {
    expect(parseChannel('*')).toBeNull();
    expect(parseChannel('')).toBeNull();
    expect(parseChannel(`shop:${LOC}:*`)).toBeNull();
    expect(parseChannel('admin')).toBeNull();
  });
});

describe('canSubscribe', () => {
  describe('public channels', () => {
    it('lets anonymous viewers watch availability and the queue', () => {
      const anon = null;
      expect(canSubscribe(parseChannel(channelNames.availability(LOC, DATE))!, anon)).toBe(true);
      expect(canSubscribe(parseChannel(channelNames.queue(LOC))!, anon)).toBe(true);
    });
  });

  describe('staff channels', () => {
    it('admits staff at that location', () => {
      const channel = parseChannel(channelNames.shopDay(LOC, DATE))!;
      expect(canSubscribe(channel, barberAt())).toBe(true);
    });

    it('refuses staff from a different shop', () => {
      const channel = parseChannel(channelNames.shopDay(LOC, DATE))!;
      expect(canSubscribe(channel, barberAt(OTHER_LOC))).toBe(false);
    });

    it('refuses a signed-in client with no staff role', () => {
      const channel = parseChannel(channelNames.shopDay(LOC, DATE))!;
      expect(canSubscribe(channel, viewer({ clientIds: [CLIENT] }))).toBe(false);
    });

    it('refuses anonymous viewers', () => {
      for (const name of [
        channelNames.shopDay(LOC, DATE),
        channelNames.queueStaff(LOC),
        channelNames.presence(LOC),
      ]) {
        expect(canSubscribe(parseChannel(name)!, null)).toBe(false);
      }
    });
  });

  describe('a barber\'s own column', () => {
    it('admits the barber themselves', () => {
      const channel = parseChannel(channelNames.staffDay(STAFF, DATE))!;
      expect(canSubscribe(channel, barberAt(LOC, STAFF))).toBe(true);
    });

    it('refuses a barber watching a colleague', () => {
      const channel = parseChannel(channelNames.staffDay(OTHER_STAFF, DATE))!;
      expect(canSubscribe(channel, barberAt(LOC, STAFF))).toBe(false);
    });

    it('admits a manager watching a colleague', () => {
      const channel = parseChannel(channelNames.staffDay(OTHER_STAFF, DATE))!;
      expect(canSubscribe(channel, ownerAt(LOC, STAFF))).toBe(true);
    });
  });

  describe('a client\'s own channel', () => {
    it('admits the owner of the record', () => {
      const channel = parseChannel(channelNames.client(CLIENT))!;
      expect(canSubscribe(channel, viewer({ clientIds: [CLIENT] }))).toBe(true);
    });

    it("refuses someone else's client channel", () => {
      const channel = parseChannel(channelNames.client(CLIENT))!;
      expect(canSubscribe(channel, viewer({ clientIds: ['other-id'] }))).toBe(false);
    });

    it('refuses staff snooping on a client channel they do not own', () => {
      // Staff read client detail on the shop channel, not by impersonating one.
      const channel = parseChannel(channelNames.client(CLIENT))!;
      expect(canSubscribe(channel, barberAt())).toBe(false);
    });

    it('refuses anonymous viewers', () => {
      expect(canSubscribe(parseChannel(channelNames.client(CLIENT))!, null)).toBe(false);
    });
  });
});

describe('channelsForEvent', () => {
  it('routes an appointment to the shop day, availability, barber and client', () => {
    expect(channelsForEvent(appointmentCreated).sort()).toEqual(
      [
        channelNames.shopDay(LOC, DATE),
        channelNames.availability(LOC, DATE),
        channelNames.staffDay(STAFF, DATE),
        channelNames.client(CLIENT),
      ].sort(),
    );
  });

  it('routes a queue change to both the public and staff queue channels', () => {
    expect(channelsForEvent(queueChanged).sort()).toEqual(
      [channelNames.queue(LOC), channelNames.queueStaff(LOC)].sort(),
    );
  });

  it('routes a waitlist offer to the client and the staff queue', () => {
    const event: RealtimeEvent = {
      type: 'waitlist.offered',
      seq: 3,
      at: '2026-09-30T10:00:00.000Z',
      locationId: LOC,
      waitlistEntryId: 'w1',
      clientId: CLIENT,
      appointmentId: 'appt-2',
      startsAt: '2026-10-01T09:00:00.000Z',
      expiresAt: '2026-09-30T10:15:00.000Z',
    };
    expect(channelsForEvent(event)).toContain(channelNames.client(CLIENT));
    expect(channelsForEvent(event)).toContain(channelNames.queueStaff(LOC));
  });

  it('never duplicates a channel', () => {
    const channels = channelsForEvent(appointmentCreated);
    expect(new Set(channels).size).toBe(channels.length);
  });
});

describe('projectForChannel — redaction', () => {
  it('strips names and phone numbers from the public queue channel', () => {
    const payload = projectForChannel(queueChanged, 'queue')!;
    const serialised = JSON.stringify(payload);

    expect(serialised).not.toContain('Dave Sensitive');
    expect(serialised).not.toContain('447700900500');
    // But the useful part survives.
    expect(payload.quotedWaitMinutes).toBe(35);
    expect((payload.entries as any[])[0]).toMatchObject({ position: 1, status: 'waiting' });
  });

  it('keeps names and numbers on the staff queue channel', () => {
    const serialised = JSON.stringify(projectForChannel(queueChanged, 'queue_staff'));
    expect(serialised).toContain('Dave Sensitive');
    expect(serialised).toContain('447700900500');
  });

  it('reduces an appointment to a slot delta on the availability channel', () => {
    const payload = projectForChannel(appointmentCreated, 'availability')!;
    const serialised = JSON.stringify(payload);

    // No identity of any kind reaches a channel anyone can join.
    expect(serialised).not.toContain('Dave Sensitive');
    expect(serialised).not.toContain(CLIENT);
    expect(serialised).not.toContain('appt-1');

    expect(payload.type).toBe('availability.changed');
    expect(payload.taken).toEqual(['2026-10-01T09:00:00.000Z']);
    expect(payload.released).toEqual([]);
  });

  it("gives a client their own appointment without anyone else's detail", () => {
    const payload = projectForChannel(appointmentCreated, 'client')!;
    expect(payload).toMatchObject({
      appointmentId: 'appt-1',
      staffId: STAFF,
      startsAt: '2026-10-01T09:00:00.000Z',
    });
    // Their own name is redundant here and the source is shop internals.
    expect(payload).not.toHaveProperty('clientName');
    expect(payload).not.toHaveProperty('source');
  });

  it('passes full detail to the staff calendar', () => {
    const payload = projectForChannel(appointmentCreated, 'shop_day')!;
    expect(payload.clientName).toBe('Dave Sensitive');
  });

  it('says nothing to availability watchers when no slot moved', () => {
    const started: RealtimeEvent = {
      type: 'appointment.status',
      seq: 4,
      at: '2026-09-30T10:00:00.000Z',
      locationId: LOC,
      appointmentId: 'appt-1',
      staffId: STAFF,
      clientId: CLIENT,
      clientName: 'Dave',
      startsAt: '2026-10-01T09:00:00.000Z',
      localDate: DATE,
      status: 'in_progress',
    };
    // Starting a cut frees nothing, so browsers are not woken for it.
    expect(projectForChannel(started, 'availability')).toBeNull();
  });

  it('says nothing to the public queue channel about a called client', () => {
    const called: RealtimeEvent = {
      type: 'queue.called',
      seq: 5,
      at: '2026-09-30T10:00:00.000Z',
      locationId: LOC,
      queueEntryId: 'q1',
      clientId: CLIENT,
      name: 'Dave Sensitive',
      position: 1,
    };
    // Who got called is nobody else's business.
    expect(projectForChannel(called, 'queue')).toBeNull();
  });

  it('always carries seq and at, so gaps are detectable', () => {
    for (const kind of ['shop_day', 'queue', 'queue_staff', 'client'] as const) {
      const payload = projectForChannel(
        kind === 'queue' || kind === 'queue_staff' ? queueChanged : appointmentCreated,
        kind,
      );
      expect(payload).toMatchObject({ seq: expect.any(Number), at: expect.any(String) });
    }
  });
});

describe('slotDelta', () => {
  it('marks a created booking as taken', () => {
    expect(slotDelta(appointmentCreated)).toEqual({
      taken: ['2026-10-01T09:00:00.000Z'],
      released: [],
    });
  });

  it('releases a cancelled slot nobody took', () => {
    const cancelled: RealtimeEvent = {
      ...appointmentCreated,
      type: 'appointment.cancelled',
      refilled: false,
    } as RealtimeEvent;
    expect(slotDelta(cancelled)).toEqual({
      taken: [],
      released: ['2026-10-01T09:00:00.000Z'],
    });
  });

  it('does not advertise a cancelled slot the waitlist already took', () => {
    const refilled: RealtimeEvent = {
      ...appointmentCreated,
      type: 'appointment.cancelled',
      refilled: true,
    } as RealtimeEvent;
    // Telling browsers it is free would send them at a slot already gone.
    expect(slotDelta(refilled)).toEqual({
      taken: ['2026-10-01T09:00:00.000Z'],
      released: [],
    });
  });

  it('releases a no-showed slot', () => {
    const noShow: RealtimeEvent = {
      type: 'appointment.status',
      seq: 6,
      at: '2026-09-30T10:00:00.000Z',
      locationId: LOC,
      appointmentId: 'appt-1',
      staffId: STAFF,
      clientId: CLIENT,
      clientName: 'Dave',
      startsAt: '2026-10-01T09:00:00.000Z',
      localDate: DATE,
      status: 'no_show',
    };
    expect(slotDelta(noShow)?.released).toEqual(['2026-10-01T09:00:00.000Z']);
  });

  it('is null for events that move no slot', () => {
    expect(slotDelta(queueChanged)).toBeNull();
  });
});
