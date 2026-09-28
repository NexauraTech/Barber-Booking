import { describe, expect, it } from 'vitest';
import {
  addDays,
  applySlotDelta,
  formatCountdown,
  formatDate,
  formatDuration,
  formatMoney,
  formatTime,
  formatWaitRange,
  groupByDaypart,
  isoDateIn,
} from '../app/customer/src/state/format.js';
import type { SlotOption } from '../app/customer/src/state/flow.js';

const slot = (start: string): SlotOption => ({ start, end: start, staffIds: ['sam'] });

describe('formatMoney', () => {
  it('omits pennies for whole amounts', () => {
    expect(formatMoney(4500, 'GBP', 'en-GB')).toBe('£45');
  });

  it('shows pennies when there are any', () => {
    expect(formatMoney(4550, 'GBP', 'en-GB')).toBe('£45.50');
  });

  it('respects the currency', () => {
    expect(formatMoney(4500, 'USD', 'en-US')).toBe('$45');
  });

  it('handles zero', () => {
    expect(formatMoney(0, 'GBP', 'en-GB')).toBe('£0');
  });
});

describe('formatDuration', () => {
  it('shows minutes under an hour', () => {
    expect(formatDuration(35)).toBe('35 min');
  });

  it('shows whole hours', () => {
    expect(formatDuration(120)).toBe('2 hr');
  });

  it('shows hours and minutes', () => {
    expect(formatDuration(95)).toBe('1 hr 35 min');
  });
});

describe('formatTime — always the shop\'s timezone', () => {
  const instant = '2026-10-01T08:00:00.000Z';

  it('renders in the shop timezone, not the device one', () => {
    expect(formatTime(instant, 'Europe/London')).toBe('09:00');
    expect(formatTime(instant, 'Asia/Karachi')).toBe('13:00');
    expect(formatTime(instant, 'America/New_York')).toBe('04:00');
  });

  it('uses a 24-hour clock so 09:00 is never ambiguous', () => {
    expect(formatTime('2026-10-01T18:30:00.000Z', 'Europe/London')).toBe('19:30');
  });
});

describe('formatDate', () => {
  it('renders a weekday and date in the shop timezone', () => {
    expect(formatDate('2026-10-01', 'Europe/London', 'en-GB')).toBe('Thu 1 Oct');
  });

  it('never shifts the day, even for a zone far from UTC', () => {
    // The date string is already the shop's local date, so UTC+13 must not
    // turn 1 Oct into 2 Oct.
    for (const tz of ['Pacific/Auckland', 'Pacific/Kiritimati', 'America/Anchorage']) {
      expect(formatDate('2026-10-01', tz, 'en-GB')).toBe('Thu 1 Oct');
    }
  });
});

describe('isoDateIn', () => {
  it('gives the local date in the shop timezone', () => {
    // 23:30 UTC is already tomorrow in Karachi.
    const instant = Date.parse('2026-10-01T23:30:00.000Z');
    expect(isoDateIn(instant, 'Europe/London')).toBe('2026-10-02');
    expect(isoDateIn(instant, 'Asia/Karachi')).toBe('2026-10-02');
    expect(isoDateIn(instant, 'America/New_York')).toBe('2026-10-01');
  });
});

describe('addDays', () => {
  it('advances a date', () => {
    expect(addDays('2026-10-01', 1)).toBe('2026-10-02');
  });

  it('crosses a month boundary', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
  });

  it('crosses a DST boundary without slipping', () => {
    // Europe/London falls back on 2026-10-25.
    expect(addDays('2026-10-24', 2)).toBe('2026-10-26');
  });

  it('goes backwards', () => {
    expect(addDays('2026-10-01', -1)).toBe('2026-09-30');
  });
});

