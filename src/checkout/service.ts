/**
 * Checkout / point of sale.
 *
 * A checkout opens from a finished appointment (or standalone for a pure
 * retail sale), collects service lines, retail, discounts and tips, takes one
 * or more payments, and closes — marking the appointment completed and
 * surfacing the rebook prompt.
 *
 * Rebooking at checkout is the highest-ROI habit in the business, so
 * `completeCheckout` returns the suggestion rather than leaving it to a
 * screen to remember (docs/research/04-apps-and-ux.md §4.2).
 */
import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../db/pool.js';
import {
  type DiscountRule,
  checkoutTotals,
  discountValueCents,
  lineTotals,
  validateSplit,
} from '../domain/money.js';
import { BookingError } from '../booking/errors.js';

type Db = Pick<PoolClient, 'query'>;
const db = (client?: Db): Db => client ?? getPool();

/** A `checkouts` row, with the columns this module reads named explicitly. */
interface CheckoutRow {
  id: string;
  location_id: string;
  appointment_id: string | null;
  client_id: string | null;
  cashier_staff_id: string | null;
  status: 'open' | 'completed' | 'voided';
  total_cents: number;
  currency: string;
  prices_include_tax: boolean;
  [column: string]: unknown;
}

export interface Checkout {
  id: string;
  locationId: string;
  appointmentId: string | null;
  clientId: string | null;
  status: 'open' | 'completed' | 'voided';
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  tipCents: number;
  totalCents: number;
  currency: string;
  pricesIncludeTax: boolean;
}

function toCheckout(row: Record<string, any>): Checkout {
  return {
    id: row.id,
    locationId: row.location_id,
    appointmentId: row.appointment_id,
    clientId: row.client_id,
    status: row.status,
    subtotalCents: row.subtotal_cents,
    discountCents: row.discount_cents,
    taxCents: row.tax_cents,
    tipCents: row.tip_cents,
    totalCents: row.total_cents,
    currency: row.currency,
    pricesIncludeTax: row.prices_include_tax,
  };
}

/**
 * Open a checkout for an appointment, pre-filled with its services.
 *
 * Idempotent per appointment: the unique partial index means a second attempt
 * returns the open till rather than creating a rival one, so two staff
 * ringing up the same client cannot produce two sales.
 */
