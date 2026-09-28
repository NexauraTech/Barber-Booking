/**
 * The booking flow, as a pure state machine.
 *
 * No React, no fetch, no clock — so the flow's rules are testable without a
 * DOM, the same discipline `src/domain` follows on the server.
 *
 * The shape follows docs/research/04-apps-and-ux.md §4.1: one decision per
 * screen, four taps from open to booked for a returning client, and identity
 * collected at the END rather than as a gate on browsing.
 */

export type Step =
  | 'services'
  | 'barber'
  | 'time'
  /** Phone + code. Reached only once a slot has been chosen. */
  | 'identify'
  | 'confirm'
  | 'booked';

export interface Service {
  serviceId: string;
  name: string;
  durationMinutes: number;
  priceCents: number;
  isAddon: boolean;
}

export interface Barber {
  staffId: string;
  name: string;
  tier: string | null;
}

export interface SlotOption {
  /** ISO instant. */
  start: string;
  end: string;
  staffIds: string[];
}

export interface FlowState {
  step: Step;
  /** Selected service ids, in the order they were tapped. */
  serviceIds: string[];
  /** null means "any barber — earliest availability". */
  staffId: string | null;
  date: string | null;
  start: string | null;
  /** Set once the server has held the slot. */
  appointmentId: string | null;
  /** Server-reported hold expiry, so the UI can show a countdown. */
  holdExpiresAt: string | null;
  /**
   * Set when a chosen slot was taken by someone else. The UI shows this in
   * place with alternatives already loaded, rather than restarting the flow.
   */
  lostSlot: string | null;
  authenticated: boolean;
}

export const initialState: FlowState = {
  step: 'services',
  serviceIds: [],
  staffId: null,
  date: null,
  start: null,
  appointmentId: null,
  holdExpiresAt: null,
  lostSlot: null,
  authenticated: false,
};

export type FlowAction =
  /** Advance one screen. Distinct from `chooseBarber`, which also commits a choice. */
  | { type: 'next' }
  | { type: 'toggleService'; serviceId: string }
  | { type: 'chooseBarber'; staffId: string | null }
  | { type: 'chooseDate'; date: string }
  | { type: 'chooseSlot'; start: string }
  | { type: 'authenticated' }
  | { type: 'held'; appointmentId: string; holdExpiresAt: string | null; start: string }
  | { type: 'slotLost'; start: string }
  | { type: 'confirmed' }
  | { type: 'back' }
  /** Returning client: skip straight to time with their usual choices. */
  | { type: 'bookUsual'; serviceIds: string[]; staffId: string | null; date: string }
  | { type: 'reset' };

const ORDER: Step[] = ['services', 'barber', 'time', 'identify', 'confirm', 'booked'];

/** The step before `step`, or itself if it is the first. */
export function previousStep(state: FlowState): Step {
  const index = ORDER.indexOf(state.step);
  if (index <= 0) return 'services';

  // Going back from confirm must not land on the OTP screen once the user is
  // already signed in — that would ask them to log in again for no reason.
  if (state.step === 'confirm' && state.authenticated) return 'time';
  return ORDER[index - 1]!;
}

export function reducer(state: FlowState, action: FlowAction): FlowState {
  switch (action.type) {
    case 'next': {
      const index = ORDER.indexOf(state.step);
      const next = ORDER[Math.min(index + 1, ORDER.length - 1)]!;
      return { ...state, step: next, lostSlot: null };
    }

    case 'toggleService': {
      const has = state.serviceIds.includes(action.serviceId);
      const serviceIds = has
        ? state.serviceIds.filter((id) => id !== action.serviceId)
        : [...state.serviceIds, action.serviceId];

      // Changing what is being booked invalidates the chosen time: durations
      // differ, so the old slot may no longer fit.
      return { ...state, serviceIds, start: null, lostSlot: null };
    }

    case 'chooseBarber':
      // Per-barber durations differ too, so the time also has to be re-picked.
      return {
        ...state,
        staffId: action.staffId,
        step: 'time',
        start: null,
        lostSlot: null,
      };

    case 'chooseDate':
      return { ...state, date: action.date, start: null, lostSlot: null };

    case 'chooseSlot':
      return {
        ...state,
        start: action.start,
        lostSlot: null,
        // Identity is collected here, at the end — never as a gate on browsing.
        step: state.authenticated ? 'confirm' : 'identify',
      };

    case 'authenticated':
      return { ...state, authenticated: true, step: state.start ? 'confirm' : 'time' };

    case 'held':
      return {
        ...state,
        appointmentId: action.appointmentId,
        holdExpiresAt: action.holdExpiresAt,
        start: action.start,
        step: 'confirm',
        lostSlot: null,
      };

    case 'slotLost':
      // Back to the time picker with the loss recorded, so the UI can say
      // which slot went instead of silently clearing the selection.
      return {
        ...state,
        step: 'time',
        start: null,
        appointmentId: null,
        holdExpiresAt: null,
        lostSlot: action.start,
      };

    case 'confirmed':
      return { ...state, step: 'booked', holdExpiresAt: null };

    case 'back':
      return { ...state, step: previousStep(state), lostSlot: null };

    case 'bookUsual':
      return {
        ...state,
        serviceIds: action.serviceIds,
        staffId: action.staffId,
        date: action.date,
        step: 'time',
        start: null,
        lostSlot: null,
      };

    case 'reset':
      return { ...initialState, authenticated: state.authenticated };
  }
}

/** Whether the user may advance from the current step. */
export function canAdvance(state: FlowState): boolean {
  switch (state.step) {
    case 'services':
      return state.serviceIds.length > 0;
    case 'barber':
      return true; // "any barber" is always a valid choice
    case 'time':
      return state.start !== null;
    case 'identify':
      return state.authenticated;
    case 'confirm':
      return state.appointmentId !== null;
    case 'booked':
      return false;
  }
}

/**
 * Taps from the current state to a booking, for the four-tap target.
 * Counts decisions, not keystrokes.
 */
export function remainingTaps(state: FlowState): number {
  return Math.max(0, ORDER.indexOf('booked') - ORDER.indexOf(state.step));
}

export interface Totals {
  durationMinutes: number;
  priceCents: number;
}

/**
 * Running total for the selected services.
 *
 * Kept visible at all times: surprise at checkout is the top complaint in app
 * reviews for this category.
 */
export function selectionTotals(
  serviceIds: readonly string[],
  services: readonly Service[],
): Totals {
  const byId = new Map(services.map((s) => [s.serviceId, s]));
  let durationMinutes = 0;
  let priceCents = 0;

  for (const id of serviceIds) {
    const service = byId.get(id);
    if (!service) continue;
    durationMinutes += service.durationMinutes;
    priceCents += service.priceCents;
  }
  return { durationMinutes, priceCents };
}
