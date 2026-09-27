/**
 * The availability engine.
 *
 * Free slots are COMPUTED from facts (shifts, services, bookings, resources),
 * never stored as rows. A `slots` table with an `available` boolean breaks the
 * moment two services have different lengths, because a 45-minute booking at
 * 10:00 must invalidate the 10:15 and 10:30 rows too.
 * See docs/research/02-scheduling-engine.md §2.1.
 *
 * This module is pure: it takes resolved inputs and returns slots. Loading
 * those inputs from Postgres is src/db/availability-repo.ts, which keeps the
 * scheduling rules testable without a database.
 */
import {
  type Interval,
  MINUTE_MS,
  expand,
  merge,
  overlapsAny,
  peakConcurrency,
  sort,
  subtract,
} from './interval.js';
import { ceilToStep } from './localtime.js';

export interface StaffAvailabilityInput {
  readonly staffId: string;
  /**
   * When this barber is workable: shift ∩ shop opening hours, already minus
   * breaks and approved time off.
   */
  readonly windows: readonly Interval[];
  /** Appointments and manual blocks, ALREADY expanded by their own buffers. */
  readonly busy: readonly Interval[];
  /** Total service duration resolved for this barber, including overrides. */
  readonly durationMinutes: number;
  /** Buffers this booking would carry, from the service definitions. */
  readonly bufferBeforeMinutes: number;
  readonly bufferAfterMinutes: number;
  /** Count of bookings already held today, for maxDailyBookings. */
  readonly bookingsToday?: number;
  readonly maxDailyBookings?: number | null;
}

export interface ResourceConstraint {
  readonly resourceTypeId: string;
  readonly capacity: number;
  /** Occupancy of this resource across ALL staff, buffer-expanded. */
  readonly busy: readonly Interval[];
}

export interface AvailabilityQuery {
  readonly staff: readonly StaffAvailabilityInput[];
  readonly slotStepMinutes: number;
  /** Current instant; slots before now + minLead are not offered. */
  readonly now: number;
  readonly minLeadMinutes?: number;
  /** Latest bookable instant, from the location's horizon. */
  readonly horizonEnd?: number;
  readonly resource?: ResourceConstraint | null;
  /**
   * Suppress candidate starts that would strand an unsellable gap, as long as
   * an alternative remains in the same window.
   * See docs/research/02-scheduling-engine.md §2.4.
   */
  readonly minUsefulGapMinutes?: number;
}

export interface Slot {
  readonly staffId: string;
  /** Instant the service starts (excluding buffer). */
  readonly start: number;
  /** Instant the service ends (excluding buffer). */
  readonly end: number;
  readonly durationMinutes: number;
}

/**
 * Candidate start times for one barber, before cross-barber merging.
 *
 * Walks the slot grid anchored at each window's start. The step is
 * INDEPENDENT of the duration: a 45-minute cut on a 15-minute grid offers
 * 10:00, 10:15, 10:30 — not only 10:00 and 10:45. That roughly triples
 * perceived availability (§2.3).
 */
function slotsForStaff(
  input: StaffAvailabilityInput,
  query: AvailabilityQuery,
): Slot[] {
  const {
    staffId,
    durationMinutes,
    bufferBeforeMinutes,
    bufferAfterMinutes,
  } = input;

  if (durationMinutes <= 0) return [];

  if (
    input.maxDailyBookings != null &&
    (input.bookingsToday ?? 0) >= input.maxDailyBookings
  ) {
    return [];
  }

  const stepMinutes = query.slotStepMinutes;
  if (stepMinutes <= 0) throw new RangeError('slotStepMinutes must be positive');

  const durationMs = durationMinutes * MINUTE_MS;
  const earliestStart = query.now + (query.minLeadMinutes ?? 0) * MINUTE_MS;
  const busy = merge(input.busy);
  const minGapMs = (query.minUsefulGapMinutes ?? 0) * MINUTE_MS;

  const out: Slot[] = [];

  for (const window of merge(input.windows)) {
    // Free stretches inside this window, after removing what's already booked.
    const free = subtract([window], busy);
    const windowCandidates: Slot[] = [];

    for (const stretch of free) {
      // The grid is anchored at the WINDOW start, not the stretch start, so
      // slot times stay aligned across the whole shift rather than drifting
      // to wherever the previous booking happened to end.
      let start = ceilToStep(stretch.start + bufferBeforeMinutes * MINUTE_MS, window.start, stepMinutes);

      while (start + durationMs <= stretch.end - bufferAfterMinutes * MINUTE_MS) {
        const service: Interval = { start, end: start + durationMs };
        const occupied = expand(service, bufferBeforeMinutes, bufferAfterMinutes);

        const tooSoon = start < earliestStart;
        const pastHorizon = query.horizonEnd != null && service.end > query.horizonEnd;
        const collides = overlapsAny(occupied, busy);
        const resourceFull =
          query.resource != null &&
          peakConcurrency(occupied, query.resource.busy) >= query.resource.capacity;

        if (!tooSoon && !pastHorizon && !collides && !resourceFull) {
          windowCandidates.push({ staffId, start, end: service.end, durationMinutes });
        }

        start += stepMinutes * MINUTE_MS;
      }
    }

    out.push(...suppressStrandingGaps(windowCandidates, free, minGapMs, bufferBeforeMinutes, bufferAfterMinutes));
  }

  return out;
}