export async function openCheckoutForAppointment(
  appointmentId: string,
  cashierStaffId?: string | null,
): Promise<Checkout> {
  return withTransaction(async (client) => {
    const existing = await client.query(
      `SELECT * FROM checkouts WHERE appointment_id = $1 AND status = 'open'`,
      [appointmentId],
    );
    if (existing.rows[0]) return toCheckout(existing.rows[0]);

    const { rows: appts } = await client.query(
      `SELECT a.*, l.currency, l.prices_include_tax, l.default_tax_rate_bps
         FROM appointments a
         JOIN locations l ON l.id = a.location_id
        WHERE a.id = $1`,
      [appointmentId],
    );
    const appointment = appts[0];
    if (!appointment) throw new BookingError('NOT_FOUND', 'Appointment not found');

    if (['cancelled', 'no_show'].includes(appointment.status)) {
      throw new BookingError(
        'INVALID_STATE',
        `Cannot check out an appointment that is ${appointment.status}`,
      );
    }

    const { rows } = await client.query(
      `INSERT INTO checkouts
         (location_id, appointment_id, client_id, cashier_staff_id,
          currency, prices_include_tax)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [
        appointment.location_id,
        appointmentId,
        appointment.client_id,
        cashierStaffId ?? null,
        appointment.currency,
        appointment.prices_include_tax,
      ],
    );
    const checkout = rows[0];

    // Pre-fill from what was actually booked, at the prices snapshotted then.
    const { rows: services } = await client.query(
      `SELECT service_id, name, price_cents, sort_order
         FROM appointment_services WHERE appointment_id = $1 ORDER BY sort_order`,
      [appointmentId],
    );

    for (const service of services) {
      await insertItem(
        client,
        checkout,
        {
          kind: 'service',
          serviceId: service.service_id,
          name: service.name,
          quantity: 1,
          unitPriceCents: service.price_cents,
          taxRateBps: appointment.default_tax_rate_bps,
          earnedByStaffId: appointment.staff_id,
          sortOrder: service.sort_order,
        },
      );
    }

    return toCheckout(await recalculate(client, checkout.id));
  });
}

/** A standalone retail sale with no appointment behind it. */
export async function openRetailCheckout(
  locationId: string,
  options: { clientId?: string | null; cashierStaffId?: string | null } = {},
): Promise<Checkout> {
  const { rows: locations } = await getPool().query(
    `SELECT currency, prices_include_tax FROM locations WHERE id = $1`,
    [locationId],
  );
  if (!locations[0]) throw new BookingError('NOT_FOUND', 'Location not found');

  const { rows } = await getPool().query(
    `INSERT INTO checkouts
       (location_id, client_id, cashier_staff_id, currency, prices_include_tax)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [
      locationId,
      options.clientId ?? null,
      options.cashierStaffId ?? null,
      locations[0].currency,
      locations[0].prices_include_tax,
    ],
  );
  return toCheckout(rows[0]);
}

interface ItemInput {
  kind: 'service' | 'product' | 'discount';
  serviceId?: string | null;
  productId?: string | null;
  name: string;
  quantity: number;
  unitPriceCents: number;
  taxRateBps: number;
  earnedByStaffId?: string | null;
  sortOrder?: number;
}

async function insertItem(
  client: Db,
  checkout: Pick<CheckoutRow, 'id' | 'prices_include_tax'>,
  item: ItemInput,
): Promise<void> {
  const totals = lineTotals(
    {
      quantity: item.quantity,
      unitPriceCents: item.unitPriceCents,
      taxRateBps: item.taxRateBps,
      kind: item.kind,
    },
    checkout.prices_include_tax,
  );

  await client.query(
    `INSERT INTO checkout_items
       (checkout_id, kind, service_id, product_id, name, quantity,
        unit_price_cents, line_total_cents, tax_rate_bps, tax_cents,
        earned_by_staff_id, sort_order)
     VALUES ($1,$2::checkout_item_kind,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      checkout.id,
      item.kind,
      item.serviceId ?? null,
      item.productId ?? null,
      item.name,
      item.quantity,
      item.unitPriceCents,
      totals.lineTotalCents,
      item.taxRateBps,
      totals.taxCents,
      item.earnedByStaffId ?? null,
      item.sortOrder ?? 0,
    ],
  );
}

/** Recompute and store the checkout's totals from its current lines. */
async function recalculate(client: Db, checkoutId: string): Promise<CheckoutRow> {
  const { rows: checkouts } = await client.query(
    `SELECT * FROM checkouts WHERE id = $1`,
    [checkoutId],
  );
  const checkout = checkouts[0];

  const { rows: items } = await client.query(
    `SELECT kind, line_total_cents, tax_cents FROM checkout_items WHERE checkout_id = $1`,
    [checkoutId],
  );
  const { rows: tips } = await client.query(
    `SELECT coalesce(sum(amount_cents), 0)::int AS total
       FROM checkout_tips WHERE checkout_id = $1`,
    [checkoutId],
  );

  const totals = checkoutTotals(
    items.map((i) => ({
      kind: i.kind,
      lineTotalCents: i.line_total_cents,
      taxCents: i.tax_cents,
    })),
    tips[0].total,
    checkout.prices_include_tax,
  );

  const { rows } = await client.query(
    `UPDATE checkouts
        SET subtotal_cents = $2, discount_cents = $3, tax_cents = $4,
            tip_cents = $5, total_cents = $6
      WHERE id = $1
    RETURNING *`,
    [
      checkoutId,
      totals.subtotalCents,
      totals.discountCents,
      totals.taxCents,
      totals.tipCents,
      totals.totalCents,
    ],
  );
  return rows[0];
}

async function requireOpen(client: Db, checkoutId: string): Promise<CheckoutRow> {
  const { rows } = await client.query(
    `SELECT * FROM checkouts WHERE id = $1 FOR UPDATE`,
    [checkoutId],
  );
  const checkout = rows[0];
  if (!checkout) throw new BookingError('NOT_FOUND', 'Checkout not found');
  if (checkout.status !== 'open') {
    throw new BookingError('INVALID_STATE', `Checkout is already ${checkout.status}`);
  }
  return checkout;
}

/** Add a retail product, decrementing stock where it is tracked. */
export async function addProduct(
  checkoutId: string,
  productId: string,
  quantity = 1,
  soldByStaffId?: string | null,
): Promise<Checkout> {
  return withTransaction(async (client) => {
    const checkout = await requireOpen(client, checkoutId);

    // A product's own tax rate wins; otherwise fall back to the location
    // default. `checkouts` carries no tax rate of its own.
    const { rows: products } = await client.query(
      `SELECT p.*, l.default_tax_rate_bps
         FROM products p
         JOIN locations l ON l.id = p.location_id
        WHERE p.id = $1 AND p.active
          FOR UPDATE OF p`,
      [productId],
    );
    const product = products[0];
    if (!product) throw new BookingError('NOT_FOUND', 'Product not found');

    if (product.track_stock && product.stock_quantity < quantity) {
      throw new BookingError('INVALID_STATE', `Only ${product.stock_quantity} left in stock`, {
        available: product.stock_quantity,
      });
    }

    await insertItem(client, checkout, {
      kind: 'product',
      productId,
      name: product.name,
      quantity,
      unitPriceCents: product.price_cents,
      taxRateBps: product.tax_rate_bps ?? product.default_tax_rate_bps ?? 0,
      earnedByStaffId: soldByStaffId ?? checkout.cashier_staff_id,
    });

    if (product.track_stock) {
      await client.query(
        `UPDATE products SET stock_quantity = stock_quantity - $2 WHERE id = $1`,
        [productId, quantity],
      );
    }

    return toCheckout(await recalculate(client, checkoutId));
  });
}

/**
 * Apply a discount as a negative line.
 *
 * Tax is reduced proportionally: discounting a taxed sale must reduce the tax
 * owed, or the shop pays tax on revenue it never took.
 */
export async function applyDiscount(
  checkoutId: string,
  rule: DiscountRule,
  description = 'Discount',
): Promise<Checkout> {
  return withTransaction(async (client) => {
    const checkout = await requireOpen(client, checkoutId);

    const { rows: items } = await client.query(
      `SELECT line_total_cents, tax_rate_bps FROM checkout_items
        WHERE checkout_id = $1 AND kind <> 'discount'`,
      [checkoutId],
    );

    const grossCents = items.reduce((a, i) => a + i.line_total_cents, 0);
    const value = discountValueCents(rule, grossCents);
    if (value === 0) return toCheckout(await recalculate(client, checkoutId));

    // Blended rate across the taxed lines, so the tax relief matches what was
    // actually charged rather than assuming one rate.
    const weightedTaxBps =
      grossCents === 0
        ? 0
        : Math.round(
            items.reduce((a, i) => a + i.line_total_cents * i.tax_rate_bps, 0) / grossCents,
          );

    await insertItem(client, checkout, {
      kind: 'discount',
      name: description,
      quantity: 1,
      unitPriceCents: -value,
      taxRateBps: weightedTaxBps,
    });

    return toCheckout(await recalculate(client, checkoutId));
  });
}

/** Record a tip, attributed to the barber who earned it. */
export async function addTip(
  checkoutId: string,
  staffId: string,
  amountCents: number,
): Promise<Checkout> {
  return withTransaction(async (client) => {
    await requireOpen(client, checkoutId);

    await client.query(
      `INSERT INTO checkout_tips (checkout_id, staff_id, amount_cents)
       VALUES ($1,$2,$3)
       ON CONFLICT (checkout_id, staff_id)
         DO UPDATE SET amount_cents = EXCLUDED.amount_cents`,
      [checkoutId, staffId, amountCents],
    );

    return toCheckout(await recalculate(client, checkoutId));
  });
}

export interface PaymentInput {
  amountCents: number;
  method: 'card' | 'cash' | 'mobile_money' | 'bank_transfer' | 'other';
  processorRef?: string | null;
}

/**
 * Take a payment against the checkout.
 *
 * Several calls make a split payment. Cash is a first-class method, not a
 * fallback: in several of this product's target markets it is the norm
 * (docs/research/01-market-landscape.md §1.6).
 */
export async function takePayment(
  checkoutId: string,
  payment: PaymentInput,
): Promise<{ checkout: Checkout; outstandingCents: number }> {
  return withTransaction(async (client) => {
    const checkout = await requireOpen(client, checkoutId);

    if (payment.amountCents <= 0) {
      throw new BookingError('INVALID_STATE', 'Payment amount must be positive');
    }

    await client.query(
      `INSERT INTO payments
         (location_id, checkout_id, appointment_id, client_id, amount_cents,
          currency, kind, method, status, processor_ref)
       VALUES ($1,$2,$3,$4,$5,$6,'service',$7::payment_method,'captured',$8)`,
      [
        checkout.location_id,
        checkoutId,
        checkout.appointment_id,
        checkout.client_id,
        payment.amountCents,
        checkout.currency,
        payment.method,
        payment.processorRef ?? null,
      ],
    );

    return {
      checkout: toCheckout(checkout),
      outstandingCents: await outstandingFor(client, checkout),
    };
  });
}

async function outstandingFor(client: Db, checkout: CheckoutRow): Promise<number> {
  const { rows } = await client.query(
    `SELECT coalesce(sum(amount_cents), 0)::int AS paid
       FROM payments
      WHERE checkout_id = $1 AND status = 'captured' AND kind <> 'refund'`,
    [checkout.id],
  );

  // A deposit taken at booking counts towards the bill.
  const { rows: deposits } = await client.query(
    `SELECT coalesce(sum(amount_cents), 0)::int AS held
       FROM payments
      WHERE appointment_id = $1 AND kind = 'deposit'
        AND status IN ('captured','authorized','pending')
        AND checkout_id IS NULL`,
    [checkout.appointment_id],
  );

  return Math.max(0, checkout.total_cents - rows[0].paid - deposits[0].held);
}

export interface RebookSuggestion {
  clientId: string;
  staffId: string;
  serviceIds: string[];
  /** The client's usual gap between visits, in weeks. */
  intervalWeeks: number;
  /** The date to open the booking screen on. */
  suggestedDate: string;
}

export interface CompleteResult {
  checkout: Checkout;
  /** Null when the bill is not fully settled. */
  rebook: RebookSuggestion | null;
}

/**
 * Close the sale.
 *
 * Refuses to complete while money is outstanding — a till that lets you walk
 * away mid-payment produces books nobody can reconcile.
 *
 * Marks the appointment completed and returns a rebook suggestion, because
 * booking the next visit at the chair is worth more than any marketing
 * campaign.
 */
export async function completeCheckout(
  checkoutId: string,
  now: Date = new Date(),
): Promise<CompleteResult> {
  return withTransaction(async (client) => {
    const checkout = await requireOpen(client, checkoutId);

    const outstanding = await outstandingFor(client, checkout);
    if (outstanding > 0) {
      throw new BookingError('INVALID_STATE', 'Checkout is not fully paid', {
        outstandingCents: outstanding,
      });
    }

    const { rows } = await client.query(
      `UPDATE checkouts SET status = 'completed', completed_at = $2
        WHERE id = $1 RETURNING *`,
      [checkoutId, now],
    );

    let rebook: RebookSuggestion | null = null;

    if (checkout.appointment_id) {
      await client.query(
        `UPDATE appointments
            SET status = 'completed', completed_at = $2
          WHERE id = $1 AND status <> 'completed'`,
        [checkout.appointment_id, now],
      );
      rebook = await buildRebookSuggestion(client, checkout, now);
    }

    return { checkout: toCheckout(rows[0]), rebook };
  });
}

/**
 * Suggest the next visit.
 *
 * Uses the client's own rhythm where it is known, then their stated
 * preference, then a four-week default — the typical barbershop interval.
 */
async function buildRebookSuggestion(
  client: Db,
  checkout: CheckoutRow,
  now: Date,
): Promise<RebookSuggestion | null> {
  const { rows: appts } = await client.query(
    `SELECT a.client_id, a.staff_id, a.starts_at, l.timezone
       FROM appointments a
       JOIN locations l ON l.id = a.location_id
      WHERE a.id = $1`,
    [checkout.appointment_id],
  );
  const appointment = appts[0];
  if (!appointment?.client_id) return null;

  const { rows: services } = await client.query(
    `SELECT service_id FROM appointment_services
      WHERE appointment_id = $1 ORDER BY sort_order`,
    [checkout.appointment_id],
  );

  // Median gap between this client's recent completed visits.
  const { rows: rhythm } = await client.query(
    `SELECT avg(gap)::float AS avg_weeks FROM (
        SELECT extract(epoch FROM starts_at
               - lag(starts_at) OVER (ORDER BY starts_at)) / 604800 AS gap
          FROM appointments
         WHERE client_id = $1 AND status = 'completed'
         ORDER BY starts_at DESC
         LIMIT 6
     ) gaps WHERE gap IS NOT NULL`,
    [appointment.client_id],
  );

  const { rows: prefs } = await client.query(
    `SELECT interval_weeks FROM client_preferences WHERE client_id = $1`,
    [appointment.client_id],
  );

  const intervalWeeks =
    rhythm[0]?.avg_weeks != null
      ? Math.max(1, Math.round(rhythm[0].avg_weeks))
      : (prefs[0]?.interval_weeks ?? 4);

  const suggested = new Date(now.getTime() + intervalWeeks * 7 * 86_400_000);

  return {
    clientId: appointment.client_id,
    staffId: appointment.staff_id,
    serviceIds: services.map((s) => s.service_id),
    intervalWeeks,
    suggestedDate: suggested.toISOString().slice(0, 10),
  };
}

/** Void an open checkout, returning any tracked stock. */
export async function voidCheckout(
  checkoutId: string,
  reason: string,
  now: Date = new Date(),
): Promise<Checkout> {
  return withTransaction(async (client) => {
    await requireOpen(client, checkoutId);

    const { rows: items } = await client.query(
      `SELECT product_id, quantity FROM checkout_items
        WHERE checkout_id = $1 AND kind = 'product' AND product_id IS NOT NULL`,
      [checkoutId],
    );

    for (const item of items) {
      await client.query(
        `UPDATE products SET stock_quantity = stock_quantity + $2
          WHERE id = $1 AND track_stock`,
        [item.product_id, item.quantity],
      );
    }

    const { rows } = await client.query(
      `UPDATE checkouts SET status = 'voided', voided_at = $2, void_reason = $3
        WHERE id = $1 RETURNING *`,
      [checkoutId, now, reason],
    );
    return toCheckout(rows[0]);
  });
}

export async function getCheckout(checkoutId: string): Promise<{
  checkout: Checkout;
  items: Array<{ kind: string; name: string; quantity: number; lineTotalCents: number }>;
  outstandingCents: number;
} | null> {
  const pool = getPool();
  const { rows } = await pool.query(`SELECT * FROM checkouts WHERE id = $1`, [checkoutId]);
  if (!rows[0]) return null;

  const { rows: items } = await pool.query(
    `SELECT kind, name, quantity, line_total_cents FROM checkout_items
      WHERE checkout_id = $1 ORDER BY sort_order, name`,
    [checkoutId],
  );

  return {
    checkout: toCheckout(rows[0]),
    items: items.map((i) => ({
      kind: i.kind,
      name: i.name,
      quantity: i.quantity,
      lineTotalCents: i.line_total_cents,
    })),
    outstandingCents: await outstandingFor(pool, rows[0]),
  };
}

export { validateSplit };
