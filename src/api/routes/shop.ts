import type { FastifyInstance } from 'fastify';
import { getPool } from '../../db/pool.js';
import {
  addProduct,
  addTip,
  applyDiscount,
  completeCheckout,
  getCheckout,
  openCheckoutForAppointment,
  openRetailCheckout,
  takePayment,
  voidCheckout,
} from '../../checkout/service.js';
import { waiveFee } from '../../booking/policy-service.js';
import {
  approvePayout,
  computeStaffPayout,
  getPayoutLines,
  markPayoutPaid,
} from '../../payouts/service.js';
import {
  clientMix,
  dashboardSummary,
  noShowCost,
  rebookRate,
  revenueByStaff,
  utilisation,
} from '../../reporting/queries.js';
import { joinWaitlist, acceptOffer } from '../../waitlist/service.js';
import { ensureClientForUser } from '../../auth/service.js';
import { loadLocationPolicy } from '../../db/availability-repo.js';
import { FINANCIAL_ROLES, requirePrincipal, requireStaff } from '../context.js';
import { forbidden, notFound } from '../errors.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const isoDate = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const;

/** Resolve the location a checkout belongs to, for the permission check. */
async function locationOfCheckout(checkoutId: string): Promise<string> {
  const { rows } = await getPool().query(
    `SELECT location_id FROM checkouts WHERE id = $1`,
    [checkoutId],
  );
  if (!rows[0]) throw notFound('Checkout not found');
  return rows[0].location_id;
}

