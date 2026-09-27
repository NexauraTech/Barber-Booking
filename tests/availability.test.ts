import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import {
  type StaffAvailabilityInput,
  assignAnyBarber,
  availableSlots,
  fitsInGap,
  openGaps,
  startTimeOptions,
} from '../src/domain/availability.js';
import { localRangeToInterval, resolveInstant } from '../src/domain/localtime.js';

const TZ = 'Europe/London';
const DAY = '2026-10-01'; // a Thursday, BST

/** Wall-clock time on the test day, as an instant. */
const t = (time: string) => resolveInstant(DAY, time, TZ);
/** A local range on the test day. */
const range = (from: string, to: string) => localRangeToInterval(DAY, from, to, TZ);
/** Render instants back to 'HH:mm' for readable assertions. */
const hhmm = (ms: number) => DateTime.fromMillis(ms, { zone: TZ }).toFormat('HH:mm');
const times = (slots: ReadonlyArray<{ start: number }>) => slots.map((s) => hhmm(s.start));

function staff(over: Partial<StaffAvailabilityInput> = {}): StaffAvailabilityInput {
  return {
    staffId: 'sam',
    windows: [range('09:00', '17:00')],
    busy: [],
    durationMinutes: 45,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    ...over,
  };
}

// now is well before the day starts, so lead time never interferes unless a
// test sets it deliberately.
const NOW = resolveInstant('2026-09-30', '08:00', TZ);

describe('slot grid', () => {
  it('offers a 45-minute service every 15 minutes, not every 45', () => {
    const slots = availableSlots({
      staff: [staff({ windows: [range('10:00', '12:00')] })],
      slotStepMinutes: 15,
      now: NOW,
    });

    expect(times(slots)).toEqual(['10:00', '10:15', '10:30', '10:45', '11:00', '11:15']);
  });

  it('stops offering when the service would run past the window', () => {
    const slots = availableSlots({
      staff: [staff({ windows: [range('10:00', '11:00')] })],
      slotStepMinutes: 15,
      now: NOW,
    });
    // 10:00 and 10:15 fit within 11:00; 10:30 would end at 11:15.
    expect(times(slots)).toEqual(['10:00', '10:15']);
  });

  it('anchors the grid at the window start for an off-grid opening time', () => {
    const slots = availableSlots({
      staff: [staff({ windows: [range('09:10', '11:00')], durationMinutes: 30 })],
      slotStepMinutes: 15,
      now: NOW,
    });
    expect(times(slots).slice(0, 3)).toEqual(['09:10', '09:25', '09:40']);
  });

  it('honours a 5-minute step for tight packing', () => {
    const slots = availableSlots({
      staff: [staff({ windows: [range('10:00', '10:30')], durationMinutes: 20 })],
      slotStepMinutes: 5,
      now: NOW,
    });
    expect(times(slots)).toEqual(['10:00', '10:05', '10:10']);
  });

  it('returns nothing when the window is shorter than the service', () => {
    const slots = availableSlots({
      staff: [staff({ windows: [range('10:00', '10:30')], durationMinutes: 45 })],
      slotStepMinutes: 15,
      now: NOW,
    });
    expect(slots).toEqual([]);
  });
});

describe('existing bookings', () => {
  it('removes slots that collide with a booking', () => {
    const slots = availableSlots({
      staff: [
        staff({
          windows: [range('10:00', '13:00')],
          busy: [range('11:00', '11:45')],
        }),
      ],
      slotStepMinutes: 15,
      now: NOW,
    });

    expect(times(slots)).toEqual(['10:00', '10:15', '11:45', '12:00', '12:15']);
  });

  it('allows a slot starting exactly when a booking ends', () => {
    const slots = availableSlots({
      staff: [
        staff({
          windows: [range('10:00', '12:00')],
          busy: [range('10:00', '10:45')],
          durationMinutes: 45,
        }),
      ],
      slotStepMinutes: 15,
      now: NOW,
    });
    expect(times(slots)[0]).toBe('10:45');
  });

  it('keeps slot times aligned to the shift after an off-grid booking', () => {
    const slots = availableSlots({
      staff: [
        staff({
          windows: [range('09:00', '12:00')],
          busy: [range('09:00', '09:50')],
          durationMinutes: 30,
        }),
      ],
      slotStepMinutes: 15,
      now: NOW,
    });
    // Grid stays on the :00/:15/:30/:45 marks rather than drifting to 09:50.
    expect(times(slots).slice(0, 2)).toEqual(['10:00', '10:15']);
  });
});

