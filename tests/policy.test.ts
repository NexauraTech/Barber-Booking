import { describe, expect, it } from 'vitest';
import {
  type ClientRisk,
  type LocationPolicySettings,
  buildPolicySnapshot,
  depositAmountCents,
  depositRequired,
  evaluateCancellation,
  feeAfterDeposit,
  isRisky,
  noShowFeeCents,
  parseDepositRule,
  parsePolicySnapshot,
} from '../src/domain/policy.js';

const settings = (
  over: Partial<LocationPolicySettings> = {},
): LocationPolicySettings => ({
  cancellationWindowHours: 24,
  lateCancelFeePercent: 50,
  noShowFeePercent: 100,
  depositAppliesTo: 'first_time_or_risky',
  riskyNoShowThreshold: 1,
  ...over,
});

const risk = (over: Partial<ClientRisk> = {}): ClientRisk => ({
  isFirstTime: false,
  noShowCount: 0,
  ...over,
});

const HOUR = 3_600_000;

describe('depositRequired', () => {
  it('charges strangers and no-show risks but not trusted regulars', () => {
    const s = settings();
    expect(depositRequired(risk({ isFirstTime: true }), s)).toBe(true);
    expect(depositRequired(risk({ noShowCount: 1 }), s)).toBe(true);
    expect(depositRequired(risk(), s)).toBe(false);
  });

  it('honours never and always', () => {
    expect(depositRequired(risk({ isFirstTime: true }), settings({ depositAppliesTo: 'never' }))).toBe(false);
    expect(depositRequired(risk(), settings({ depositAppliesTo: 'always' }))).toBe(true);
  });

  it('separates first-time from risky', () => {
    const firstTimeOnly = settings({ depositAppliesTo: 'first_time' });
    expect(depositRequired(risk({ isFirstTime: true }), firstTimeOnly)).toBe(true);
    expect(depositRequired(risk({ noShowCount: 3 }), firstTimeOnly)).toBe(false);

    const riskyOnly = settings({ depositAppliesTo: 'risky' });
    expect(depositRequired(risk({ isFirstTime: true }), riskyOnly)).toBe(false);
    expect(depositRequired(risk({ noShowCount: 3 }), riskyOnly)).toBe(true);
  });

  it('respects a raised risk threshold', () => {
    const lenient = settings({ riskyNoShowThreshold: 3 });
    expect(isRisky(risk({ noShowCount: 2 }), lenient)).toBe(false);
    expect(isRisky(risk({ noShowCount: 3 }), lenient)).toBe(true);
  });
});

describe('depositAmountCents', () => {
  it('adds fixed amounts', () => {
    expect(depositAmountCents(4000, [{ kind: 'fixed', amountCents: 1000 }])).toBe(1000);
  });

  it('computes a percentage of the total', () => {
    expect(depositAmountCents(4000, [{ kind: 'percent', percent: 25 }])).toBe(1000);
  });

  it('combines rules across a multi-service booking', () => {
    expect(
      depositAmountCents(4000, [
        { kind: 'fixed', amountCents: 500 },
        { kind: 'percent', percent: 10 },
      ]),
    ).toBe(900);
  });

  it('never exceeds the service total', () => {
    expect(depositAmountCents(3000, [{ kind: 'fixed', amountCents: 9999 }])).toBe(3000);
  });

  it('is zero when no rule applies', () => {
    expect(depositAmountCents(4000, [{ kind: 'none' }])).toBe(0);
    expect(depositAmountCents(4000, [])).toBe(0);
  });

  it('clamps a nonsensical percentage', () => {
    expect(depositAmountCents(4000, [{ kind: 'percent', percent: 500 }])).toBe(4000);
    expect(depositAmountCents(4000, [{ kind: 'percent', percent: -10 }])).toBe(0);
  });
});