export async function shopRoutes(app: FastifyInstance): Promise<void> {
  // ---- Shop catalogue: public, so the booking flow can render a menu ----

  app.get(
    '/locations/:locationId',
    {
      schema: {
        params: {
          type: 'object',
          required: ['locationId'],
          properties: { locationId: uuid },
        },
      },
    },
    async (request) => {
      const { locationId } = request.params as { locationId: string };
      const pool = getPool();

      const { rows } = await pool.query(
        `SELECT id, name, address, timezone, currency, slot_step_minutes,
                min_lead_minutes, max_horizon_days, cancellation_window_hours
           FROM locations WHERE id = $1`,
        [locationId],
      );
      if (!rows[0]) throw notFound('Location not found');

      const { rows: services } = await pool.query(
        `SELECT id, name, duration_minutes, price_cents, is_addon, category_id
           FROM services
          WHERE location_id = $1 AND active AND online_bookable
          ORDER BY name`,
        [locationId],
      );

      const { rows: staff } = await pool.query(
        `SELECT id, display_name, tier FROM staff
          WHERE location_id = $1 AND active AND accepts_online
          ORDER BY display_name`,
        [locationId],
      );

      const { rows: hours } = await pool.query(
        `SELECT weekday, opens_at, closes_at FROM opening_hours
          WHERE location_id = $1 ORDER BY weekday, opens_at`,
        [locationId],
      );

      const location = rows[0];
      return {
        locationId: location.id,
        name: location.name,
        address: location.address,
        timezone: location.timezone,
        currency: location.currency,
        cancellationWindowHours: location.cancellation_window_hours,
        openingHours: hours.map((h) => ({
          weekday: h.weekday,
          opens: h.opens_at,
          closes: h.closes_at,
        })),
        services: services.map((s) => ({
          serviceId: s.id,
          name: s.name,
          durationMinutes: s.duration_minutes,
          priceCents: s.price_cents,
          isAddon: s.is_addon,
        })),
        staff: staff.map((s) => ({
          staffId: s.id,
          name: s.display_name,
          tier: s.tier,
        })),
      };
    },
  );

  // ---- Waitlist ----

  app.post(
    '/locations/:locationId/waitlist',
    {
      schema: {
        params: {
          type: 'object',
          required: ['locationId'],
          properties: { locationId: uuid },
        },
        body: {
          type: 'object',
          required: ['serviceIds', 'fromDate', 'toDate'],
          properties: {
            serviceIds: { type: 'array', items: uuid, minItems: 1, maxItems: 10 },
            staffId: uuid,
            fromDate: isoDate,
            toDate: isoDate,
            earliestTime: { type: 'string', pattern: '^\\d{2}:\\d{2}$' },
            latestTime: { type: 'string', pattern: '^\\d{2}:\\d{2}$' },
          },
        },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const { locationId } = request.params as { locationId: string };
      const body = request.body as Record<string, any>;

      const location = await loadLocationPolicy(locationId);
      const clientId = await ensureClientForUser(principal.userId, location.orgId);

      const entry = await joinWaitlist({
        locationId,
        clientId,
        serviceIds: body.serviceIds,
        staffId: body.staffId ?? null,
        fromDate: body.fromDate,
        toDate: body.toDate,
        earliestTime: body.earliestTime ?? null,
        latestTime: body.latestTime ?? null,
      });

      return reply.status(201).send({ waitlistEntryId: entry.id, status: entry.status });
    },
  );

  /**
   * Accept a waitlist offer.
   *
   * The offer already holds the slot as a pending appointment, so accepting
   * is a promotion rather than a race — but it still expires, and a lapsed
   * offer must not silently succeed.
   */
  app.post(
    '/waitlist/:waitlistEntryId/accept',
    {
      schema: {
        params: {
          type: 'object',
          required: ['waitlistEntryId'],
          properties: { waitlistEntryId: uuid },
        },
      },
    },
    async (request) => {
      const principal = requirePrincipal(request);
      const { waitlistEntryId } = request.params as { waitlistEntryId: string };

      const { rows } = await getPool().query(
        `SELECT w.id, c.user_id
           FROM waitlist_entries w
           JOIN clients c ON c.id = w.client_id
          WHERE w.id = $1`,
        [waitlistEntryId],
      );
      if (!rows[0]) throw notFound('Waitlist entry not found');
      if (rows[0].user_id !== principal.userId) {
        throw forbidden('This offer is not yours');
      }

      const result = await acceptOffer(waitlistEntryId);
      return { appointmentId: result.appointmentId };
    },
  );

  // ---- Checkout: staff only ----

  app.post(
    '/appointments/:appointmentId/checkout',
    {
      schema: {
        params: {
          type: 'object',
          required: ['appointmentId'],
          properties: { appointmentId: uuid },
        },
      },
    },
    async (request, reply) => {
      const { appointmentId } = request.params as { appointmentId: string };

      const { rows } = await getPool().query(
        `SELECT location_id FROM appointments WHERE id = $1`,
        [appointmentId],
      );
      if (!rows[0]) throw notFound('Appointment not found');

      const membership = await requireStaff(request, rows[0].location_id);
      const checkout = await openCheckoutForAppointment(appointmentId, membership.staffId);

      return reply.status(201).send({ checkoutId: checkout.id, ...summarise(checkout) });
    },
  );

  app.post(
    '/locations/:locationId/checkout',
    {
      schema: {
        params: {
          type: 'object',
          required: ['locationId'],
          properties: { locationId: uuid },
        },
        body: { type: 'object', properties: { clientId: uuid } },
      },
    },
    async (request, reply) => {
      const { locationId } = request.params as { locationId: string };
      const body = (request.body ?? {}) as { clientId?: string };

      const membership = await requireStaff(request, locationId);
      const checkout = await openRetailCheckout(locationId, {
        clientId: body.clientId ?? null,
        cashierStaffId: membership.staffId,
      });

      return reply.status(201).send({ checkoutId: checkout.id, ...summarise(checkout) });
    },
  );

  app.get(
    '/checkouts/:checkoutId',
    {
      schema: {
        params: {
          type: 'object',
          required: ['checkoutId'],
          properties: { checkoutId: uuid },
        },
      },
    },
    async (request) => {
      const { checkoutId } = request.params as { checkoutId: string };
      await requireStaff(request, await locationOfCheckout(checkoutId));

      const detail = await getCheckout(checkoutId);
      if (!detail) throw notFound('Checkout not found');

      return {
        checkoutId,
        ...summarise(detail.checkout),
        outstandingCents: detail.outstandingCents,
        items: detail.items,
      };
    },
  );

  app.post(
    '/checkouts/:checkoutId/items',
    {
      schema: {
        params: {
          type: 'object',
          required: ['checkoutId'],
          properties: { checkoutId: uuid },
        },
        body: {
          type: 'object',
          required: ['productId'],
          properties: {
            productId: uuid,
            quantity: { type: 'integer', minimum: 1, maximum: 99 },
            soldByStaffId: uuid,
          },
        },
      },
    },
    async (request) => {
      const { checkoutId } = request.params as { checkoutId: string };
      const body = request.body as {
        productId: string;
        quantity?: number;
        soldByStaffId?: string;
      };

      const membership = await requireStaff(request, await locationOfCheckout(checkoutId));
      const checkout = await addProduct(
        checkoutId,
        body.productId,
        body.quantity ?? 1,
        body.soldByStaffId ?? membership.staffId,
      );
      return { checkoutId, ...summarise(checkout) };
    },
  );

  app.post(
    '/checkouts/:checkoutId/discount',
    {
      schema: {
        params: {
          type: 'object',
          required: ['checkoutId'],
          properties: { checkoutId: uuid },
        },
        body: {
          type: 'object',
          required: ['kind'],
          properties: {
            kind: { type: 'string', enum: ['amount', 'percent'] },
            amountCents: { type: 'integer', minimum: 0 },
            bps: { type: 'integer', minimum: 0, maximum: 10_000 },
            description: { type: 'string', maxLength: 120 },
          },
        },
      },
    },
    async (request) => {
      const { checkoutId } = request.params as { checkoutId: string };
      const body = request.body as Record<string, any>;

      await requireStaff(request, await locationOfCheckout(checkoutId));

      const rule =
        body.kind === 'amount'
          ? { kind: 'amount' as const, amountCents: body.amountCents ?? 0 }
          : { kind: 'percent' as const, bps: body.bps ?? 0 };

      const checkout = await applyDiscount(checkoutId, rule, body.description);
      return { checkoutId, ...summarise(checkout) };
    },
  );

  app.post(
    '/checkouts/:checkoutId/tip',
    {
      schema: {
        params: {
          type: 'object',
          required: ['checkoutId'],
          properties: { checkoutId: uuid },
        },
        body: {
          type: 'object',
          required: ['amountCents'],
          properties: {
            amountCents: { type: 'integer', minimum: 0 },
            staffId: uuid,
          },
        },
      },
    },
    async (request) => {
      const { checkoutId } = request.params as { checkoutId: string };
      const body = request.body as { amountCents: number; staffId?: string };

      const membership = await requireStaff(request, await locationOfCheckout(checkoutId));
      const checkout = await addTip(
        checkoutId,
        body.staffId ?? membership.staffId,
        body.amountCents,
      );
      return { checkoutId, ...summarise(checkout) };
    },
  );

  app.post(
    '/checkouts/:checkoutId/payments',
    {
      schema: {
        params: {
          type: 'object',
          required: ['checkoutId'],
          properties: { checkoutId: uuid },
        },
        body: {
          type: 'object',
          required: ['amountCents', 'method'],
          properties: {
            amountCents: { type: 'integer', minimum: 1 },
            method: {
              type: 'string',
              enum: ['card', 'cash', 'mobile_money', 'bank_transfer', 'other'],
            },
            processorRef: { type: 'string', maxLength: 200 },
          },
        },
      },
    },
    async (request) => {
      const { checkoutId } = request.params as { checkoutId: string };
      const body = request.body as {
        amountCents: number;
        method: 'card' | 'cash' | 'mobile_money' | 'bank_transfer' | 'other';
        processorRef?: string;
      };

      await requireStaff(request, await locationOfCheckout(checkoutId));
      const result = await takePayment(checkoutId, {
        amountCents: body.amountCents,
        method: body.method,
        processorRef: body.processorRef ?? null,
      });

      return { checkoutId, outstandingCents: result.outstandingCents };
    },
  );

  /** Close the sale. Returns the rebook prompt the barber should act on. */
  app.post(
    '/checkouts/:checkoutId/complete',
    {
      schema: {
        params: {
          type: 'object',
          required: ['checkoutId'],
          properties: { checkoutId: uuid },
        },
      },
    },
    async (request) => {
      const { checkoutId } = request.params as { checkoutId: string };
      await requireStaff(request, await locationOfCheckout(checkoutId));

      const result = await completeCheckout(checkoutId);
      return {
        checkoutId,
        ...summarise(result.checkout),
        rebook: result.rebook,
      };
    },
  );

  app.post(
    '/checkouts/:checkoutId/void',
    {
      schema: {
        params: {
          type: 'object',
          required: ['checkoutId'],
          properties: { checkoutId: uuid },
        },
        body: {
          type: 'object',
          required: ['reason'],
          properties: { reason: { type: 'string', minLength: 1, maxLength: 500 } },
        },
      },
    },
    async (request) => {
      const { checkoutId } = request.params as { checkoutId: string };
      const body = request.body as { reason: string };

      await requireStaff(request, await locationOfCheckout(checkoutId));
      const checkout = await voidCheckout(checkoutId, body.reason);
      return { checkoutId, status: checkout.status };
    },
  );

  /** Forgive a no-show or late-cancellation fee. */
  app.post(
    '/payments/:paymentId/waive',
    {
      schema: {
        params: {
          type: 'object',
          required: ['paymentId'],
          properties: { paymentId: uuid },
        },
        body: {
          type: 'object',
          required: ['reason'],
          properties: { reason: { type: 'string', minLength: 1, maxLength: 500 } },
        },
      },
    },
    async (request) => {
      const principal = requirePrincipal(request);
      const { paymentId } = request.params as { paymentId: string };
      const body = request.body as { reason: string };

      const { rows } = await getPool().query(
        `SELECT location_id FROM payments WHERE id = $1`,
        [paymentId],
      );
      if (!rows[0]) throw notFound('Payment not found');

      await requireStaff(request, rows[0].location_id);
      await waiveFee(paymentId, principal.userId, body.reason);
      return { paymentId, status: 'waived' };
    },
  );

  // ---- Reporting and payouts: owners and managers only ----

  app.get(
    '/locations/:locationId/reports/dashboard',
    {
      schema: {
        params: {
          type: 'object',
          required: ['locationId'],
          properties: { locationId: uuid },
        },
        querystring: { type: 'object', properties: { date: isoDate } },
      },
    },
    async (request) => {
      const { locationId } = request.params as { locationId: string };
      const query = request.query as { date?: string };

      // Money is owner/manager territory: a barber should not see the shop's
      // takings or another barber's numbers (docs/research/04-apps-and-ux.md §4.3).
      await requireStaff(request, locationId, FINANCIAL_ROLES);

      const date = query.date ?? new Date().toISOString().slice(0, 10);
      return dashboardSummary(locationId, date);
    },
  );

  app.get(
    '/locations/:locationId/reports/summary',
    {
      schema: {
        params: {
          type: 'object',
          required: ['locationId'],
          properties: { locationId: uuid },
        },
        querystring: {
          type: 'object',
          required: ['from', 'to'],
          properties: { from: isoDate, to: isoDate },
        },
      },
    },
    async (request) => {
      const { locationId } = request.params as { locationId: string };
      const range = request.query as { from: string; to: string };

      await requireStaff(request, locationId, FINANCIAL_ROLES);

      const [revenue, util, rebook, noShow, mix] = await Promise.all([
        revenueByStaff(locationId, range),
        utilisation(locationId, range),
        rebookRate(locationId, range, { windowDays: 7 }),
        noShowCost(locationId, range),
        clientMix(locationId, range),
      ]);

      return { range, revenue, utilisation: util, rebook, noShow, clientMix: mix };
    },
  );

  /**
   * Compute a payout.
   *
   * A barber may preview their OWN payout; only owners and managers may
   * compute someone else's or persist one.
   */
  app.post(
    '/staff/:staffId/payouts',
    {
      schema: {
        params: {
          type: 'object',
          required: ['staffId'],
          properties: { staffId: uuid },
        },
        body: {
          type: 'object',
          required: ['periodStart', 'periodEnd'],
          properties: {
            periodStart: isoDate,
            periodEnd: isoDate,
            persist: { type: 'boolean' },
          },
        },
      },
    },
    async (request) => {
      const { staffId } = request.params as { staffId: string };
      const body = request.body as {
        periodStart: string;
        periodEnd: string;
        persist?: boolean;
      };

      const { rows } = await getPool().query(
        `SELECT location_id FROM staff WHERE id = $1`,
        [staffId],
      );
      if (!rows[0]) throw notFound('Staff member not found');

      const membership = await requireStaff(request, rows[0].location_id);
      const isSelf = membership.staffId === staffId;
      const isFinancial = FINANCIAL_ROLES.includes(membership.role);

      if (!isSelf && !isFinancial) {
        throw forbidden('You can only view your own earnings');
      }
      if (body.persist && !isFinancial) {
        throw forbidden('Only an owner or manager can record a payout');
      }

      const payout = await computeStaffPayout({
        staffId,
        periodStart: body.periodStart,
        periodEnd: body.periodEnd,
        persist: body.persist ?? false,
      });

      return {
        payoutId: payout.payoutId,
        compensationKind: payout.compensationKind,
        serviceRevenueCents: payout.serviceRevenueCents,
        retailRevenueCents: payout.retailRevenueCents,
        serviceEarningsCents: payout.serviceEarningsCents,
        retailEarningsCents: payout.retailEarningsCents,
        tipsCents: payout.tipsCents,
        rentCents: payout.rentCents,
        netCents: payout.netCents,
        currency: payout.currency,
      };
    },
  );

  app.get(
    '/payouts/:payoutId',
    {
      schema: {
        params: {
          type: 'object',
          required: ['payoutId'],
          properties: { payoutId: uuid },
        },
      },
    },
    async (request) => {
      const { payoutId } = request.params as { payoutId: string };

      const { rows } = await getPool().query(
        `SELECT location_id, staff_id, status, net_cents, currency
           FROM payouts WHERE id = $1`,
        [payoutId],
      );
      if (!rows[0]) throw notFound('Payout not found');

      const membership = await requireStaff(request, rows[0].location_id);
      const isSelf = membership.staffId === rows[0].staff_id;
      if (!isSelf && !FINANCIAL_ROLES.includes(membership.role)) {
        throw forbidden('You can only view your own earnings');
      }

      return {
        payoutId,
        status: rows[0].status,
        netCents: rows[0].net_cents,
        currency: rows[0].currency,
        // The line-by-line backing, so a disputed figure can be checked
        // rather than taken on trust.
        lines: await getPayoutLines(payoutId),
      };
    },
  );

  app.post(
    '/payouts/:payoutId/approve',
    {
      schema: {
        params: {
          type: 'object',
          required: ['payoutId'],
          properties: { payoutId: uuid },
        },
      },
    },
    async (request) => {
      const { payoutId } = request.params as { payoutId: string };
      const { rows } = await getPool().query(
        `SELECT location_id FROM payouts WHERE id = $1`,
        [payoutId],
      );
      if (!rows[0]) throw notFound('Payout not found');

      await requireStaff(request, rows[0].location_id, FINANCIAL_ROLES);
      await approvePayout(payoutId);
      return { payoutId, status: 'approved' };
    },
  );

  app.post(
    '/payouts/:payoutId/paid',
    {
      schema: {
        params: {
          type: 'object',
          required: ['payoutId'],
          properties: { payoutId: uuid },
        },
      },
    },
    async (request) => {
      const { payoutId } = request.params as { payoutId: string };
      const { rows } = await getPool().query(
        `SELECT location_id FROM payouts WHERE id = $1`,
        [payoutId],
      );
      if (!rows[0]) throw notFound('Payout not found');

      await requireStaff(request, rows[0].location_id, FINANCIAL_ROLES);
      await markPayoutPaid(payoutId);
      return { payoutId, status: 'paid' };
    },
  );
}

function summarise(checkout: {
  status: string;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  tipCents: number;
  totalCents: number;
  currency: string;
}) {
  return {
    status: checkout.status,
    subtotalCents: checkout.subtotalCents,
    discountCents: checkout.discountCents,
    taxCents: checkout.taxCents,
    tipCents: checkout.tipCents,
    totalCents: checkout.totalCents,
    currency: checkout.currency,
  };
}
