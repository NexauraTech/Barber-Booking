import { describe, expect, it } from 'vitest';
import {
  type CompensationTerms,
  type EarningLine,
  computePayout,
  earningsForLine,
  rentForPeriodCents,
} from '../src/domain/compensation.js';

const line = (
  kind: EarningLine['kind'],
  grossCents: number,
  description: string = kind,
): EarningLine => ({ kind, grossCents, description, occurredAt: 0 });

const commission = (over: Partial<CompensationTerms> = {}): CompensationTerms => ({
  kind: 'commission',
  serviceCommissionBps: 4000, // 40%
  retailCommissionBps: 1000, // 10%
  ...over,
});

const chairRent = (over: Partial<CompensationTerms> = {}): CompensationTerms => ({
  kind: 'chair_rent',
  rentCentsPerWeek: 20_000, // £200/week
  ...over,
});

describe('rentForPeriodCents', () => {
  it('charges one week for seven days', () => {
    expect(rentForPeriodCents(20_000, 7)).toBe(20_000);
  });

  it('charges two weeks for a fortnight', () => {
    expect(rentForPeriodCents(20_000, 14)).toBe(40_000);
  });

  it('prorates a partial week', () => {
    expect(rentForPeriodCents(20_000, 10)).toBe(28_571);
  });

  it('is zero for no rent or no days', () => {
    expect(rentForPeriodCents(0, 7)).toBe(0);
    expect(rentForPeriodCents(20_000, 0)).toBe(0);
  });
});

describe('earningsForLine', () => {
  it('pays the commission rate on a service', () => {
    const result = earningsForLine(line('service', 4500), commission());
    expect(result.earningsCents).toBe(1800); // 40%
  });

  it('pays a different rate on retail', () => {
    const result = earningsForLine(line('product', 2000), commission());
    expect(result.earningsCents).toBe(200); // 10%
  });

  it('passes the full ticket through under chair rent', () => {
    const result = earningsForLine(line('service', 4500), chairRent());
    expect(result.earningsCents).toBe(4500);
  });

  it('pays nothing from revenue under salary', () => {
    const result = earningsForLine(line('service', 4500), { kind: 'salary' });
    expect(result.earningsCents).toBe(0);
  });

  it('gives tips to the barber under every arrangement', () => {
    for (const terms of [commission(), chairRent(), { kind: 'salary' as const }]) {
      expect(earningsForLine(line('tip', 500), terms).earningsCents).toBe(500);
    }
  });

  it('honours a shop that pools part of the tips', () => {
    const pooled = commission({ tipsRetainedBps: 7500 });
    expect(earningsForLine(line('tip', 1000), pooled).earningsCents).toBe(750);
  });
});

describe('computePayout — commission', () => {
  const lines = [
    line('service', 4500, 'Haircut'),
    line('service', 3500, 'Haircut'),
    line('product', 2000, 'Pomade'),
    line('tip', 800, 'Tip'),
  ];

  it('totals revenue separately from earnings', () => {
    const payout = computePayout({ terms: commission(), lines, periodDays: 7 });

    expect(payout.serviceRevenueCents).toBe(8000);
    expect(payout.retailRevenueCents).toBe(2000);
    expect(payout.serviceEarningsCents).toBe(3200); // 40% of 8000
    expect(payout.retailEarningsCents).toBe(200); // 10% of 2000
    expect(payout.tipsCents).toBe(800);
  });

  it('nets earnings plus tips, with no rent', () => {
    const payout = computePayout({ terms: commission(), lines, periodDays: 7 });
    expect(payout.rentCents).toBe(0);
    expect(payout.netCents).toBe(3200 + 200 + 800);
  });

  it('keeps a line for every entry', () => {
    const payout = computePayout({ terms: commission(), lines, periodDays: 7 });
    expect(payout.lines).toHaveLength(4);
    expect(payout.lines.every((l) => l.rateBps !== undefined)).toBe(true);
  });
});

describe('computePayout — chair rent', () => {
  it('passes revenue through and deducts rent', () => {
    const payout = computePayout({
      terms: chairRent(),
      lines: [line('service', 80_000), line('tip', 5_000)],
      periodDays: 7,
    });

    expect(payout.serviceEarningsCents).toBe(80_000);
    expect(payout.rentCents).toBe(20_000);
    expect(payout.netCents).toBe(80_000 + 5_000 - 20_000);
  });

  it('goes negative on a quiet week, because the barber genuinely owes rent', () => {
    const payout = computePayout({
      terms: chairRent(),
      lines: [line('service', 5_000)],
      periodDays: 7,
    });

    expect(payout.netCents).toBe(5_000 - 20_000);
    expect(payout.netCents).toBeLessThan(0);
  });

  it('records the rent as its own line', () => {
    const payout = computePayout({
      terms: chairRent(),
      lines: [line('service', 80_000)],
      periodDays: 7,
    });

    const rentLine = payout.lines.find((l) => l.description.includes('Chair rent'));
    expect(rentLine!.earningsCents).toBe(-20_000);
  });

  it('charges no rent when there is none configured', () => {
    const payout = computePayout({
      terms: chairRent({ rentCentsPerWeek: 0 }),
      lines: [line('service', 5_000)],
      periodDays: 7,
    });
    expect(payout.rentCents).toBe(0);
    expect(payout.netCents).toBe(5_000);
  });
});

describe('computePayout — salary', () => {
  it('pays nothing from revenue but still passes on tips', () => {
    const payout = computePayout({
      terms: { kind: 'salary' },
      lines: [line('service', 80_000), line('tip', 5_000)],
      periodDays: 7,
    });

    expect(payout.serviceRevenueCents).toBe(80_000);
    expect(payout.serviceEarningsCents).toBe(0);
    expect(payout.netCents).toBe(5_000);
  });
});

describe('computePayout — edge cases', () => {
  it('handles a period with no sales', () => {
    const payout = computePayout({ terms: commission(), lines: [], periodDays: 7 });
    expect(payout.netCents).toBe(0);
    expect(payout.lines).toEqual([]);
  });

  it('leaves a barber owing rent for a week with no sales', () => {
    const payout = computePayout({ terms: chairRent(), lines: [], periodDays: 7 });
    expect(payout.netCents).toBe(-20_000);
  });

  it('treats a missing commission rate as zero rather than throwing', () => {
    const payout = computePayout({
      terms: { kind: 'commission', serviceCommissionBps: 4000 },
      lines: [line('product', 2000)],
      periodDays: 7,
    });
    expect(payout.retailEarningsCents).toBe(0);
  });
});
