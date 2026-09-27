/**
 * Channel routing, authorisation and redaction.
 *
 * Three rules from docs/research/03-realtime.md §3.2, all enforced here:
 *
 *   1. **Channels are narrow.** Scoped to one shop, usually one day. Nobody
 *      subscribes to a table.
 *
 *   2. **Never broadcast client PII on a channel a client can join.** The queue
 *      channel a waiting customer subscribes to carries positions and ETAs;
 *      names and phone numbers live on a separate staff channel. An event is
 *      published once and PROJECTED per channel, so redaction cannot be
 *      forgotten at a call site.
 *
 *   3. **Authorise every subscription**, against role and shop membership.
 *
 * Pure: no database, no sockets.
 */
import type { RealtimeEvent } from './events.js';
import { slotDelta } from './events.js';
import type { StaffMembership } from '../auth/service.js';

export type ChannelKind =
  /** Staff calendar for one shop-day. Carries client names. */
  | 'shop_day'
  /** Public slot deltas for one shop-day. No identities at all. */
  | 'availability'
  /** Public queue view: positions and waits only. */
  | 'queue'
  /** Staff queue view: full detail. */
  | 'queue_staff'
  /** One barber's own day. */
  | 'staff_day'
  /** One client's own bookings and offers. */
  | 'client'
  /** Who is clocked in and what they are doing. */
  | 'presence';

