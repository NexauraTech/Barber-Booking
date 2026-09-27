import { describe, expect, it } from 'vitest';
import {
  allocate,
  applyBps,
  checkoutTotals,
  discountValueCents,
  lineTotals,
  roundHalfAwayFromZero,
  taxOnLine,
  validateSplit,
} from '../src/domain/money.js';

describe('roundHalfAwayFromZero', () => {
  it('rounds halves away from zero in both directions', () => {
    expect(roundHalfAwayFromZero(2.5)).toBe(3);
    expect(roundHalfAwayFromZero(-2.5)).toBe(-3); // Math.round gives -2
    expect(roundHalfAwayFromZero(2.4)).toBe(2);
    expect(roundHalfAwayFromZero(-2.4)).toBe(-2);
  });
});

describe('applyBps', () => {
  it('applies a basis-point rate', () => {
    expect(applyBps(4500, 4250)).toBe(1913); // 42.5% of £45.00
    expect(applyBps(1000, 10_000)).toBe(1000);
    expect(applyBps(1000, 0)).toBe(0);
  });

  it('rounds negative amounts away from zero', () => {
    expect(applyBps(-1000, 2500)).toBe(-250);
  });
});

describe('taxOnLine', () => {
  it('adds tax on top when prices exclude it', () => {
    // US sales tax: $45.00 at 8% -> $3.60 tax.
    expect(taxOnLine(4500, 800, false)).toBe(360);
  });

  it('carves tax out when prices include it', () => {
    // UK VAT: £45.00 inclusive at 20% -> £7.50 VAT.
    expect(taxOnLine(4500, 2000, true)).toBe(750);
  });

  it('gives different answers for the two conventions', () => {
    // Getting this backwards misstates every sale.
    expect(taxOnLine(4500, 2000, false)).toBe(900);
    expect(taxOnLine(4500, 2000, true)).toBe(750);
  });

  it('is zero when there is no tax', () => {
    expect(taxOnLine(4500, 0, false)).toBe(0);
    expect(taxOnLine(4500, 0, true)).toBe(0);
  });

  it('carves tax out of a discount line as a negative amount', () => {
    expect(taxOnLine(-1000, 2000, true)).toBe(-167);
  });
});

describe('lineTotals', () => {
  it('multiplies by quantity', () => {
    const totals = lineTotals(
      { quantity: 3, unitPriceCents: 1200, taxRateBps: 2000, kind: 'product' },
      false,
    );
    expect(totals.lineTotalCents).toBe(3600);
    expect(totals.taxCents).toBe(720);
  });
});

describe('checkoutTotals', () => {
  const line = (kind: 'service' | 'product' | 'discount', total: number, tax: number) => ({
    kind,
    lineTotalCents: total,
    taxCents: tax,
  });

  it('totals a tax-exclusive sale', () => {
    const totals = checkoutTotals(
      [line('service', 4500, 360), line('product', 1200, 96)],
      500,
      false,
    );

    expect(totals.grossCents).toBe(5700);
    expect(totals.subtotalCents).toBe(5700);
    expect(totals.taxCents).toBe(456);
    // Tax added on top, then the tip.
    expect(totals.totalCents).toBe(5700 + 456 + 500);
  });

  it('does not add tax twice on a tax-inclusive sale', () => {
    const totals = checkoutTotals([line('service', 4500, 750)], 500, true);

    expect(totals.subtotalCents).toBe(4500);
    expect(totals.taxCents).toBe(750);
    // The £7.50 is already inside the £45.
    expect(totals.totalCents).toBe(5000);
  });

  it('subtracts discounts and reports them positively', () => {
    const totals = checkoutTotals(
      [line('service', 4500, 900), line('discount', -1000, -200)],
      0,
      false,
    );

    expect(totals.grossCents).toBe(4500);
    expect(totals.discountCents).toBe(1000);
    expect(totals.subtotalCents).toBe(3500);
    // Discounting reduces the tax owed.
    expect(totals.taxCents).toBe(700);
    expect(totals.totalCents).toBe(4200);
  });

  it('handles an empty checkout', () => {
    const totals = checkoutTotals([], 0, false);
    expect(totals.totalCents).toBe(0);
  });

  it('handles a tip-only checkout', () => {
    expect(checkoutTotals([], 500, false).totalCents).toBe(500);
  });
});

describe('discountValueCents', () => {
  it('takes a fixed amount', () => {
    expect(discountValueCents({ kind: 'amount', amountCents: 500 }, 4500)).toBe(500);
  });

  it('takes a percentage', () => {
    expect(discountValueCents({ kind: 'percent', bps: 1000 }, 4500)).toBe(450);
  });

  it('never exceeds the gross', () => {
    expect(discountValueCents({ kind: 'amount', amountCents: 9999 }, 4500)).toBe(4500);
    expect(discountValueCents({ kind: 'percent', bps: 20_000 }, 4500)).toBe(4500);
  });

  it('never goes negative', () => {
    expect(discountValueCents({ kind: 'amount', amountCents: -500 }, 4500)).toBe(0);
    expect(discountValueCents({ kind: 'percent', bps: -500 }, 4500)).toBe(0);
  });

  it('is zero against an empty sale', () => {
    expect(discountValueCents({ kind: 'percent', bps: 5000 }, 0)).toBe(0);
  });
});

describe('validateSplit', () => {
  it('accepts payments that exactly cover the total', () => {
    const result = validateSplit(
      [
        { amountCents: 2000, method: 'cash' },
        { amountCents: 2500, method: 'card' },
      ],
      4500,
    );
    expect(result.ok).toBe(true);
    expect(result.outstandingCents).toBe(0);
  });

  it('reports what is still owed', () => {
    const result = validateSplit([{ amountCents: 2000, method: 'cash' }], 4500);
    expect(result.ok).toBe(false);
    expect(result.outstandingCents).toBe(2500);
  });

  it('reports an overpayment', () => {
    const result = validateSplit([{ amountCents: 5000, method: 'cash' }], 4500);
    expect(result.ok).toBe(false);
    expect(result.overpaidCents).toBe(500);
  });

  it('treats no payment as the full amount outstanding', () => {
    expect(validateSplit([], 4500).outstandingCents).toBe(4500);
  });
});

describe('allocate', () => {
  it('splits evenly when it divides cleanly', () => {
    expect(allocate(900, [1, 1, 1])).toEqual([300, 300, 300]);
  });

  it('never loses or invents a penny', () => {
    // 100 / 3 rounds badly if each share is rounded independently.
    const parts = allocate(100, [1, 1, 1]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(100);
    expect(parts).toEqual([34, 33, 33]);
  });

  it('respects weights', () => {
    const parts = allocate(1000, [3, 1]);
    expect(parts).toEqual([750, 250]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(1000);
  });

  it('is exact across awkward weights', () => {
    const parts = allocate(1001, [7, 11, 13]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(1001);
  });

  it('returns zeroes for zero weights', () => {
    expect(allocate(1000, [0, 0])).toEqual([0, 0]);
  });

  it('handles a single share', () => {
    expect(allocate(1000, [1])).toEqual([1000]);
  });
});
