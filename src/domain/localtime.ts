/**
 * Converting local wall-clock scheduling rules into instants.
 *
 * Opening hours, shifts and breaks are stored as local wall-clock time plus a
 * weekday or date — "opens at 09:00" must stay 09:00 across a DST change.
 * This module is the only place that turns those rules into absolute instants,
 * in the location's IANA timezone.
 *
 * DST edge cases handled here (docs/research/02-scheduling-engine.md §2.6):
 *
 *   Spring forward — 02:00 does not exist. Luxon maps a nonexistent local time
 *   forward to the instant just after the gap. A 01:00-03:00 shift on that day
 *   is therefore one real hour, not two, which is correct: the barber works
 *   one hour of wall-clock-crossing time.
 *
 *   Fall back — 02:00 happens twice. Luxon resolves the ambiguous local time
 *   to the FIRST occurrence (the pre-transition offset). A 01:00-03:00 shift
 *   on that day is three real hours, which is again correct.
 *
 * Both are covered by tests in tests/localtime.test.ts.
 */
import { DateTime } from 'luxon';
import type { Interval } from './interval.js';

/** A date in the location's timezone, as 'YYYY-MM-DD'. */
export type LocalDate = string;

/** A wall-clock time of day, as 'HH:MM' or 'HH:MM:SS'. */
export type LocalTime = string;

export interface TimeOfDay {
  hour: number;
  minute: number;
  second: number;
}

export function parseLocalTime(value: LocalTime): TimeOfDay {
  const parts = value.split(':');
  const hour = Number(parts[0]);
  const minute = Number(parts[1] ?? 0);
  const second = Number(parts[2] ?? 0);

  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    !Number.isFinite(second) ||
    hour < 0 ||
    hour > 24 ||
    minute < 0 ||
    minute > 59
  ) {
    throw new RangeError(`Invalid local time: ${value}`);
  }
  return { hour, minute, second };
}

/**
 * Resolve a wall-clock time on a given local date to an instant.
 *
 * '24:00' is accepted and means midnight at the end of the date, so a shift
 * can be expressed as 18:00-24:00 without a date rollover.
 */
export function resolveInstant(
  date: LocalDate,
  time: LocalTime,
  timezone: string,
): number {
  const { hour, minute, second } = parseLocalTime(time);

  const base = DateTime.fromISO(date, { zone: timezone });
  if (!base.isValid) {
    throw new RangeError(`Invalid date '${date}' for timezone '${timezone}': ${base.invalidReason}`);
  }

  const resolved =
    hour === 24
      ? base.plus({ days: 1 }).startOf('day')
      : base.set({ hour, minute, second, millisecond: 0 });

  if (!resolved.isValid) {
    throw new RangeError(`Invalid local time ${date} ${time} in ${timezone}`);
  }
  return resolved.toMillis();
}

/** Turn a local wall-clock range on a date into an instant interval. */
export function localRangeToInterval(
  date: LocalDate,
  from: LocalTime,
  to: LocalTime,
  timezone: string,
): Interval {
  return {
    start: resolveInstant(date, from, timezone),
    end: resolveInstant(date, to, timezone),
  };
}

/** ISO weekday for a local date: 1 = Monday … 7 = Sunday. */
export function isoWeekday(date: LocalDate, timezone: string): number {
  const dt = DateTime.fromISO(date, { zone: timezone });
  if (!dt.isValid) throw new RangeError(`Invalid date: ${date}`);
  return dt.weekday;
}

/** The local date an instant falls on, in the given timezone. */
export function localDateOf(instant: number, timezone: string): LocalDate {
  return DateTime.fromMillis(instant, { zone: timezone }).toISODate()!;
}

/** Whole days between two local dates (`to` - `from`). */
export function daysBetween(from: LocalDate, to: LocalDate, timezone: string): number {
  const a = DateTime.fromISO(from, { zone: timezone }).startOf('day');
  const b = DateTime.fromISO(to, { zone: timezone }).startOf('day');
  return Math.round(b.diff(a, 'days').days);
}

/** Advance a local date by N days, staying calendar-correct across DST. */
export function addDays(date: LocalDate, days: number, timezone: string): LocalDate {
  return DateTime.fromISO(date, { zone: timezone }).plus({ days }).toISODate()!;
}

/**
 * Whether a rotating weekly shift is active on a date.
 *
 * `repeatIntervalWeeks` of 2 with an anchor date expresses "alternate
 * Mondays". Each weekday rotates independently, so a barber can work Mondays
 * fortnightly and Saturdays weekly (docs/research/02-scheduling-engine.md §2.9).
 */
export function isRotationActive(
  date: LocalDate,
  anchorDate: LocalDate,
  repeatIntervalWeeks: number,
  timezone: string,
): boolean {
  if (repeatIntervalWeeks <= 1) return true;

  const days = daysBetween(anchorDate, date, timezone);
  // Align to whole weeks from the anchor; negative dates rotate backwards.
  const weeks = Math.floor(days / 7);
  return ((weeks % repeatIntervalWeeks) + repeatIntervalWeeks) % repeatIntervalWeeks === 0;
}

/**
 * Round an instant up to the next point on a slot grid anchored at the
 * window start.
 *
 * The grid is anchored at `anchor` rather than at midnight so that a shop
 * opening at 09:10 on a 15-minute step offers 09:10, 09:25, 09:40 — not
 * 09:15, 09:30. Anchoring at midnight would silently discard the first
 * partial step of every shift.
 */
export function ceilToStep(instant: number, anchor: number, stepMinutes: number): number {
  const stepMs = stepMinutes * 60_000;
  if (instant <= anchor) return anchor;
  const steps = Math.ceil((instant - anchor) / stepMs);
  return anchor + steps * stepMs;
}