describe('evaluateCancellation', () => {
  const snapshot = buildPolicySnapshot(settings(), 4000, 0);
  const start = 1_800_000_000_000;

  it('is free outside the notice window', () => {
    const outcome = evaluateCancellation(snapshot, start, start - 48 * HOUR);
    expect(outcome).toEqual({ kind: 'free', feeCents: 0 });
  });

  it('is free exactly at the window boundary', () => {
    const outcome = evaluateCancellation(snapshot, start, start - 24 * HOUR);
    expect(outcome.kind).toBe('free');
  });

  it('charges the late percentage inside the window', () => {
    const outcome = evaluateCancellation(snapshot, start, start - 2 * HOUR);
    expect(outcome.kind).toBe('late');
    expect(outcome.feeCents).toBe(2000); // 50% of 4000
  });

  it('charges the late fee for a cancellation after the start time', () => {
    const outcome = evaluateCancellation(snapshot, start, start + HOUR);
    expect(outcome.kind).toBe('late');
  });

  it('is always free when the shop sets no window', () => {
    const lenient = buildPolicySnapshot(settings({ cancellationWindowHours: 0 }), 4000, 0);
    expect(evaluateCancellation(lenient, start, start - 60_000).kind).toBe('free');
  });

  it('judges against the snapshot, not the shop\'s current policy', () => {
    // Booked under a lenient policy; the shop later tightened it.
    const asAccepted = buildPolicySnapshot(
      settings({ cancellationWindowHours: 2, lateCancelFeePercent: 10 }),
      4000,
      0,
    );
    const outcome = evaluateCancellation(asAccepted, start, start - 3 * HOUR);
    expect(outcome.kind).toBe('free');
  });
});

describe('noShowFeeCents', () => {
  it('charges the full price by default', () => {
    expect(noShowFeeCents(buildPolicySnapshot(settings(), 4000, 0))).toBe(4000);
  });

  it('honours a softer no-show percentage', () => {
    const soft = buildPolicySnapshot(settings({ noShowFeePercent: 25 }), 4000, 0);
    expect(noShowFeeCents(soft)).toBe(1000);
  });
});

describe('feeAfterDeposit', () => {
  it('credits a deposit already taken', () => {
    expect(feeAfterDeposit(4000, 1000)).toBe(3000);
  });

  it('never goes negative when the deposit covers the fee', () => {
    expect(feeAfterDeposit(1000, 4000)).toBe(0);
  });
});

describe('buildPolicySnapshot', () => {
  it('writes a summary a client can actually read', () => {
    const snapshot = buildPolicySnapshot(settings(), 4000, 1000);
    expect(snapshot.summary).toContain('24 hours');
    expect(snapshot.summary).toContain('50%');
    expect(snapshot.depositCents).toBe(1000);
    expect(snapshot.serviceTotalCents).toBe(4000);
  });

  it('words it differently when cancellation is always free', () => {
    const snapshot = buildPolicySnapshot(settings({ cancellationWindowHours: 0 }), 4000, 0);
    expect(snapshot.summary).toContain('any time');
  });
});

describe('parsing', () => {
  it('reads deposit rules from stored json', () => {
    expect(parseDepositRule({ kind: 'fixed', amountCents: 500 })).toEqual({
      kind: 'fixed',
      amountCents: 500,
    });
    expect(parseDepositRule({ kind: 'percent', percent: 20 })).toEqual({
      kind: 'percent',
      percent: 20,
    });
  });

  it('falls back to no deposit for malformed json', () => {
    expect(parseDepositRule(null)).toEqual({ kind: 'none' });
    expect(parseDepositRule({ kind: 'nonsense' })).toEqual({ kind: 'none' });
    expect(parseDepositRule({ kind: 'fixed' })).toEqual({ kind: 'none' });
  });

  it('round-trips a policy snapshot', () => {
    const snapshot = buildPolicySnapshot(settings(), 4000, 1000);
    const parsed = parsePolicySnapshot(JSON.parse(JSON.stringify(snapshot)));
    expect(parsed).toEqual(snapshot);
  });

  it('rejects a snapshot of an unknown version', () => {
    expect(parsePolicySnapshot({ version: 99 })).toBeNull();
    expect(parsePolicySnapshot(null)).toBeNull();
  });
});
