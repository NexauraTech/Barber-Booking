/**
 * Half-open interval arithmetic over epoch milliseconds.
 *
 * Every interval is [start, end) — an interval ending at 10:00 does not
 * overlap one starting at 10:00. This matches the `[)` tstzrange bounds used
 * by the no_overlap_per_staff constraint in db/migrations/0005_appointments.sql,
 * so the engine and the database agree on what "adjacent" means.
 */

export interface Interval {
  /** Inclusive start, epoch milliseconds. */
  readonly start: number;
  /** Exclusive end, epoch milliseconds. */
  readonly end: number;
}

export const MINUTE_MS = 60_000;

export function interval(start: number, end: number): Interval {
  return { start, end };
}

export function isEmpty(a: Interval): boolean {
  return a.end <= a.start;
}

export function durationMinutes(a: Interval): number {
  return (a.end - a.start) / MINUTE_MS;
}

export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

export function contains(outer: Interval, inner: Interval): boolean {
  return outer.start <= inner.start && inner.end <= outer.end;
}

export function overlapsAny(a: Interval, others: readonly Interval[]): boolean {
  return others.some((b) => overlaps(a, b));
}

/** Grow an interval outward by the given buffers, in minutes. */
export function expand(
  a: Interval,
  beforeMinutes: number,
  afterMinutes: number,
): Interval {
  return {
    start: a.start - beforeMinutes * MINUTE_MS,
    end: a.end + afterMinutes * MINUTE_MS,
  };
}

/** Sort by start, then end. Does not mutate the input. */
export function sort(intervals: readonly Interval[]): Interval[] {
  return [...intervals].sort((x, y) => x.start - y.start || x.end - y.end);
}

/**
 * Merge overlapping and touching intervals into a minimal disjoint set.
 * Touching intervals ([9,10) and [10,11)) are merged, since for occupancy
 * purposes they form one continuous busy block.
 */
export function merge(intervals: readonly Interval[]): Interval[] {
  const sorted = sort(intervals.filter((a) => !isEmpty(a)));
  const out: Interval[] = [];

  for (const cur of sorted) {
    const last = out[out.length - 1];
    if (last && cur.start <= last.end) {
      if (cur.end > last.end) out[out.length - 1] = { start: last.start, end: cur.end };
    } else {
      out.push(cur);
    }
  }
  return out;
}

/** Intersection of two sets of intervals. */
export function intersect(
  as: readonly Interval[],
  bs: readonly Interval[],
): Interval[] {
  const out: Interval[] = [];
  for (const a of merge(as)) {
    for (const b of merge(bs)) {
      const start = Math.max(a.start, b.start);
      const end = Math.min(a.end, b.end);
      if (end > start) out.push({ start, end });
    }
  }
  return sort(out);
}

/** `as` minus `bs` — the parts of `as` not covered by any interval in `bs`. */
export function subtract(
  as: readonly Interval[],
  bs: readonly Interval[],
): Interval[] {
  const holes = merge(bs);
  const out: Interval[] = [];

  for (const a of merge(as)) {
    let cursor = a.start;
    for (const hole of holes) {
      if (hole.end <= cursor) continue;
      if (hole.start >= a.end) break;
      if (hole.start > cursor) out.push({ start: cursor, end: hole.start });
      cursor = Math.max(cursor, hole.end);
      if (cursor >= a.end) break;
    }
    if (cursor < a.end) out.push({ start: cursor, end: a.end });
  }
  return out;
}

/**
 * Peak concurrent occupancy within `probe`, counted by sweeping interval
 * endpoints rather than iterating minutes. Used for resource capacity:
 * a candidate booking is valid only if peak occupancy stays below capacity
 * for every moment it would occupy the resource.
 */
export function peakConcurrency(
  probe: Interval,
  busy: readonly Interval[],
): number {
  const relevant = busy.filter((b) => overlaps(b, probe));
  if (relevant.length === 0) return 0;

  const events: Array<[number, number]> = [];
  for (const b of relevant) {
    events.push([Math.max(b.start, probe.start), 1]);
    events.push([Math.min(b.end, probe.end), -1]);
  }
  // Process ends before starts at the same instant: [9,10) and [10,11) are
  // never concurrent.
  events.sort((x, y) => x[0] - y[0] || x[1] - y[1]);

  let current = 0;
  let peak = 0;
  for (const [, delta] of events) {
    current += delta;
    if (current > peak) peak = current;
  }
  return peak;
}
