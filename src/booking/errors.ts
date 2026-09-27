/** Booking failures a caller is expected to handle, rather than 500s. */

export type BookingErrorCode =
  | 'SLOT_TAKEN'
  | 'HOLD_EXPIRED'
  | 'HOLD_NOT_YOURS'
  | 'NOT_BOOKABLE'
  | 'NO_ELIGIBLE_STAFF'
  | 'NOT_FOUND'
  | 'INVALID_STATE';

export class BookingError extends Error {
  constructor(
    readonly code: BookingErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'BookingError';
  }
}

/** Postgres error code for an exclusion-constraint violation. */
const EXCLUSION_VIOLATION = '23P01';

/**
 * True when an error is the no_overlap_per_staff constraint firing — i.e.
 * another request won the race for this slot. That is a 409 with a refreshed
 * slot list, never a 500.
 */
export function isSlotConflict(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: string; constraint?: string };
  return e.code === EXCLUSION_VIOLATION && e.constraint === 'no_overlap_per_staff';
}
