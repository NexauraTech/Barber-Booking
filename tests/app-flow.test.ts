import { describe, expect, it } from 'vitest';
import {
  type FlowState,
  type Service,
  canAdvance,
  initialState,
  previousStep,
  reducer,
  remainingTaps,
  selectionTotals,
} from '../app/customer/src/state/flow.js';

const services: Service[] = [
  { serviceId: 'cut', name: 'Haircut', durationMinutes: 35, priceCents: 4500, isAddon: false },
  { serviceId: 'beard', name: 'Beard trim', durationMinutes: 15, priceCents: 2000, isAddon: true },
];

/** Apply a sequence of actions from the initial state. */
const run = (...actions: Parameters<typeof reducer>[1][]): FlowState =>
  actions.reduce(reducer, initialState);

describe('service selection', () => {
  it('adds and removes services', () => {
    let state = run({ type: 'toggleService', serviceId: 'cut' });
    expect(state.serviceIds).toEqual(['cut']);

    state = reducer(state, { type: 'toggleService', serviceId: 'beard' });
    expect(state.serviceIds).toEqual(['cut', 'beard']);

    state = reducer(state, { type: 'toggleService', serviceId: 'cut' });
    expect(state.serviceIds).toEqual(['beard']);
  });

  it('clears a chosen time when the services change', () => {
    // Durations differ, so the old slot may no longer fit.
    const state = run(
      { type: 'toggleService', serviceId: 'cut' },
      { type: 'chooseBarber', staffId: 'sam' },
      { type: 'chooseSlot', start: '2026-10-01T09:00:00.000Z' },
      { type: 'toggleService', serviceId: 'beard' },
    );
    expect(state.start).toBeNull();
  });

  it('cannot advance with nothing selected', () => {
    expect(canAdvance(initialState)).toBe(false);
    expect(canAdvance(run({ type: 'toggleService', serviceId: 'cut' }))).toBe(true);
  });
});

describe('barber selection', () => {
  it('accepts "any barber" as a real choice', () => {
    const state = run(
      { type: 'toggleService', serviceId: 'cut' },
      { type: 'chooseBarber', staffId: null },
    );
    expect(state.staffId).toBeNull();
    expect(state.step).toBe('time');
  });

  it('clears a chosen time when the barber changes', () => {
    // Per-barber durations differ too.
    const state = run(
      { type: 'toggleService', serviceId: 'cut' },
      { type: 'chooseBarber', staffId: 'sam' },
      { type: 'chooseSlot', start: '2026-10-01T09:00:00.000Z' },
      { type: 'chooseBarber', staffId: 'alex' },
    );
    expect(state.start).toBeNull();
    expect(state.step).toBe('time');
  });
});

describe('identity is collected at the end', () => {
  it('sends a new user to the OTP step after picking a time', () => {
    const state = run(
      { type: 'toggleService', serviceId: 'cut' },
      { type: 'chooseBarber', staffId: 'sam' },
      { type: 'chooseSlot', start: '2026-10-01T09:00:00.000Z' },
    );
    // Browsing happened with no account at all.
    expect(state.step).toBe('identify');
  });

  it('skips the OTP step for a client already signed in', () => {
    const signedIn = { ...initialState, authenticated: true };
    const state = reducer(
      reducer(signedIn, { type: 'toggleService', serviceId: 'cut' }),
      { type: 'chooseSlot', start: '2026-10-01T09:00:00.000Z' },
    );
    expect(state.step).toBe('confirm');
  });

  it('moves to confirm once verified, keeping the chosen slot', () => {
    const state = run(
      { type: 'toggleService', serviceId: 'cut' },
      { type: 'chooseSlot', start: '2026-10-01T09:00:00.000Z' },
      { type: 'authenticated' },
    );
    expect(state.step).toBe('confirm');
    expect(state.start).toBe('2026-10-01T09:00:00.000Z');
  });

  it('returns to the time picker if verified with no slot chosen', () => {
    const state = run(
      { type: 'toggleService', serviceId: 'cut' },
      { type: 'authenticated' },
    );
    expect(state.step).toBe('time');
  });
});

describe('losing a slot', () => {
  const upToConfirm = () =>
    run(
      { type: 'toggleService', serviceId: 'cut' },
      { type: 'chooseBarber', staffId: 'sam' },
      { type: 'chooseSlot', start: '2026-10-01T09:00:00.000Z' },
      { type: 'authenticated' },
    );

  it('returns to the time picker and records which slot went', () => {
    const state = reducer(upToConfirm(), {
      type: 'slotLost',
      start: '2026-10-01T09:00:00.000Z',
    });

    // Not a restart: the user keeps their services and barber, and the UI can
    // say "09:00 just went" rather than silently clearing the selection.
    expect(state.step).toBe('time');
    expect(state.lostSlot).toBe('2026-10-01T09:00:00.000Z');
    expect(state.serviceIds).toEqual(['cut']);
    expect(state.staffId).toBe('sam');
    expect(state.start).toBeNull();
  });

  it('drops a stale hold when the slot is lost', () => {
    const held = reducer(upToConfirm(), {
      type: 'held',
      appointmentId: 'appt-1',
      holdExpiresAt: '2026-10-01T08:07:00.000Z',
      start: '2026-10-01T09:00:00.000Z',
    });
    const lost = reducer(held, { type: 'slotLost', start: '2026-10-01T09:00:00.000Z' });

    expect(lost.appointmentId).toBeNull();
    expect(lost.holdExpiresAt).toBeNull();
  });

  it('clears the notice once another slot is picked', () => {
    const lost = reducer(upToConfirm(), {
      type: 'slotLost',
      start: '2026-10-01T09:00:00.000Z',
    });
    const retried = reducer(lost, {
      type: 'chooseSlot',
      start: '2026-10-01T09:15:00.000Z',
    });
    expect(retried.lostSlot).toBeNull();
  });
});