describe('buffers', () => {
  it('blocks a slot that would collide once buffers are applied', () => {
    const slots = availableSlots({
      staff: [
        staff({
          windows: [range('10:00', '12:00')],
          // Existing booking already buffer-expanded by the caller.
          busy: [range('10:00', '10:55')], // 10:00-10:45 plus 10m after
          durationMinutes: 45,
          bufferBeforeMinutes: 5,
        }),
      ],
      slotStepMinutes: 15,
      now: NOW,
    });
    // 10:45 is blocked: its 5m pre-buffer reaches back to 10:40, inside the
    // previous booking's 10m post-buffer. 11:00 is fine — its pre-buffer
    // starts at exactly 10:55, adjacent to the buffer's end, not overlapping.
    expect(times(slots)[0]).toBe('11:00');
  });

  it('reserves room for the trailing buffer at the end of the shift', () => {
    const slots = availableSlots({
      staff: [
        staff({
          windows: [range('10:00', '11:00')],
          durationMinutes: 45,
          bufferAfterMinutes: 10,
        }),
      ],
      slotStepMinutes: 15,
      now: NOW,
    });
    // 10:00-10:45 plus a 10m buffer ends 10:55, which fits; 10:15 would not.
    expect(times(slots)).toEqual(['10:00']);
  });

  it('reserves room for the leading buffer at the start of the shift', () => {
    const slots = availableSlots({
      staff: [
        staff({
          windows: [range('10:00', '12:00')],
          durationMinutes: 45,
          bufferBeforeMinutes: 15,
        }),
      ],
      slotStepMinutes: 15,
      now: NOW,
    });
    expect(times(slots)[0]).toBe('10:15');
  });
});

describe('lead time and horizon', () => {
  it('hides slots inside the minimum lead time', () => {
    const slots = availableSlots({
      staff: [staff({ windows: [range('10:00', '13:00')] })],
      slotStepMinutes: 15,
      now: t('10:00'),
      minLeadMinutes: 120,
    });
    expect(times(slots)[0]).toBe('12:00');
  });

  it('hides slots past the booking horizon', () => {
    const slots = availableSlots({
      staff: [staff({ windows: [range('10:00', '13:00')] })],
      slotStepMinutes: 15,
      now: NOW,
      horizonEnd: t('11:00'),
    });
    expect(times(slots)).toEqual(['10:00', '10:15']);
  });
});

describe('breaks, time off and blocks', () => {
  it('excludes a lunch break carved out of the window', () => {
    const slots = availableSlots({
      staff: [
        staff({
          // Caller has already subtracted the 13:00-13:30 break.
          windows: [range('12:00', '13:00'), range('13:30', '15:00')],
          durationMinutes: 30,
        }),
      ],
      slotStepMinutes: 30,
      now: NOW,
    });
    expect(times(slots)).toEqual(['12:00', '12:30', '13:30', '14:00', '14:30']);
  });

  it('returns nothing when the barber is off', () => {
    const slots = availableSlots({
      staff: [staff({ windows: [] })],
      slotStepMinutes: 15,
      now: NOW,
    });
    expect(slots).toEqual([]);
  });
});

