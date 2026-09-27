/**
 * Request authentication and authorisation.
 *
 * Two rules shape this:
 *
 *   1. Browsing is public. Availability, shop details and queue status need no
 *      account, because an auth gate in front of the booking flow is the
 *      biggest single drop-off there is (docs/research/04-apps-and-ux.md §4.1).
 *      Identity is collected at confirm.
 *
 *   2. Staff-side access is checked PER LOCATION. A barber at one shop is not
 *      staff at another, and a role that can see revenue is not the same as
 *      one that can take a booking (§4.3).
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  type Principal,
  type StaffMembership,
  loadStaffMemberships,
  resolveToken,
} from '../auth/service.js';
import { forbidden, unauthorized } from './errors.js';

export type StaffRole = StaffMembership['role'];

/** Roles that may see money: revenue, payouts, other people's earnings. */
export const FINANCIAL_ROLES: StaffRole[] = ['owner', 'manager'];

/** Roles that may run the shop floor: calendar, queue, checkout. */
export const FLOOR_ROLES: StaffRole[] = [
  'owner',
  'manager',
  'front_desk',
  'barber',
  'apprentice',
];

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal | null;
    memberships?: StaffMembership[];
  }
}

function bearerFrom(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (!token || scheme?.toLowerCase() !== 'bearer') return null;
  return token;
}

/**
 * Attach the caller's identity if they presented one.
 *
 * Never rejects: routes decide what they require. An anonymous request simply
 * arrives with no principal.
 */
export async function attachPrincipal(request: FastifyRequest): Promise<void> {
  const token = bearerFrom(request);
  if (!token) {
    request.principal = null;
    return;
  }
  request.principal = await resolveToken(token);
}

export function requirePrincipal(request: FastifyRequest): Principal {
  if (!request.principal) throw unauthorized();
  return request.principal;
}

async function membershipsFor(request: FastifyRequest): Promise<StaffMembership[]> {
  const principal = requirePrincipal(request);
  if (!request.memberships) {
    request.memberships = await loadStaffMemberships(principal.userId);
  }
  return request.memberships;
}

/**
 * Require staff access at a location, optionally in one of a set of roles.
 *
 * Returns the membership so a handler can attribute actions to the right
 * staff record without trusting a staff id from the request body.
 */
export async function requireStaff(
  request: FastifyRequest,
  locationId: string,
  roles: StaffRole[] = FLOOR_ROLES,
): Promise<StaffMembership> {
  const memberships = await membershipsFor(request);
  const membership = memberships.find(
    (m) => m.locationId === locationId && roles.includes(m.role),
  );

  if (!membership) {
    // Deliberately the same message whether they are not staff here or are
    // staff without the role: neither should reveal the shop's structure.
    throw forbidden('You do not have access to this location');
  }
  return membership;
}

/**
 * Allow either the client the record belongs to, or staff at the location.
 *
 * Used for cancelling and rescheduling: a client may manage their own
 * booking, and the front desk may manage anyone's.
 */
export async function requireOwnerOrStaff(
  request: FastifyRequest,
  locationId: string,
  clientUserId: string | null,
): Promise<{ asStaff: StaffMembership | null }> {
  const principal = requirePrincipal(request);

  if (clientUserId && clientUserId === principal.userId) {
    return { asStaff: null };
  }

  const memberships = await membershipsFor(request);
  const membership = memberships.find((m) => m.locationId === locationId);
  if (!membership) throw forbidden('This is not your booking');

  return { asStaff: membership };
}

/** Hook form, for routes that are entirely staff-only. */
export function staffOnly(roles: StaffRole[] = FLOOR_ROLES) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const params = request.params as { locationId?: string };
    if (!params.locationId) throw forbidden();
    await requireStaff(request, params.locationId, roles);
  };
}
