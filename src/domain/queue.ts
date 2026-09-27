/**
 * Walk-in queue estimation.
 *
 * Naive `position x average service time` is poor: it ignores how many
 * barbers can serve each party, ignores that a barber is mid-cut, and ignores
 * that a party waiting for one specific barber cannot be absorbed by another.
 *
 * This simulates the shop instead — assign each waiting party to the barber
 * who frees up soonest and can actually serve them, then advance that
 * barber's clock. See docs/research/02-scheduling-engine.md §2.7.
 *
 * Pure: no database, no clock of its own.
 */

export interface QueueParty {
  readonly id: string;
  /** Total service duration for what this party asked for. */
  readonly serviceMinutes: number;
  /** Null means "any barber". */
  readonly preferredStaffId?: string | null;
  /** Higher sorts earlier; used for manual reordering by the front desk. */
  readonly priority?: number;
  /** Tie-breaker within a priority band, normally the join time. */
  readonly joinedAt: number;
}

export interface BarberState {
  readonly staffId: string;
  /**
   * When this barber becomes free. Past or absent means free now.
   * Derived from the CURRENT client's actual start plus expected duration,
   * so a barber running late pushes every downstream estimate.
   */
  readonly busyUntil?: number | null;
  /** Clocked in and taking walk-ins. */
  readonly available: boolean;
}

export interface QueueEstimate {
  readonly partyId: string;
  /** 1-based position among waiting parties. */
  readonly position: number;
  /** Assigned barber in the simulation; null if nobody can serve them. */
  readonly staffId: string | null;
  /** Earliest plausible start. */
  readonly estimatedStart: number | null;
  /** Optimistic and pessimistic bounds — always present a range, never a point. */
  readonly rangeStartMinutes: number | null;
  readonly rangeEndMinutes: number | null;
}

/**
 * Uncertainty grows with queue depth: an estimate four parties out is far
 * softer than the one for whoever is next. 20% of the wait, floored at five
 * minutes, keeps the range honest without making it useless.
 */
const UNCERTAINTY_FRACTION = 0.2;
const MIN_UNCERTAINTY_MINUTES = 5;

function uncertaintyMinutes(waitMinutes: number): number {
  return Math.max(MIN_UNCERTAINTY_MINUTES, Math.round(waitMinutes * UNCERTAINTY_FRACTION));
}

/** Queue order: priority first, then join time. */
export function orderQueue(parties: readonly QueueParty[]): QueueParty[] {
  return [...parties].sort(
    (a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.joinedAt - b.joinedAt,
  );
}

/**
 * Estimate start times for everyone waiting.
 *
 * Parties keep their queue position even when their preferred barber is
 * slower than a free colleague — jumping someone ahead because they were
 * flexible is exactly the unfairness that makes clients distrust a queue.
 */
export function estimateQueue(
  parties: readonly QueueParty[],
  barbers: readonly BarberState[],
  now: number,
): QueueEstimate[] {
  const ordered = orderQueue(parties);

  // Simulated clock per barber, seeded from who is mid-cut.
  const freeAt = new Map<string, number>();
  for (const barber of barbers) {
    if (!barber.available) continue;
    freeAt.set(barber.staffId, Math.max(now, barber.busyUntil ?? now));
  }

  const estimates: QueueEstimate[] = [];

  for (const [index, party] of ordered.entries()) {
    const eligible = party.preferredStaffId
      ? [party.preferredStaffId].filter((id) => freeAt.has(id))
      : [...freeAt.keys()];

    if (eligible.length === 0) {
      estimates.push({
        partyId: party.id,
        position: index + 1,
        staffId: null,
        estimatedStart: null,
        rangeStartMinutes: null,
        rangeEndMinutes: null,
      });
      continue;
    }

    // Earliest-free wins; ties break on id so the result is deterministic.
    const chosen = eligible.reduce((best, id) =>
      freeAt.get(id)! < freeAt.get(best)! ||
      (freeAt.get(id)! === freeAt.get(best)! && id < best)
        ? id
        : best,
    );

    const start = freeAt.get(chosen)!;
    freeAt.set(chosen, start + party.serviceMinutes * 60_000);

    const waitMinutes = Math.max(0, (start - now) / 60_000);
    const slack = uncertaintyMinutes(waitMinutes);

    estimates.push({
      partyId: party.id,
      position: index + 1,
      staffId: chosen,
      estimatedStart: start,
      rangeStartMinutes: Math.max(0, Math.round(waitMinutes - slack)),
      rangeEndMinutes: Math.round(waitMinutes + slack),
    });
  }

  return estimates;
}

/**
 * Parties who should be nudged that they are nearly up.
 *
 * Clients wait elsewhere — that is the point of a virtual queue — so the
 * call-up has to reach them before the chair is free, not when it already is.
 */
export function partiesToNotify(
  estimates: readonly QueueEstimate[],
  notifyAhead: number,
  alreadyNotified: ReadonlySet<string>,
): string[] {
  return estimates
    .filter(
      (e) =>
        e.position <= notifyAhead &&
        e.estimatedStart !== null &&
        !alreadyNotified.has(e.partyId),
    )
    .map((e) => e.partyId);
}

/** Longest wait currently quoted, for the shop's "~25 min" badge. */
export function quotedWaitMinutes(estimates: readonly QueueEstimate[]): number | null {
  const waits = estimates
    .map((e) => e.rangeEndMinutes)
    .filter((w): w is number => w !== null);
  return waits.length === 0 ? null : Math.max(...waits);
}