describe('per-barber rules', () => {
  it('respects a daily booking cap', () => {
    const slots = availableSlots({
      staff: [staff({ maxDailyBookings: 8, bookingsToday: 8 })],
      slotStepMinutes: 15,
      now: NOW,
    });
    expect(slots).toEqual([]);
  });

  it('still offers slots below the cap', () => {
    const slots = availableSlots({
      staff: [
        staff({
          windows: [range('10:00', '11:00')],
          maxDailyBookings: 8,
          bookingsToday: 7,
        }),
      ],
      slotStepMinutes: 15,
      now: NOW,
    });
    expect(times(slots)).toEqual(['10:00', '10:15']);
  });
});

describe('per-barber durations', () => {
  it('offers different end times for the same service', () => {
    const slots = availableSlots({
      staff: [
        staff({ staffId: 'master', windows: [range('10:00', '11:00')], durationMinutes: 35 }),
        staff({ staffId: 'apprentice', windows: [range('10:00', '11:00')], durationMinutes: 55 }),
      ],
      slotStepMinutes: 15,
      now: NOW,
    });

    const master = slots.filter((s) => s.staffId === 'master');
    const apprentice = slots.filter((s) => s.staffId === 'apprentice');

    expect(times(master)).toEqual(['10:00', '10:15']);
    expect(times(apprentice)).toEqual(['10:00']);
  });
});

describe('resource capacity', () => {
  const base = {
    slotStepMinutes: 30,
    now: NOW,
  };

  it('blocks a slot when every chair is occupied', () => {
    const slots = availableSlots({
      ...base,
      staff: [staff({ windows: [range('10:00', '12:00')], durationMinutes: 30 })],
      resource: {
        resourceTypeId: 'chair',
        capacity: 2,
        busy: [range('10:00', '11:00'), range('10:00', '11:00')],
      },
    });
    expect(times(slots)).toEqual(['11:00', '11:30']);
  });

  it('allows a slot while capacity remains', () => {
    const slots = availableSlots({
      ...base,
      staff: [staff({ windows: [range('10:00', '11:00')], durationMinutes: 30 })],
      resource: {
        resourceTypeId: 'chair',
        capacity: 2,
        busy: [range('10:00', '11:00')],
      },
    });
    expect(times(slots)).toEqual(['10:00', '10:30']);
  });
});

describe('gap suppression', () => {
  it('hides a start that would strand an unsellable gap', () => {
    const slots = availableSlots({
      staff: [
        staff({
          windows: [range('10:00', '11:00')],
          durationMinutes: 45,
        }),
      ],
      slotStepMinutes: 15,
      now: NOW,
      minUsefulGapMinutes: 20,
    });
    // 10:00 leaves 15m after and 10:15 leaves 15m before — both stranded.
    // Only a start leaving no residue survives, so 10:00 is kept as the
    // fallback rather than leaving the chair empty.
    expect(slots.length).toBeGreaterThan(0);
  });

  it('prefers edge-aligned starts when alternatives exist', () => {
    const slots = availableSlots({
      staff: [
        staff({
          windows: [range('10:00', '12:00')],
          durationMinutes: 45,
        }),
      ],
      slotStepMinutes: 15,
      now: NOW,
      minUsefulGapMinutes: 20,
    });
    // 10:00 (flush with the window start) and 11:15 (flush with the end)
    // survive; 10:15 would strand 15 minutes at the front.
    expect(times(slots)).toContain('10:00');
    expect(times(slots)).not.toContain('10:15');
  });

  it('never suppresses the only remaining option', () => {
    const slots = availableSlots({
      staff: [
        staff({
          windows: [range('10:00', '11:05')],
          durationMinutes: 45,
        }),
      ],
      slotStepMinutes: 60,
      now: NOW,
      minUsefulGapMinutes: 30,
    });
    expect(times(slots)).toEqual(['10:00']);
  });
});