describe('groupByDaypart', () => {
  it('splits slots into morning, afternoon and evening', () => {
    const groups = groupByDaypart(
      [
        slot('2026-10-01T08:00:00.000Z'), // 09:00 London
        slot('2026-10-01T12:00:00.000Z'), // 13:00
        slot('2026-10-01T17:00:00.000Z'), // 18:00
      ],
      'Europe/London',
    );

    expect(groups.map((g) => g.daypart)).toEqual(['Morning', 'Afternoon', 'Evening']);
    expect(groups[0]!.slots).toHaveLength(1);
  });

  it('drops empty groups rather than rendering blank headings', () => {
    const groups = groupByDaypart([slot('2026-10-01T08:00:00.000Z')], 'Europe/London');
    expect(groups).toHaveLength(1);
    expect(groups[0]!.daypart).toBe('Morning');
  });

  it('groups by the shop timezone, not the device one', () => {
    // 08:00 UTC is morning in London but afternoon in Karachi.
    expect(groupByDaypart([slot('2026-10-01T08:00:00.000Z')], 'Europe/London')[0]!.daypart)
      .toBe('Morning');
    expect(groupByDaypart([slot('2026-10-01T08:00:00.000Z')], 'Asia/Karachi')[0]!.daypart)
      .toBe('Afternoon');
  });

  it('returns nothing for no slots', () => {
    expect(groupByDaypart([], 'Europe/London')).toEqual([]);
  });

  it('puts noon in the afternoon and 17:00 in the evening', () => {
    const noon = groupByDaypart([slot('2026-10-01T11:00:00.000Z')], 'Europe/London');
    expect(noon[0]!.daypart).toBe('Afternoon');
    const five = groupByDaypart([slot('2026-10-01T16:00:00.000Z')], 'Europe/London');
    expect(five[0]!.daypart).toBe('Evening');
  });
});

describe('applySlotDelta', () => {
  const slots = [
    slot('2026-10-01T09:00:00.000Z'),
    slot('2026-10-01T09:15:00.000Z'),
    slot('2026-10-01T09:30:00.000Z'),
  ];

  it('removes a slot someone else took', () => {
    const next = applySlotDelta(slots, { taken: ['2026-10-01T09:15:00.000Z'] });
    expect(next.map((s) => s.start)).toEqual([
      '2026-10-01T09:00:00.000Z',
      '2026-10-01T09:30:00.000Z',
    ]);
  });

  it('adds back a released slot', () => {
    const next = applySlotDelta(slots, { released: ['2026-10-01T08:45:00.000Z'] });
    expect(next[0]!.start).toBe('2026-10-01T08:45:00.000Z');
  });

  it('does not duplicate a released slot it already has', () => {
    const next = applySlotDelta(slots, { released: ['2026-10-01T09:00:00.000Z'] });
    expect(next).toHaveLength(3);
  });

  it('keeps the list sorted', () => {
    const next = applySlotDelta(slots, { released: ['2026-10-01T09:45:00.000Z'] });
    expect(next.map((s) => s.start)).toEqual([...next.map((s) => s.start)].sort());
  });

  it('handles both directions at once', () => {
    const next = applySlotDelta(slots, {
      taken: ['2026-10-01T09:00:00.000Z'],
      released: ['2026-10-01T09:45:00.000Z'],
    });
    expect(next.map((s) => s.start)).toEqual([
      '2026-10-01T09:15:00.000Z',
      '2026-10-01T09:30:00.000Z',
      '2026-10-01T09:45:00.000Z',
    ]);
  });

  it('is a no-op for an empty delta', () => {
    expect(applySlotDelta(slots, {})).toHaveLength(3);
  });
});

describe('formatCountdown', () => {
  it('shows minutes and seconds', () => {
    expect(formatCountdown(4.5 * 60_000)).toBe('4:30');
  });

  it('drops to seconds under a minute', () => {
    expect(formatCountdown(45_000)).toBe('45s');
  });

  it('says expired at zero and below', () => {
    expect(formatCountdown(0)).toBe('expired');
    expect(formatCountdown(-1000)).toBe('expired');
  });

  it('pads the seconds', () => {
    expect(formatCountdown(61_000)).toBe('1:01');
  });
});

describe('formatWaitRange', () => {
  it('always shows a range, never a false precision', () => {
    expect(formatWaitRange({ from: 20, to: 30 })).toBe('~20–30 min');
  });

  it("says you're next at zero", () => {
    expect(formatWaitRange({ from: 0, to: 0 })).toBe("You're next");
  });

  it('collapses an identical range', () => {
    expect(formatWaitRange({ from: 15, to: 15 })).toBe('~15 min');
  });

  it('admits when it does not know', () => {
    expect(formatWaitRange(null)).toBe('Wait unknown');
  });
});