/**
 * Hole suppression (§2.4).
 *
 * Drops candidates that would leave a residual gap too small to sell, but
 * never drops the last remaining candidate in a free stretch — an awkward
 * booking beats an empty chair.
 */
function suppressStrandingGaps(
  candidates: readonly Slot[],
  freeStretches: readonly Interval[],
  minGapMs: number,
  bufferBeforeMinutes: number,
  bufferAfterMinutes: number,
): Slot[] {
  if (minGapMs <= 0 || candidates.length === 0) return [...candidates];

  const kept = candidates.filter((slot) => {
    const stretch = freeStretches.find(
      (s) => s.start <= slot.start && slot.end <= s.end,
    );
    if (!stretch) return true;

    const occupiedStart = slot.start - bufferBeforeMinutes * MINUTE_MS;
    const occupiedEnd = slot.end + bufferAfterMinutes * MINUTE_MS;
    const gapBefore = occupiedStart - stretch.start;
    const gapAfter = stretch.end - occupiedEnd;

    const strandsBefore = gapBefore > 0 && gapBefore < minGapMs;
    const strandsAfter = gapAfter > 0 && gapAfter < minGapMs;
    return !strandsBefore && !strandsAfter;
  });

  return kept.length > 0 ? kept : [...candidates];
}

/**
 * Available slots across every eligible barber, sorted by start time.
 *
 * For an "any barber" query, pass every eligible barber and read `staffId`
 * off the chosen slot at confirmation time.
 */
export function availableSlots(query: AvailabilityQuery): Slot[] {
  const all = query.staff.flatMap((s) => slotsForStaff(s, query));
  return all.sort((a, b) => a.start - b.start || a.staffId.localeCompare(b.staffId));
}

export interface StartTimeOption {
  readonly start: number;
  readonly end: number;
  /** Every barber free at this start time, for "any barber" routing. */
  readonly staffIds: readonly string[];
}

/**
 * Collapse per-barber slots into distinct start times, which is what the
 * client-facing time picker renders (docs/research/04-apps-and-ux.md §4.1).
 */
export function startTimeOptions(slots: readonly Slot[]): StartTimeOption[] {
  const byStart = new Map<number, { end: number; staffIds: string[] }>();

  for (const slot of slots) {
    const existing = byStart.get(slot.start);
    if (existing) {
      if (!existing.staffIds.includes(slot.staffId)) existing.staffIds.push(slot.staffId);
      // Shortest offering wins as the displayed end time.
      if (slot.end < existing.end) existing.end = slot.end;
    } else {
      byStart.set(slot.start, { end: slot.end, staffIds: [slot.staffId] });
    }
  }

  return [...byStart.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([start, v]) => ({ start, end: v.end, staffIds: [...v.staffIds].sort() }));
}

/**
 * Pick which barber takes an "any barber" booking.
 *
 * Prefers the barber for whom this booking creates the least new dead time,
 * then the one with the lightest load that day, so work spreads fairly
 * instead of always landing on whoever sorts first (§2.4).
 */
export function assignAnyBarber(
  start: number,
  slots: readonly Slot[],
  staff: readonly StaffAvailabilityInput[],
): Slot | undefined {
  const eligible = slots.filter((s) => s.start === start);
  if (eligible.length <= 1) return eligible[0];

  const byId = new Map(staff.map((s) => [s.staffId, s]));

  const scored = eligible.map((slot) => {
    const input = byId.get(slot.staffId);
    const busy = input ? merge(input.busy) : [];
    const occupied = expand(
      { start: slot.start, end: slot.end },
      input?.bufferBeforeMinutes ?? 0,
      input?.bufferAfterMinutes ?? 0,
    );

    // Distance to the nearest existing commitment: smaller means this booking
    // packs tightly against work already scheduled.
    let fragmentation = Number.POSITIVE_INFINITY;
    for (const b of busy) {
      if (b.end <= occupied.start) {
        fragmentation = Math.min(fragmentation, occupied.start - b.end);
      } else if (b.start >= occupied.end) {
        fragmentation = Math.min(fragmentation, b.start - occupied.end);
      }
    }
    if (busy.length === 0) fragmentation = Number.MAX_SAFE_INTEGER;

    const load = busy.reduce((sum, b) => sum + (b.end - b.start), 0);
    return { slot, fragmentation, load };
  });

  scored.sort(
    (a, b) =>
      a.fragmentation - b.fragmentation ||
      a.load - b.load ||
      a.slot.staffId.localeCompare(b.slot.staffId),
  );

  return scored[0]?.slot;
}

/**
 * Whether a walk-in of `durationMinutes` fits before the next commitment,
 * starting now. This is the "fits-in-the-gap" check that lets a queue entry
 * be promoted into a real appointment (§2.7).
 */
export function fitsInGap(
  from: number,
  durationMinutes: number,
  input: StaffAvailabilityInput,
): boolean {
  const service: Interval = { start: from, end: from + durationMinutes * MINUTE_MS };
  const occupied = expand(service, input.bufferBeforeMinutes, input.bufferAfterMinutes);

  const inWindow = merge(input.windows).some(
    (w) => w.start <= occupied.start && occupied.end <= w.end,
  );
  return inWindow && !overlapsAny(occupied, merge(input.busy));
}

/** Free gaps in a barber's day, for the "gaps" strip in the barber app. */
export function openGaps(input: StaffAvailabilityInput): Interval[] {
  return sort(subtract(merge(input.windows), merge(input.busy)));
}
