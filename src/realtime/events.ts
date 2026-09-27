/**
 * The realtime event catalogue.
 *
 * Taken straight from the event matrix in docs/research/03-realtime.md §3.1 —
 * a list of events, an audience for each, and a latency budget. Things the
 * matrix says are fine on ordinary refresh or polling (shift approvals,
 * revenue dashboards) are deliberately NOT here.
 *
 * Events are small and carry deltas, not rows. That is partly discipline and
 * partly a hard limit: they travel through Postgres `NOTIFY`, whose payload
 * ceiling is 8000 bytes.
 */

export interface EventBase {
  /** Monotonic across the deployment; clients use gaps to detect missed events. */
  seq: number;
  /** Server time, ISO 8601. */
  at: string;
  locationId: string;
}

export type RealtimeEvent = EventBase &
  (
    | {
        type: 'appointment.created';
        appointmentId: string;
        staffId: string;
        clientId: string;
        clientName: string;
        startsAt: string;
        endsAt: string;
        localDate: string;
        source: string;
      }
    | {
        type: 'appointment.cancelled';
        appointmentId: string;
        staffId: string;
        clientId: string;
        clientName: string;
        startsAt: string;
        endsAt: string;
        localDate: string;
        refilled: boolean;
      }
    | {
        type: 'appointment.status';
        appointmentId: string;
        staffId: string;
        clientId: string;
        clientName: string;
        startsAt: string;
        localDate: string;
        status: 'in_progress' | 'completed' | 'no_show';
      }
    | {
        type: 'queue.changed';
        /** Ordered snapshot; the queue is short enough to send whole. */
        entries: Array<{
          queueEntryId: string;
          position: number;
          name: string | null;
          phone: string | null;
          clientId: string | null;
          status: string;
          assignedStaffId: string | null;
          waitFromMinutes: number | null;
          waitToMinutes: number | null;
        }>;
        quotedWaitMinutes: number | null;
      }
    | {
        type: 'queue.called';
        queueEntryId: string;
        clientId: string | null;
        name: string | null;
        position: number;
      }
    | {
        type: 'waitlist.offered';
        waitlistEntryId: string;
        clientId: string;
        appointmentId: string;
        startsAt: string;
        expiresAt: string;
      }
    | {
        type: 'waitlist.resolved';
        waitlistEntryId: string;
        clientId: string;
        outcome: 'accepted' | 'expired';
      }
    | {
        type: 'checkout.completed';
        checkoutId: string;
        appointmentId: string | null;
        staffId: string | null;
        clientId: string | null;
        totalCents: number;
        currency: string;
      }
    | {
        type: 'staff.presence';
        staffId: string;
        state: 'available' | 'with_client' | 'on_break' | 'off';
      }
    | {
        /**
         * Emitted in place of a real event when its payload would not fit
         * within the NOTIFY ceiling. Tells subscribers to refetch rather than
         * silently dropping a change.
         */
        type: 'resync';
        reason: string;
        localDate?: string;
      }
  );

export type RealtimeEventType = RealtimeEvent['type'];

/** Events that carry a date, and so belong on a day-scoped channel. */
export function localDateOfEvent(event: RealtimeEvent): string | null {
  return 'localDate' in event && typeof event.localDate === 'string'
    ? event.localDate
    : null;
}

/**
 * Start times a client watching a day should treat as gone or freed.
 *
 * This is the "these start times are gone" delta the research calls for,
 * rather than shipping raw appointment rows to anyone browsing.
 */
export function slotDelta(
  event: RealtimeEvent,
): { taken: string[]; released: string[] } | null {
  switch (event.type) {
    case 'appointment.created':
      return { taken: [event.startsAt], released: [] };
    case 'appointment.cancelled':
      // A refilled slot went straight to a waitlisted client, so it is not
      // free for anyone else and must not be advertised as such.
      return event.refilled
        ? { taken: [event.startsAt], released: [] }
        : { taken: [], released: [event.startsAt] };
    case 'appointment.status':
      return event.status === 'no_show'
        ? { taken: [], released: [event.startsAt] }
        : null;
    default:
      return null;
  }
}