describe('holding and confirming', () => {
  it('records the hold and its expiry', () => {
    const state = reducer(
      run(
        { type: 'toggleService', serviceId: 'cut' },
        { type: 'chooseSlot', start: '2026-10-01T09:00:00.000Z' },
        { type: 'authenticated' },
      ),
      {
        type: 'held',
        appointmentId: 'appt-1',
        holdExpiresAt: '2026-10-01T08:07:00.000Z',
        start: '2026-10-01T09:00:00.000Z',
      },
    );

    expect(state.appointmentId).toBe('appt-1');
    expect(state.holdExpiresAt).toBe('2026-10-01T08:07:00.000Z');
    expect(canAdvance(state)).toBe(true);
  });

  it('cannot confirm without a hold', () => {
    const state = run(
      { type: 'toggleService', serviceId: 'cut' },
      { type: 'chooseSlot', start: '2026-10-01T09:00:00.000Z' },
      { type: 'authenticated' },
    );
    expect(state.step).toBe('confirm');
    expect(canAdvance(state)).toBe(false);
  });

  it('clears the countdown once confirmed', () => {
    const state = reducer(
      {
        ...initialState,
        step: 'confirm',
        appointmentId: 'appt-1',
        holdExpiresAt: '2026-10-01T08:07:00.000Z',
      },
      { type: 'confirmed' },
    );
    expect(state.step).toBe('booked');
    expect(state.holdExpiresAt).toBeNull();
  });
});

describe('going back', () => {
  it('steps back one screen at a time', () => {
    expect(previousStep({ ...initialState, step: 'time' })).toBe('barber');
    expect(previousStep({ ...initialState, step: 'barber' })).toBe('services');
  });

  it('does not go back past the first screen', () => {
    expect(previousStep(initialState)).toBe('services');
  });

  it('skips the OTP screen for someone already signed in', () => {
    // Asking a signed-in client to log in again on the way back is nonsense.
    expect(
      previousStep({ ...initialState, step: 'confirm', authenticated: true }),
    ).toBe('time');
  });

  it('goes back through the OTP screen for someone who is not', () => {
    expect(
      previousStep({ ...initialState, step: 'confirm', authenticated: false }),
    ).toBe('identify');
  });
});

describe('book my usual', () => {
  it('jumps a returning client straight to the time picker', () => {
    const signedIn = { ...initialState, authenticated: true };
    const state = reducer(signedIn, {
      type: 'bookUsual',
      serviceIds: ['cut'],
      staffId: 'sam',
      date: '2026-10-29',
    });

    expect(state.step).toBe('time');
    expect(state.serviceIds).toEqual(['cut']);
    expect(state.staffId).toBe('sam');
    // Two taps left: pick a time, confirm.
    expect(remainingTaps(state)).toBeLessThanOrEqual(3);
  });

  it('gets a returning client from usual to booked in three actions', () => {
    const signedIn = { ...initialState, authenticated: true };
    const state = [
      { type: 'bookUsual' as const, serviceIds: ['cut'], staffId: 'sam', date: '2026-10-29' },
      { type: 'chooseSlot' as const, start: '2026-10-29T09:00:00.000Z' },
      {
        type: 'held' as const,
        appointmentId: 'a1',
        holdExpiresAt: null,
        start: '2026-10-29T09:00:00.000Z',
      },
      { type: 'confirmed' as const },
    ].reduce(reducer, signedIn);

    expect(state.step).toBe('booked');
  });
});

describe('reset', () => {
  it('starts a new booking but keeps the session', () => {
    const state = reducer(
      {
        ...initialState,
        step: 'booked',
        serviceIds: ['cut'],
        authenticated: true,
      },
      { type: 'reset' },
    );

    expect(state.step).toBe('services');
    expect(state.serviceIds).toEqual([]);
    // Signing the client out after booking would be gratuitous.
    expect(state.authenticated).toBe(true);
  });
});

describe('selectionTotals', () => {
  it('sums duration and price', () => {
    expect(selectionTotals(['cut', 'beard'], services)).toEqual({
      durationMinutes: 50,
      priceCents: 6500,
    });
  });

  it('is zero for an empty selection', () => {
    expect(selectionTotals([], services)).toEqual({
      durationMinutes: 0,
      priceCents: 0,
    });
  });

  it('ignores an unknown service rather than throwing', () => {
    expect(selectionTotals(['cut', 'ghost'], services).priceCents).toBe(4500);
  });
});
