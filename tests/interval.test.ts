import { describe, expect, it } from 'vitest';
import {
  type Interval,
  expand,
  intersect,
  merge,
  overlaps,
  peakConcurrency,
  subtract,
} from '../src/domain/interval.js';

/** Minutes-from-zero helper: `iv(0, 60)` is [00:00, 01:00). */
const iv = (startMin: number, endMin: number): Interval => ({
  start: startMin * 60_000,
  end: endMin * 60_000,
});

const show = (xs: Interval[]) => xs.map((x) => [x.start / 60_000, x.end / 60_000]);

describe('overlaps', () => {
  it('treats intervals as half-open', () => {
    expect(overlaps(iv(0, 60), iv(60, 120))).toBe(false);
    expect(overlaps(iv(0, 61), iv(60, 120))).toBe(true);
  });

  it('is symmetric', () => {
    expect(overlaps(iv(30, 90), iv(0, 60))).toBe(true);
    expect(overlaps(iv(0, 60), iv(30, 90))).toBe(true);
  });

  it('detects containment', () => {
    expect(overlaps(iv(0, 120), iv(30, 60))).toBe(true);
  });
});

describe('merge', () => {
  it('joins overlapping and touching intervals', () => {
    expect(show(merge([iv(0, 60), iv(50, 90), iv(90, 120)]))).toEqual([[0, 120]]);
  });

  it('keeps disjoint intervals separate', () => {
    expect(show(merge([iv(0, 60), iv(90, 120)]))).toEqual([
      [0, 60],
      [90, 120],
    ]);
  });

  it('drops empty intervals and sorts', () => {
    expect(show(merge([iv(90, 120), iv(30, 30), iv(0, 60)]))).toEqual([
      [0, 60],
      [90, 120],
    ]);
  });

  it('absorbs a fully contained interval', () => {
    expect(show(merge([iv(0, 120), iv(30, 60)]))).toEqual([[0, 120]]);
  });
});

describe('subtract', () => {
  it('cuts a hole out of the middle', () => {
    expect(show(subtract([iv(0, 120)], [iv(30, 60)]))).toEqual([
      [0, 30],
      [60, 120],
    ]);
  });

  it('trims from the edges', () => {
    expect(show(subtract([iv(0, 120)], [iv(0, 30), iv(90, 200)]))).toEqual([[30, 90]]);
  });

  it('returns nothing when fully covered', () => {
    expect(subtract([iv(30, 60)], [iv(0, 120)])).toEqual([]);
  });

  it('ignores holes that miss entirely', () => {
    expect(show(subtract([iv(0, 60)], [iv(120, 180)]))).toEqual([[0, 60]]);
  });

  it('handles several overlapping holes', () => {
    expect(show(subtract([iv(0, 240)], [iv(30, 60), iv(50, 90), iv(200, 300)]))).toEqual([
      [0, 30],
      [90, 200],
    ]);
  });
});

describe('intersect', () => {
  it('returns the common part', () => {
    expect(show(intersect([iv(0, 120)], [iv(60, 180)]))).toEqual([[60, 120]]);
  });

  it('returns nothing for disjoint sets', () => {
    expect(intersect([iv(0, 60)], [iv(60, 120)])).toEqual([]);
  });

  it('intersects many against many', () => {
    expect(show(intersect([iv(0, 60), iv(120, 180)], [iv(30, 150)]))).toEqual([
      [30, 60],
      [120, 150],
    ]);
  });
});

describe('expand', () => {
  it('grows outward by the buffers', () => {
    const e = expand(iv(60, 105), 5, 10);
    expect([e.start / 60_000, e.end / 60_000]).toEqual([55, 115]);
  });
});

describe('peakConcurrency', () => {
  it('counts the busiest moment inside the probe', () => {
    const busy = [iv(0, 60), iv(30, 90), iv(45, 75)];
    expect(peakConcurrency(iv(0, 120), busy)).toBe(3);
  });

  it('does not count adjacent intervals as concurrent', () => {
    expect(peakConcurrency(iv(0, 120), [iv(0, 60), iv(60, 120)])).toBe(1);
  });

  it('ignores intervals outside the probe', () => {
    expect(peakConcurrency(iv(0, 30), [iv(60, 120)])).toBe(0);
  });
});
