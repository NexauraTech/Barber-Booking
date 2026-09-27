/**
 * Cancel a booking and immediately try to resell the slot.
 *
 * This is the whole point of the waitlist: a cancellation with 24 hours'
 * notice should become someone else's appointment within minutes, not a hole
 * in the day. Kept separate from `cancelAppointment` so cancelling stays a
 * single-purpose command — the refill is an orchestration on top, and a
 * failure to find a taker must never fail the cancellation itself.
 */
import { type CancelRequest, cancelAppointment } from './commands.js';
import { type OfferResult, offerFreedSlot } from '../waitlist/service.js';

export interface CancelAndRefillResult {
  appointmentId: string;
  feeCents: number;
  /** The waitlist offer made, if anyone matched. */
  offer: OfferResult | null;
}

export async function cancelAndRefill(
  request: CancelRequest,
): Promise<CancelAndRefillResult> {
  const now = request.now ?? Date.now();
  const result = await cancelAppointment({ ...request, now });

  let offer: OfferResult | null = null;

  // A cancellation that succeeded must stay succeeded even if the refill
  // path breaks; the client has been told they are cancelled either way.
  try {
    offer = await offerFreedSlot(
      {
        locationId: result.appointment.locationId,
        staffId: result.appointment.staffId,
        start: result.appointment.startsAt.getTime(),
        serviceIds: result.freedServiceIds,
      },
      now,
    );
  } catch {
    offer = null;
  }

  return {
    appointmentId: result.appointment.id,
    feeCents: result.feeCents,
    offer,
  };
}
