import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import {
  addDays,
  ceilToStep,
  daysBetween,
  isRotationActive,
  isoWeekday,
  localDateOf,
  localRangeToInterval,
  resolveInstant,
} from '../src/domain/localtime.js';

const hoursIn = (start: number, end: number) => (end - start) / 3_600_000;
const at = (ms: number, zone: string) => DateTime.fromMillis(ms, { zone }).toFormat('yyyy-MM-dd HH:mm ZZ');

describe('resolveInstant', () => {
  it('resolves a wall-clock time in the location timezone', () => {
    const ms = resolveInstant('2026-10-01', '09:00', 'Europe/London');
    expect(at(ms, 'Europe/London')).toBe('2026-10-01 09:00 +01:00');
  });

  it('treats 24:00 as midnight ending the date', () => {
    const ms = resolveInstant('2026-10-01', '24:00', 'Europe/London');
    expect(at(ms, 'Europe/London')).toBe('2026-10-02 00:00 +01:00');
  });

  it('rejects an invalid timezone', () => {
    expect(() => resolveInstant('2026-10-01', '09:00', 'Mars/Olympus')).toThrow();
  });
});

describe('DST handling', () => {
  // Europe/London springs forward 2026-03-29 01:00 UTC: local 01:00 -> 02:00.
  it('keeps opening hours at the same wall-clock time across spring forward', () => {
    const before = localRangeToInterval('2026-03-28', '09:00', '17:00', 'Europe/London');
    const during = localRangeToInterval('2026-03-29', '09:00', '17:00', 'Europe/London');

    expect(at(before.start, 'Europe/London')).toContain('09:00');
    expect(at(during.start, 'Europe/London')).toContain('09:00');
    // Both are 8 wall-clock hours; the gap is before 09:00 so neither is short.
    expect(hoursIn(before.start, before.end)).toBe(8);
    expect(hoursIn(during.start, during.end)).toBe(8);
  });

  it('shortens a shift that spans the spring-forward gap', () => {
    // 01:00-03:00 local on the transition day is only one real hour.
    const shift = localRangeToInterval('2026-03-29', '01:00', '03:00', 'Europe/London');
    expect(hoursIn(shift.start, shift.end)).toBe(1);
  });

  it('lengthens a shift that spans the fall-back repeat', () => {
    // Europe/London falls back 2026-10-25: local 02:00 happens twice, so
    // 01:00-03:00 local is three real hours.
    const shift = localRangeToInterval('2026-10-25', '01:00', '03:00', 'Europe/London');
    expect(hoursIn(shift.start, shift.end)).toBe(3);
  });

  it('keeps a full opening day correct across fall back', () => {
    const day = localRangeToInterval('2026-10-25', '09:00', '17:00', 'Europe/London');
    expect(at(day.start, 'Europe/London')).toContain('09:00');
    expect(hoursIn(day.start, day.end)).toBe(8);
  });

  it('is unaffected in a zone without DST', () => {
    const karachi = localRangeToInterval('2026-03-29', '09:00', '17:00', 'Asia/Karachi');
    expect(hoursIn(karachi.start, karachi.end)).toBe(8);
    expect(at(karachi.start, 'Asia/Karachi')).toBe('2026-03-29 09:00 +05:00');
  });
});

describe('cross-timezone viewing', () => {
  it('shows the shop instant correctly to a client in another zone', () => {
    // A shop in Karachi opens 09:00 PKT; a client's phone is in New York.
    const ms = resolveInstant('2026-10-01', '09:00', 'Asia/Karachi');
    expect(at(ms, 'Asia/Karachi')).toBe('2026-10-01 09:00 +05:00');
    expect(at(ms, 'America/New_York')).toBe('2026-10-01 00:00 -04:00');
    // The instant is the same; only the rendering differs.
    expect(localDateOf(ms, 'Asia/Karachi')).toBe('2026-10-01');
    expect(localDateOf(ms, 'America/New_York')).toBe('2026-10-01');
  });
});

describe('isoWeekday', () => {
  it('returns 1 for Monday and 7 for Sunday', () => {
    expect(isoWeekday('2026-09-28', 'Europe/London')).toBe(1);
    expect(isoWeekday('2026-10-04', 'Europe/London')).toBe(7);
  });
});

describe('addDays / daysBetween', () => {
  it('stays calendar-correct across a DST boundary', () => {
    expect(addDays('2026-03-28', 1, 'Europe/London')).toBe('2026-03-29');
    expect(addDays('2026-10-24', 2, 'Europe/London')).toBe('2026-10-26');
    expect(daysBetween('2026-03-28', '2026-03-30', 'Europe/London')).toBe(2);
    expect(daysBetween('2026-10-24', '2026-10-26', 'Europe/London')).toBe(2);
  });
});

describe('isRotationActive', () => {
  const tz = 'Europe/London';

  it('is always active for a weekly pattern', () => {
    expect(isRotationActive('2026-10-05', '2026-09-28', 1, tz)).toBe(true);
    expect(isRotationActive('2026-10-12', '2026-09-28', 1, tz)).toBe(true);
  });

  it('alternates for a fortnightly pattern', () => {
    const anchor = '2026-09-28'; // a Monday
    expect(isRotationActive('2026-09-28', anchor, 2, tz)).toBe(true);
    expect(isRotationActive('2026-10-05', anchor, 2, tz)).toBe(false);
    expect(isRotationActive('2026-10-12', anchor, 2, tz)).toBe(true);
    expect(isRotationActive('2026-10-19', anchor, 2, tz)).toBe(false);
  });

  it('holds the alternation across a month boundary and a DST change', () => {
    const anchor = '2026-09-28';
    // Crossing into November, past the 25 October fall-back.
    expect(isRotationActive('2026-10-26', anchor, 2, tz)).toBe(true);
    expect(isRotationActive('2026-11-02', anchor, 2, tz)).toBe(false);
    expect(isRotationActive('2026-11-09', anchor, 2, tz)).toBe(true);
  });

  it('rotates backwards before the anchor', () => {
    const anchor = '2026-09-28';
    expect(isRotationActive('2026-09-14', anchor, 2, tz)).toBe(true);
    expect(isRotationActive('2026-09-21', anchor, 2, tz)).toBe(false);
  });
});

describe('ceilToStep', () => {
  const anchor = resolveInstant('2026-10-01', '09:10', 'Europe/London');

  it('anchors the grid at the window start, not midnight', () => {
    const first = ceilToStep(anchor, anchor, 15);
    expect(at(first, 'Europe/London')).toContain('09:10');

    const next = ceilToStep(anchor + 60_000, anchor, 15);
    expect(at(next, 'Europe/London')).toContain('09:25');
  });

  it('returns the anchor for instants at or before it', () => {
    expect(ceilToStep(anchor - 60_000, anchor, 15)).toBe(anchor);
    expect(ceilToStep(anchor, anchor, 15)).toBe(anchor);
  });
});
