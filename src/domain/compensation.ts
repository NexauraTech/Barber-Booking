/**
 * Payout calculation.
 *
 * Three arrangements cover almost every barbershop, and they run in opposite
 * directions (docs/research/01-market-landscape.md §1.3):
 *
 *   commission — the shop takes a cut; the barber is paid what's left
 *   chair_rent — the barber keeps the revenue and OWES the shop rent
 *   salary     — the revenue is the shop's; wages are payroll's problem
 *
 * A chair-rent barber who has a quiet week nets a negative number. That is
 * not an error to clamp away: they genuinely owe the shop money, and hiding
 * it would misstate both sides' books.
 *
 * Pure: no database, no clock of its own.
 */
import { BPS_DENOMINATOR, applyBps } from './money.js';

export type CompensationKind = 'commission' | 'chair_rent' | 'salary';

export interface CompensationTerms {
  readonly kind: CompensationKind;
  readonly serviceCommissionBps?: number | null;
  readonly retailCommissionBps?: number | null;
  readonly rentCentsPerWeek?: number | null;
  /** Share of tips the barber keeps; 10000 = all of them. */
  readonly tipsRetainedBps?: number;
}

export interface EarningLine {
  readonly kind: 'service' | 'product' | 'tip';
  readonly grossCents: number;
  readonly description: string;
  readonly occurredAt: number;
  readonly checkoutId?: string | null;
  readonly checkoutItemId?: string | null;
}

export interface PayoutLine extends EarningLine {
  readonly rateBps: number | null;
  readonly earningsCents: number;
}

export interface PayoutSummary {
  readonly compensationKind: CompensationKind;
  readonly serviceRevenueCents: number;
  readonly retailRevenueCents: number;
  readonly serviceEarningsCents: number;
  readonly retailEarningsCents: number;
  readonly tipsCents: number;
  readonly rentCents: number;
  readonly netCents: number;
  readonly lines: PayoutLine[];
}

/**
 * Rent for a period, prorated by whole days.
 *
 * Weekly rent over a fortnight is two weeks' rent; over ten days it is ten
 * sevenths. Rounding is applied once at the end rather than per day, so a
 * month of prorating cannot drift.
 */
export function rentForPeriodCents(
  rentCentsPerWeek: number,
  periodDays: number,
): number {
  if (rentCentsPerWeek <= 0 || periodDays <= 0) return 0;
  return Math.round((rentCentsPerWeek * periodDays) / 7);
}

function rateFor(terms: CompensationTerms, kind: EarningLine['kind']): number | null {
  switch (kind) {
    case 'service':
      return terms.kind === 'commission' ? (terms.serviceCommissionBps ?? 0) : null;
    case 'product':
      return terms.kind === 'commission' ? (terms.retailCommissionBps ?? 0) : null;
    case 'tip':
      return terms.tipsRetainedBps ?? BPS_DENOMINATOR;
  }
}

/**
 * What a barber earns from one line.
 *
 * Under chair rent the barber keeps the whole ticket and settles up through
 * rent, so revenue passes through at 100%. Under salary none of it is theirs.
 * Tips are the barber's in every arrangement unless the shop pools them.
 */
export function earningsForLine(
  line: EarningLine,
  terms: CompensationTerms,
): PayoutLine {
  if (line.kind === 'tip') {
    const rate = terms.tipsRetainedBps ?? BPS_DENOMINATOR;
    return { ...line, rateBps: rate, earningsCents: applyBps(line.grossCents, rate) };
  }

  switch (terms.kind) {
    case 'commission': {
      const rate = rateFor(terms, line.kind) ?? 0;
      return { ...line, rateBps: rate, earningsCents: applyBps(line.grossCents, rate) };
    }
    case 'chair_rent':
      return { ...line, rateBps: BPS_DENOMINATOR, earningsCents: line.grossCents };
    case 'salary':
      return { ...line, rateBps: 0, earningsCents: 0 };
  }
}

export interface PayoutInput {
  readonly terms: CompensationTerms;
  readonly lines: readonly EarningLine[];
  readonly periodDays: number;
}

/** Compute a full payout: earnings, rent owed, and the net position. */
export function computePayout(input: PayoutInput): PayoutSummary {
  const { terms, lines, periodDays } = input;

  const priced = lines.map((line) => earningsForLine(line, terms));

  const sum = (
    kind: EarningLine['kind'],
    field: 'grossCents' | 'earningsCents',
  ): number => priced.filter((l) => l.kind === kind).reduce((a, l) => a + l[field], 0);

  const serviceRevenueCents = sum('service', 'grossCents');
  const retailRevenueCents = sum('product', 'grossCents');
  const serviceEarningsCents = sum('service', 'earningsCents');
  const retailEarningsCents = sum('product', 'earningsCents');
  const tipsCents = sum('tip', 'earningsCents');

  const rentCents =
    terms.kind === 'chair_rent'
      ? rentForPeriodCents(terms.rentCentsPerWeek ?? 0, periodDays)
      : 0;

  if (rentCents > 0) {
    priced.push({
      kind: 'service',
      grossCents: 0,
      description: `Chair rent, ${periodDays} day${periodDays === 1 ? '' : 's'}`,
      occurredAt: 0,
      rateBps: null,
      earningsCents: -rentCents,
    });
  }

  return {
    compensationKind: terms.kind,
    serviceRevenueCents,
    retailRevenueCents,
    serviceEarningsCents,
    retailEarningsCents,
    tipsCents,
    rentCents,
    // Negative when a quiet week on chair rent leaves the barber owing.
    netCents: serviceEarningsCents + retailEarningsCents + tipsCents - rentCents,
    lines: priced,
  };
}
