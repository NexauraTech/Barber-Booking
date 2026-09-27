/**
 * Deposit and cancellation policy evaluation.
 *
 * Policies are evaluated once, at booking, and SNAPSHOTTED onto the
 * appointment. Changing the shop's policy tomorrow must never alter what a
 * client agreed to today — that is both a fairness requirement and, where
 * money is charged automatically, a legal one.
 *
 * Pure: no database, no clock of its own.
 */

export type DepositAudience =
  | 'never'
  | 'first_time'
  | 'risky'
  | 'first_time_or_risky'
  | 'always';

/** Per-service deposit shape, stored as jsonb on `services.deposit_policy`. */
export type DepositRule =
  | { kind: 'none' }
  | { kind: 'fixed'; amountCents: number }
  | { kind: 'percent'; percent: number };

export interface LocationPolicySettings {
  readonly cancellationWindowHours: number;
  readonly lateCancelFeePercent: number;
  readonly noShowFeePercent: number;
  readonly depositAppliesTo: DepositAudience;
  readonly riskyNoShowThreshold: number;
}

export interface ClientRisk {
  /** No prior completed appointment at this organisation. */
  readonly isFirstTime: boolean;
  readonly noShowCount: number;
}

/**
 * The policy text a client accepts, frozen onto the appointment.
 * `version` lets a later reader tell which shape it is dealing with.
 */
export interface PolicySnapshot {
  readonly version: 1;
  readonly cancellationWindowHours: number;
  readonly lateCancelFeePercent: number;
  readonly noShowFeePercent: number;
  readonly depositCents: number;
  readonly serviceTotalCents: number;
  readonly summary: string;
}

export function isRisky(risk: ClientRisk, settings: LocationPolicySettings): boolean {
  return risk.noShowCount >= settings.riskyNoShowThreshold;
}

/** Whether this client must leave a deposit for this booking. */
export function depositRequired(
  risk: ClientRisk,
  settings: LocationPolicySettings,
): boolean {
  switch (settings.depositAppliesTo) {
    case 'never':
      return false;
    case 'always':
      return true;
    case 'first_time':
      return risk.isFirstTime;
    case 'risky':
      return isRisky(risk, settings);
    case 'first_time_or_risky':
      return risk.isFirstTime || isRisky(risk, settings);
  }
}

/** Deposit for a booking, rounded to whole cents and capped at the total. */
export function depositAmountCents(
  serviceTotalCents: number,
  rules: readonly DepositRule[],
): number {
  let total = 0;
  for (const rule of rules) {
    switch (rule.kind) {
      case 'none':
        break;
      case 'fixed':
        total += Math.max(0, Math.round(rule.amountCents));
        break;
      case 'percent':
        total += Math.round((serviceTotalCents * clampPercent(rule.percent)) / 100);
        break;
    }
  }
  return Math.min(total, serviceTotalCents);
}

function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.min(100, Math.max(0, percent));
}

/** Build the snapshot stored on the appointment at confirmation. */
export function buildPolicySnapshot(
  settings: LocationPolicySettings,
  serviceTotalCents: number,
  depositCents: number,
): PolicySnapshot {
  const window = settings.cancellationWindowHours;
  const summary =
    window === 0
      ? `Free cancellation any time. No-shows are charged ${settings.noShowFeePercent}% of the service price.`
      : `Free cancellation up to ${window} hours before your appointment. ` +
        `Cancelling later is charged ${settings.lateCancelFeePercent}% of the service price, ` +
        `and a no-show is charged ${settings.noShowFeePercent}%.`;

  return {
    version: 1,
    cancellationWindowHours: window,
    lateCancelFeePercent: settings.lateCancelFeePercent,
    noShowFeePercent: settings.noShowFeePercent,
    depositCents,
    serviceTotalCents,
    summary,
  };
}

export type CancellationOutcome =
  | { kind: 'free'; feeCents: 0 }
  | { kind: 'late'; feeCents: number; hoursNotice: number };

/**
 * What a cancellation costs, judged against the snapshot the client accepted.
 *
 * A cancellation inside the window is still far better than a no-show: the
 * slot becomes resellable and the waitlist can fill it, which is why the late
 * fee is a percentage rather than the full price.
 */
export function evaluateCancellation(
  snapshot: PolicySnapshot,
  appointmentStart: number,
  cancelledAt: number,
): CancellationOutcome {
  const hoursNotice = (appointmentStart - cancelledAt) / 3_600_000;

  if (hoursNotice >= snapshot.cancellationWindowHours) {
    return { kind: 'free', feeCents: 0 };
  }

  return {
    kind: 'late',
    feeCents: Math.round(
      (snapshot.serviceTotalCents * clampPercent(snapshot.lateCancelFeePercent)) / 100,
    ),
    hoursNotice,
  };
}

/** What a no-show costs under the accepted policy. */
export function noShowFeeCents(snapshot: PolicySnapshot): number {
  return Math.round(
    (snapshot.serviceTotalCents * clampPercent(snapshot.noShowFeePercent)) / 100,
  );
}

/**
 * A deposit already taken is credited against a later fee, so a client is
 * never charged twice for the same missed appointment.
 */
export function feeAfterDeposit(feeCents: number, depositCents: number): number {
  return Math.max(0, feeCents - depositCents);
}

export function parseDepositRule(value: unknown): DepositRule {
  if (typeof value !== 'object' || value === null) return { kind: 'none' };
  const rule = value as Record<string, unknown>;

  if (rule.kind === 'fixed' && typeof rule.amountCents === 'number') {
    return { kind: 'fixed', amountCents: rule.amountCents };
  }
  if (rule.kind === 'percent' && typeof rule.percent === 'number') {
    return { kind: 'percent', percent: rule.percent };
  }
  return { kind: 'none' };
}

export function parsePolicySnapshot(value: unknown): PolicySnapshot | null {
  if (typeof value !== 'object' || value === null) return null;
  const snap = value as Record<string, unknown>;
  if (snap.version !== 1) return null;

  return {
    version: 1,
    cancellationWindowHours: Number(snap.cancellationWindowHours ?? 0),
    lateCancelFeePercent: Number(snap.lateCancelFeePercent ?? 0),
    noShowFeePercent: Number(snap.noShowFeePercent ?? 0),
    depositCents: Number(snap.depositCents ?? 0),
    serviceTotalCents: Number(snap.serviceTotalCents ?? 0),
    summary: String(snap.summary ?? ''),
  };
}