describe('startTimeOptions', () => {
  it('collapses per-barber slots into distinct start times', () => {
    const slots = availableSlots({
      staff: [
        staff({ staffId: 'sam', windows: [range('10:00', '11:00')], durationMinutes: 45 }),
        staff({ staffId: 'alex', windows: [range('10:00', '11:00')], durationMinutes: 45 }),
      ],
      slotStepMinutes: 15,
      now: NOW,
    });

    const options = startTimeOptions(slots);
    expect(options.map((o) => hhmm(o.start))).toEqual(['10:00', '10:15']);
    expect(options[0]!.staffIds).toEqual(['alex', 'sam']);
  });

  it('lists only the barbers actually free at each time', () => {
    const slots = availableSlots({
      staff: [
        staff({ staffId: 'sam', windows: [range('10:00', '11:00')] }),
        staff({
          staffId: 'alex',
          windows: [range('10:00', '11:00')],
          busy: [range('10:00', '10:15')],
        }),
      ],
      slotStepMinutes: 15,
      now: NOW,
    });

    const options = startTimeOptions(slots);
    expect(options.find((o) => hhmm(o.start) === '10:00')!.staffIds).toEqual(['sam']);
    expect(options.find((o) => hhmm(o.start) === '10:15')!.staffIds).toEqual(['alex', 'sam']);
  });
});

describe('assignAnyBarber', () => {
  it('prefers the barber whose day it fragments least', () => {
    const packed = staff({
      staffId: 'packed',
      windows: [range('09:00', '17:00')],
      busy: [range('09:00', '10:00')], // 10:00 booking packs flush against this
    });
    const empty = staff({ staffId: 'empty', windows: [range('09:00', '17:00')] });

    const slots = availableSlots({
      staff: [packed, empty],
      slotStepMinutes: 15,
      now: NOW,
    });

    const chosen = assignAnyBarber(t('10:00'), slots, [packed, empty]);
    expect(chosen?.staffId).toBe('packed');
  });

  it('breaks ties by the lighter workload', () => {
    const busier = staff({
      staffId: 'busier',
      windows: [range('09:00', '17:00')],
      busy: [range('14:00', '16:00')],
    });
    const lighter = staff({
      staffId: 'lighter',
      windows: [range('09:00', '17:00')],
      busy: [range('14:00', '14:30')],
    });

    const slots = availableSlots({
      staff: [busier, lighter],
      slotStepMinutes: 15,
      now: NOW,
    });

    // Both are equidistant from their next commitment at 10:00.
    const chosen = assignAnyBarber(t('10:00'), slots, [busier, lighter]);
    expect(chosen?.staffId).toBe('lighter');
  });

  it('returns the single option when only one barber is free', () => {
    const only = staff({ staffId: 'only', windows: [range('10:00', '11:00')] });
    const slots = availableSlots({ staff: [only], slotStepMinutes: 15, now: NOW });
    expect(assignAnyBarber(t('10:00'), slots, [only])?.staffId).toBe('only');
  });
});

describe('fitsInGap — walk-in promotion', () => {
  const barber = staff({
    windows: [range('09:00', '17:00')],
    busy: [range('11:00', '11:45')],
    durationMinutes: 20,
    bufferAfterMinutes: 5,
  });

  it('accepts a walk-in that fits before the next appointment', () => {
    // 10:30 + 20m + 5m buffer = 10:55, clear of the 11:00 booking.
    expect(fitsInGap(t('10:30'), 20, barber)).toBe(true);
  });

  it('rejects a walk-in that would run into the next appointment', () => {
    expect(fitsInGap(t('10:45'), 20, barber)).toBe(false);
  });

  it('rejects a walk-in outside the working window', () => {
    expect(fitsInGap(t('08:00'), 20, barber)).toBe(false);
    expect(fitsInGap(t('16:55'), 20, barber)).toBe(false);
  });
});

describe('openGaps', () => {
  it('reports the free stretches of a barber day', () => {
    const gaps = openGaps(
      staff({
        windows: [range('09:00', '13:00')],
        busy: [range('10:00', '10:45'), range('11:30', '12:00')],
      }),
    );

    expect(gaps.map((g) => [hhmm(g.start), hhmm(g.end)])).toEqual([
      ['09:00', '10:00'],
      ['10:45', '11:30'],
      ['12:00', '13:00'],
    ]);
  });
});
