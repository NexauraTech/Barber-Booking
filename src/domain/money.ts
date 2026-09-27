/**
 * Money arithmetic.
 *
 * Everything is integer minor units — cents, pence, paise. No floats touch
 * the money path: `0.1 + 0.2 !== 0.3` is not an acceptable property of a till,
 * and a penny of drift per sale becomes a barber disputing their payout.
 *
 * Rates are basis points (1 bp = 0.01%), so 42.5% is 4250. Percentages as
 * floats reintroduce exactly the rounding problem integers were chosen to
 * avoid.
 */

export const BPS_DENOMINATOR = 10_000;

/**
 * Round half away from zero, which is what a till does and what people
 * expect. JavaScript's `Math.round` rounds half UP, so it turns -2.5 into -2
 * — a discount line would round the wrong way.
 */
export function roundHalfAwayFromZero(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/** Apply a basis-point rate to an amount. */
export function applyBps(amountCents: number, bps: number): number {
  return roundHalfAwayFromZero((amountCents * bps) / BPS_DENOMINATOR);
}

/**
 * Tax on a line, respecting the shop's pricing convention.
 *
 * Exclusive (US sales tax): the advertised price is net, tax is added on top.
 *   $45 at 8% -> $3.60 tax, $48.60 total.
 *
 * Inclusive (UK/EU VAT): the advertised price already contains the tax, which
 * is carved back out.
 *   £45 at 20% -> £7.50 VAT, £45 total.
 *
 * Getting this backwards misstates the tax on every sale, and the error is
 * invisible until an accountant finds it.
 */
export function taxOnLine(
  lineTotalCents: number,
  taxRateBps: number,
  pricesIncludeTax: boolean,
): number {
  if (taxRateBps <= 0) return 0;

  if (pricesIncludeTax) {
    // tax = gross * rate / (1 + rate)
    return roundHalfAwayFromZero(
      (lineTotalCents * taxRateBps) / (BPS_DENOMINATOR + taxRateBps),
    );
  }
  return applyBps(lineTotalCents, taxRateBps);
}

export interface LineInput {
  readonly quantity: number;
  readonly unitPriceCents: number;
  readonly taxRateBps: number;
  readonly kind: 'service' | 'product' | 'discount';
}

export interface LineTotals {
  readonly lineTotalCents: number;
  readonly taxCents: number;
}

export function lineTotals(line: LineInput, pricesIncludeTax: boolean): LineTotals {
  const lineTotalCents = line.unitPriceCents * line.quantity;
  return {
    lineTotalCents,
    taxCents: taxOnLine(lineTotalCents, line.taxRateBps, pricesIncludeTax),
  };
}

export interface CheckoutTotals {
  /** Sum of positive lines, before discounts. */
  readonly grossCents: number;
  /** Discounts as a positive number, for display. */
  readonly discountCents: number;
  /** Gross less discounts. */
  readonly subtotalCents: number;
  readonly taxCents: number;
  readonly tipCents: number;
  /** What the client actually pays. */
  readonly totalCents: number;
}

/**
 * Total a checkout.
 *
 * Tips are excluded from tax everywhere this product is likely to operate,
 * and are added after tax rather than being taxed as revenue.
 */
export function checkoutTotals(
  lines: ReadonlyArray<LineTotals & { kind: LineInput['kind'] }>,
  tipCents: number,
  pricesIncludeTax: boolean,
): CheckoutTotals {
  let grossCents = 0;
  let discountCents = 0;
  let taxCents = 0;

  for (const line of lines) {
    if (line.kind === 'discount') {
      discountCents += Math.abs(line.lineTotalCents);
    } else {
      grossCents += line.lineTotalCents;
    }
    // Discount lines carry negative tax, which reduces the tax due.
    taxCents += line.taxCents;
  }

  const subtotalCents = grossCents - discountCents;

  // With inclusive pricing the tax is already inside the subtotal, so adding
  // it again would charge it twice.
  const totalCents = pricesIncludeTax
    ? subtotalCents + tipCents
    : subtotalCents + taxCents + tipCents;

  return {
    grossCents,
    discountCents,
    subtotalCents,
    taxCents,
    tipCents,
    totalCents,
  };
}

export type DiscountRule =
  | { kind: 'amount'; amountCents: number }
  | { kind: 'percent'; bps: number };

/**
 * Value of a discount against a gross amount, never exceeding it — a discount
 * that turns a sale negative is a refund, and should be raised as one.
 */
export function discountValueCents(
  rule: DiscountRule,
  grossCents: number,
): number {
  const raw =
    rule.kind === 'amount'
      ? Math.max(0, Math.round(rule.amountCents))
      : applyBps(grossCents, Math.min(BPS_DENOMINATOR, Math.max(0, rule.bps)));

  return Math.min(raw, Math.max(0, grossCents));
}

export interface PaymentSplit {
  readonly amountCents: number;
  readonly method: string;
}

export interface SplitValidation {
  readonly ok: boolean;
  readonly paidCents: number;
  readonly outstandingCents: number;
  readonly overpaidCents: number;
}

/**
 * Check a set of split payments against a total.
 *
 * Split payment is standard in barbershops — part cash, part card, or a
 * deposit already taken plus the balance on the day — so the till has to
 * reason about "how much is still owed", not just "did they pay".
 */
export function validateSplit(
  payments: readonly PaymentSplit[],
  totalCents: number,
): SplitValidation {
  const paidCents = payments.reduce((sum, p) => sum + p.amountCents, 0);
  return {
    ok: paidCents === totalCents,
    paidCents,
    outstandingCents: Math.max(0, totalCents - paidCents),
    overpaidCents: Math.max(0, paidCents - totalCents),
  };
}

/**
 * Split an amount across shares without losing or inventing a penny.
 *
 * The naive approach — round each share independently — produces totals that
 * do not add up. Here the remainder is distributed one unit at a time to the
 * largest shares, so the parts always sum exactly to the whole.
 */
export function allocate(
  amountCents: number,
  weights: readonly number[],
): number[] {
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  if (totalWeight <= 0) return weights.map(() => 0);

  const exact = weights.map((w) => (amountCents * w) / totalWeight);
  const floors = exact.map((v) => Math.floor(v));
  let remainder = amountCents - floors.reduce((a, b) => a + b, 0);

  // Largest fractional part first; ties go to the earlier share so the result
  // is deterministic.
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);

  const result = [...floors];
  for (const { i } of order) {
    if (remainder <= 0) break;
    result[i]!++;
    remainder--;
  }

  return result;
}