export interface Channel {
  kind: ChannelKind;
  name: string;
  locationId?: string;
  staffId?: string;
  clientId?: string;
  localDate?: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parse a channel name, rejecting anything malformed.
 *
 * Channel names arrive from clients, so this is an input boundary: a name that
 * does not parse is never treated as a wildcard or a partial match.
 */
export function parseChannel(name: string): Channel | null {
  const parts = name.split(':');

  if (parts[0] === 'shop' && parts[1] && UUID.test(parts[1])) {
    const locationId = parts[1];

    if (parts[2] === 'day' && parts[3] && DATE.test(parts[3]) && parts.length === 4) {
      return { kind: 'shop_day', name, locationId, localDate: parts[3] };
    }
    if (parts[2] === 'availability' && parts[3] && DATE.test(parts[3]) && parts.length === 4) {
      return { kind: 'availability', name, locationId, localDate: parts[3] };
    }
    if (parts[2] === 'queue' && parts.length === 3) {
      return { kind: 'queue', name, locationId };
    }
    if (parts[2] === 'queue' && parts[3] === 'staff' && parts.length === 4) {
      return { kind: 'queue_staff', name, locationId };
    }
    if (parts[2] === 'presence' && parts.length === 3) {
      return { kind: 'presence', name, locationId };
    }
    return null;
  }

  if (parts[0] === 'staff' && parts[1] && UUID.test(parts[1])) {
    if (parts[2] === 'day' && parts[3] && DATE.test(parts[3]) && parts.length === 4) {
      return { kind: 'staff_day', name, staffId: parts[1], localDate: parts[3] };
    }
    return null;
  }

  if (parts[0] === 'client' && parts[1] && UUID.test(parts[1]) && parts.length === 2) {
    return { kind: 'client', name, clientId: parts[1] };
  }

  return null;
}

export const channelNames = {
  shopDay: (locationId: string, localDate: string) => `shop:${locationId}:day:${localDate}`,
  availability: (locationId: string, localDate: string) =>
    `shop:${locationId}:availability:${localDate}`,
  queue: (locationId: string) => `shop:${locationId}:queue`,
  queueStaff: (locationId: string) => `shop:${locationId}:queue:staff`,
  staffDay: (staffId: string, localDate: string) => `staff:${staffId}:day:${localDate}`,
  client: (clientId: string) => `client:${clientId}`,
  presence: (locationId: string) => `shop:${locationId}:presence`,
};

/**
 * Channels an event should reach.
 *
 * One publish, many channels — each of which projects the event down to what
 * that audience may see.
 */
export function channelsForEvent(event: RealtimeEvent): string[] {
  const out: string[] = [];
  const date = 'localDate' in event ? event.localDate : undefined;

  switch (event.type) {
    case 'appointment.created':
    case 'appointment.cancelled':
    case 'appointment.status':
      if (date) {
        out.push(channelNames.shopDay(event.locationId, date));
        out.push(channelNames.availability(event.locationId, date));
        out.push(channelNames.staffDay(event.staffId, date));
      }
      out.push(channelNames.client(event.clientId));
      break;

    case 'queue.changed':
      out.push(channelNames.queue(event.locationId));
      out.push(channelNames.queueStaff(event.locationId));
      break;

    case 'queue.called':
      out.push(channelNames.queueStaff(event.locationId));
      if (event.clientId) out.push(channelNames.client(event.clientId));
      break;

    case 'waitlist.offered':
    case 'waitlist.resolved':
      out.push(channelNames.client(event.clientId));
      out.push(channelNames.queueStaff(event.locationId));
      break;

    case 'checkout.completed':
      if (event.staffId) {
        out.push(channelNames.presence(event.locationId));
      }
      out.push(channelNames.queueStaff(event.locationId));
      break;

    case 'staff.presence':
      out.push(channelNames.presence(event.locationId));
      break;

    case 'resync':
      // A resync goes everywhere it could matter; subscribers refetch.
      if (event.localDate) {
        out.push(channelNames.shopDay(event.locationId, event.localDate));
        out.push(channelNames.availability(event.locationId, event.localDate));
      }
      out.push(channelNames.queue(event.locationId));
      out.push(channelNames.queueStaff(event.locationId));
      break;
  }

  return [...new Set(out)];
}

export interface Viewer {
  userId: string;
  memberships: readonly StaffMembership[];
  /** Client record ids this user owns, one per organisation. */
  clientIds: readonly string[];
}

const FINANCIAL: Array<StaffMembership['role']> = ['owner', 'manager'];

/**
 * May this viewer subscribe to this channel?
 *
 * Denials are deliberately uniform: "not staff here" and "staff without the
 * role" are indistinguishable to the caller, so neither reveals the shop's
 * structure.
 */
export function canSubscribe(channel: Channel, viewer: Viewer | null): boolean {
  switch (channel.kind) {
    // Public: browsing a day's availability and watching a queue position are
    // both things a walk-in client does with no account at all.
    case 'availability':
    case 'queue':
      return true;

    case 'shop_day':
    case 'queue_staff':
    case 'presence':
      return Boolean(
        viewer?.memberships.some((m) => m.locationId === channel.locationId),
      );

    case 'staff_day': {
      if (!viewer) return false;
      const own = viewer.memberships.find((m) => m.staffId === channel.staffId);
      if (own) return true;
      // A manager may watch a colleague's column; a barber may not.
      const managed = viewer.memberships.some((m) => FINANCIAL.includes(m.role));
      return managed;
    }

    case 'client':
      return Boolean(viewer?.clientIds.includes(channel.clientId!));
  }
}

/**
 * Reduce an event to what a given channel's audience may see.
 *
 * Returning null means "this event says nothing to this channel" — used for an
 * appointment status change that moves no slot, so availability watchers are
 * not woken for nothing.
 *
 * This is the single place redaction happens. A publisher cannot leak a name
 * onto a public channel by forgetting to strip it, because it never chooses
 * the payload per channel.
 */
export function projectForChannel(
  event: RealtimeEvent,
  kind: ChannelKind,
): Record<string, unknown> | null {
  const base = { type: event.type, seq: event.seq, at: event.at };

  switch (kind) {
    // Public. Identities never appear here — only which start times moved.
    case 'availability': {
      if (event.type === 'resync') {
        return { ...base, localDate: event.localDate };
      }
      const delta = slotDelta(event);
      if (!delta || (delta.taken.length === 0 && delta.released.length === 0)) {
        return null;
      }
      return {
        ...base,
        type: 'availability.changed',
        localDate: 'localDate' in event ? event.localDate : undefined,
        taken: delta.taken,
        released: delta.released,
      };
    }

    // Public. Positions and waits, never names or numbers — a waiting client
    // can join this channel.
    case 'queue': {
      if (event.type === 'queue.changed') {
        return {
          ...base,
          quotedWaitMinutes: event.quotedWaitMinutes,
          entries: event.entries.map((entry) => ({
            queueEntryId: entry.queueEntryId,
            position: entry.position,
            status: entry.status,
            waitFromMinutes: entry.waitFromMinutes,
            waitToMinutes: entry.waitToMinutes,
          })),
        };
      }
      if (event.type === 'resync') return { ...base, reason: event.reason };
      return null;
    }

    // Staff-side. Full detail, including contact details.
    case 'queue_staff':
    case 'shop_day':
    case 'staff_day':
    case 'presence':
      return { ...event };

    // The client's own record. Their own details are theirs to see, but
    // nothing about anyone else's.
    case 'client': {
      switch (event.type) {
        case 'appointment.created':
        case 'appointment.cancelled':
        case 'appointment.status':
          return {
            ...base,
            appointmentId: event.appointmentId,
            staffId: event.staffId,
            startsAt: event.startsAt,
            ...(event.type === 'appointment.status' ? { status: event.status } : {}),
          };
        case 'queue.called':
          return { ...base, queueEntryId: event.queueEntryId, position: event.position };
        case 'waitlist.offered':
          return {
            ...base,
            waitlistEntryId: event.waitlistEntryId,
            appointmentId: event.appointmentId,
            startsAt: event.startsAt,
            expiresAt: event.expiresAt,
          };
        case 'waitlist.resolved':
          return {
            ...base,
            waitlistEntryId: event.waitlistEntryId,
            outcome: event.outcome,
          };
        default:
          return null;
      }
    }
  }
}
