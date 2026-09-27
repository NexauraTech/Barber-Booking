import { describe, expect, it } from 'vitest';
import {
  type BarberState,
  type QueueParty,
  estimateQueue,
  orderQueue,
  partiesToNotify,
  quotedWaitMinutes,
} from '../src/domain/queue.js';

const NOW = 1_800_000_000_000;
const min = (n: number) => n * 60_000;

const party = (
  id: string,
  serviceMinutes: number,
  over: Partial<QueueParty> = {},
): QueueParty => ({
  id,
  serviceMinutes,
  joinedAt: NOW,
  ...over,
});

const barber = (staffId: string, over: Partial<BarberState> = {}): BarberState => ({
  staffId,
  available: true,
  ...over,
});

/** Minutes from NOW until a party's estimated start. */
const waitOf = (estimates: ReturnType<typeof estimateQueue>, id: string) => {
  const e = estimates.find((x) => x.partyId === id)!;
  return e.estimatedStart === null ? null : (e.estimatedStart - NOW) / 60_000;
};

describe('orderQueue', () => {
  it('orders by join time', () => {
    const ordered = orderQueue([
      party('b', 30, { joinedAt: NOW + min(5) }),
      party('a', 30, { joinedAt: NOW }),
    ]);
    expect(ordered.map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('puts a priority bump ahead of an earlier arrival', () => {
    const ordered = orderQueue([
      party('a', 30, { joinedAt: NOW }),
      party('b', 30, { joinedAt: NOW + min(5), priority: 10 }),
    ]);
    expect(ordered.map((p) => p.id)).toEqual(['b', 'a']);
  });
});

describe('estimateQueue', () => {
  it('seats the first party immediately when a barber is free', () => {
    const estimates = estimateQueue([party('a', 30)], [barber('sam')], NOW);
    expect(waitOf(estimates, 'a')).toBe(0);
    expect(estimates[0]!.position).toBe(1);
    expect(estimates[0]!.staffId).toBe('sam');
  });

  it('queues parties behind each other on one barber', () => {
    const estimates = estimateQueue(
      [
        party('a', 30, { joinedAt: NOW }),
        party('b', 20, { joinedAt: NOW + 1 }),
        party('c', 45, { joinedAt: NOW + 2 }),
      ],
      [barber('sam')],
      NOW,
    );

    expect(waitOf(estimates, 'a')).toBe(0);
    expect(waitOf(estimates, 'b')).toBe(30);
    expect(waitOf(estimates, 'c')).toBe(50);
  });

  it('spreads parties across barbers instead of stacking them', () => {
    const estimates = estimateQueue(
      [
        party('a', 30, { joinedAt: NOW }),
        party('b', 30, { joinedAt: NOW + 1 }),
        party('c', 30, { joinedAt: NOW + 2 }),
      ],
      [barber('sam'), barber('alex')],
      NOW,
    );

    // Two barbers free now, so the first two start immediately.
    expect(waitOf(estimates, 'a')).toBe(0);
    expect(waitOf(estimates, 'b')).toBe(0);
    expect(waitOf(estimates, 'c')).toBe(30);
  });

  it('accounts for a barber who is mid-cut', () => {
    const estimates = estimateQueue(
      [party('a', 30)],
      [barber('sam', { busyUntil: NOW + min(12) })],
      NOW,
    );
    expect(waitOf(estimates, 'a')).toBe(12);
  });

  it('pushes every downstream estimate when a barber runs late', () => {
    const onTime = estimateQueue(
      [party('a', 30, { joinedAt: NOW }), party('b', 30, { joinedAt: NOW + 1 })],
      [barber('sam')],
      NOW,
    );
    const late = estimateQueue(
      [party('a', 30, { joinedAt: NOW }), party('b', 30, { joinedAt: NOW + 1 })],
      [barber('sam', { busyUntil: NOW + min(12) })],
      NOW,
    );

    expect(waitOf(late, 'a')! - waitOf(onTime, 'a')!).toBe(12);
    expect(waitOf(late, 'b')! - waitOf(onTime, 'b')!).toBe(12);
  });

  it('makes a party wait for the barber they asked for', () => {
    const estimates = estimateQueue(
      [party('a', 30, { preferredStaffId: 'sam' })],
      [barber('sam', { busyUntil: NOW + min(40) }), barber('alex')],
      NOW,
    );

    // Alex is free, but this client asked for Sam.
    expect(estimates[0]!.staffId).toBe('sam');
    expect(waitOf(estimates, 'a')).toBe(40);
  });

  it('keeps queue order even when a later party is more flexible', () => {
    const estimates = estimateQueue(
      [
        party('a', 30, { preferredStaffId: 'sam', joinedAt: NOW }),
        party('b', 30, { joinedAt: NOW + 1 }),
      ],
      [barber('sam', { busyUntil: NOW + min(40) }), barber('alex')],
      NOW,
    );

    // b takes Alex because a is waiting for Sam, but a keeps position 1.
    expect(estimates.find((e) => e.partyId === 'a')!.position).toBe(1);
    expect(estimates.find((e) => e.partyId === 'b')!.staffId).toBe('alex');
  });

  it('skips barbers who are not taking walk-ins', () => {
    const estimates = estimateQueue(
      [party('a', 30)],
      [barber('sam', { available: false }), barber('alex', { busyUntil: NOW + min(20) })],
      NOW,
    );
    expect(estimates[0]!.staffId).toBe('alex');
    expect(waitOf(estimates, 'a')).toBe(20);
  });

  it('returns no estimate when nobody can serve the party', () => {
    const estimates = estimateQueue(
      [party('a', 30, { preferredStaffId: 'jo' })],
      [barber('sam')],
      NOW,
    );
    expect(estimates[0]!.estimatedStart).toBeNull();
    expect(estimates[0]!.staffId).toBeNull();
    expect(estimates[0]!.position).toBe(1);
  });

  it('returns no estimates when every barber is unavailable', () => {
    const estimates = estimateQueue(
      [party('a', 30)],
      [barber('sam', { available: false })],
      NOW,
    );
    expect(estimates[0]!.estimatedStart).toBeNull();
  });

  it('is deterministic when barbers tie', () => {
    const run = () =>
      estimateQueue([party('a', 30)], [barber('zed'), barber('alex')], NOW)[0]!.staffId;
    expect(run()).toBe('alex');
    expect(run()).toBe('alex');
  });

  describe('estimate ranges', () => {
    it('quotes a range, never a single number', () => {
      const estimates = estimateQueue(
        [party('a', 30, { joinedAt: NOW }), party('b', 30, { joinedAt: NOW + 1 })],
        [barber('sam')],
        NOW,
      );
      const b = estimates.find((e) => e.partyId === 'b')!;
      expect(b.rangeStartMinutes).toBeLessThan(b.rangeEndMinutes!);
    });

    it('widens the range the further back you are', () => {
      const estimates = estimateQueue(
        [
          party('a', 30, { joinedAt: NOW }),
          party('b', 30, { joinedAt: NOW + 1 }),
          party('c', 30, { joinedAt: NOW + 2 }),
          party('d', 30, { joinedAt: NOW + 3 }),
        ],
        [barber('sam')],
        NOW,
      );

      const spread = (id: string) => {
        const e = estimates.find((x) => x.partyId === id)!;
        return e.rangeEndMinutes! - e.rangeStartMinutes!;
      };

      expect(spread('d')).toBeGreaterThan(spread('b'));
    });

    it('never quotes a negative wait', () => {
      const estimates = estimateQueue([party('a', 30)], [barber('sam')], NOW);
      expect(estimates[0]!.rangeStartMinutes).toBe(0);
    });
  });
});

describe('partiesToNotify', () => {
  const estimates = () =>
    estimateQueue(
      [
        party('a', 30, { joinedAt: NOW }),
        party('b', 30, { joinedAt: NOW + 1 }),
        party('c', 30, { joinedAt: NOW + 2 }),
      ],
      [barber('sam')],
      NOW,
    );

  it('nudges the parties within the notify window', () => {
    expect(partiesToNotify(estimates(), 2, new Set())).toEqual(['a', 'b']);
  });

  it('does not nudge the same party twice', () => {
    expect(partiesToNotify(estimates(), 2, new Set(['a']))).toEqual(['b']);
  });

  it('nudges nobody when the window is zero', () => {
    expect(partiesToNotify(estimates(), 0, new Set())).toEqual([]);
  });

  it('skips parties with no estimate', () => {
    const unservable = estimateQueue(
      [party('a', 30, { preferredStaffId: 'nobody' })],
      [barber('sam')],
      NOW,
    );
    expect(partiesToNotify(unservable, 2, new Set())).toEqual([]);
  });
});

describe('quotedWaitMinutes', () => {
  it('reports the longest quoted wait for the shop badge', () => {
    const estimates = estimateQueue(
      [party('a', 30, { joinedAt: NOW }), party('b', 30, { joinedAt: NOW + 1 })],
      [barber('sam')],
      NOW,
    );
    expect(quotedWaitMinutes(estimates)).toBeGreaterThanOrEqual(30);
  });

  it('is null for an empty queue', () => {
    expect(quotedWaitMinutes([])).toBeNull();
  });
});
