/**
 * Payout computation.
 *
 * Gathers a barber's earning lines for a period, applies their compensation
 * terms, and stores the result with its line-by-line backing — so a barber
 * questioning a figure can be shown the sales it came from rather than being
 * asked to trust a total.
 */
import { getPool, withTransaction } from '../db/pool.js';
import type { PoolClient } from 'pg';
import {
  type CompensationTerms,
  type EarningLine,
  type PayoutSummary,
  computePayout,
} from '../domain/compensation.js';
import { BookingError } from '../booking/errors.js';

type Db = Pick<PoolClient, 'query'>;
const db = (client?: Db): Db => client ?? getPool();

/**
 * The terms in force on a date.
 *
 * Effective-dated, so recomputing an old period uses the deal that applied
 * then rather than whatever was agreed since.
 */
export async function loadCompensation(
  staffId: string,
  onDate: string,
  client?: Db,
): Promise<CompensationTerms | null> {
  const { rows } = await db(client).query(
    `SELECT kind, service_commission_bps, retail_commission_bps,
            rent_cents_per_week, tips_retained_bps
       FROM staff_compensation
      WHERE staff_id = $1
        AND effective_from <= $2::date
        AND (effective_to IS NULL OR effective_to >= $2::date)
      ORDER BY effective_from DESC
      LIMIT 1`,
    [staffId, onDate],
  );

  const row = rows[0];
  if (!row) return null;

  return {
    kind: row.kind,
    serviceCommissionBps: row.service_commission_bps,
    retailCommissionBps: row.retail_commission_bps,
    rentCentsPerWeek: row.rent_cents_per_week,
    tipsRetainedBps: row.tips_retained_bps,
  };
}

/**
 * A barber's earning lines for a period.
 *
 * Only COMPLETED checkouts count. Paying commission on an open till would
 * mean paying out on sales that might still be voided.
 */
async function loadEarningLines(
  staffId: string,
  periodStart: string,
  periodEnd: string,
  client?: Db,
): Promise<EarningLine[]> {
  const { rows: items } = await db(client).query(
    `SELECT ci.id, ci.checkout_id, ci.kind, ci.name,
            ci.line_total_cents, c.completed_at
       FROM checkout_items ci
       JOIN checkouts c ON c.id = ci.checkout_id
      WHERE ci.earned_by_staff_id = $1
        AND c.status = 'completed'
        AND c.completed_at >= $2::date
        AND c.completed_at < ($3::date + 1)
        AND ci.kind IN ('service','product')
      ORDER BY c.completed_at`,
    [staffId, periodStart, periodEnd],
  );

  const { rows: tips } = await db(client).query(
    `SELECT t.id, t.checkout_id, t.amount_cents, c.completed_at
       FROM checkout_tips t
       JOIN checkouts c ON c.id = t.checkout_id
      WHERE t.staff_id = $1
        AND c.status = 'completed'
        AND c.completed_at >= $2::date
        AND c.completed_at < ($3::date + 1)
      ORDER BY c.completed_at`,
    [staffId, periodStart, periodEnd],
  );

  return [
    ...items.map((i) => ({
      kind: i.kind as 'service' | 'product',
      grossCents: i.line_total_cents,
      description: i.name,
      occurredAt: new Date(i.completed_at).getTime(),
      checkoutId: i.checkout_id,
      checkoutItemId: i.id,
    })),
    ...tips.map((t) => ({
      kind: 'tip' as const,
      grossCents: t.amount_cents,
      description: 'Tip',
      occurredAt: new Date(t.completed_at).getTime(),
      checkoutId: t.checkout_id,
      checkoutItemId: null,
    })),
  ];
}

function daysInclusive(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return Math.round((end - start) / 86_400_000) + 1;
}

export interface ComputePayoutRequest {
  staffId: string;
  periodStart: string;
  periodEnd: string;
  /** Store the result; otherwise this is a preview. */
  persist?: boolean;
}

export interface PayoutResult extends PayoutSummary {
  payoutId: string | null;
  staffId: string;
  periodStart: string;
  periodEnd: string;
  currency: string;
}

/**
 * Compute a payout, optionally storing it.
 *
 * Recomputing a stored draft replaces it, so a correction to a sale can be
 * reflected. An approved or paid payout is frozen — restating money already
 * handed over is not a recomputation, it is an adjustment, and should be
 * raised as one.
 */
export async function computeStaffPayout(
  request: ComputePayoutRequest,
): Promise<PayoutResult> {
  return withTransaction(async (client) => {
    const { rows: staffRows } = await client.query(
      `SELECT s.id, s.location_id, l.currency
         FROM staff s JOIN locations l ON l.id = s.location_id
        WHERE s.id = $1`,
      [request.staffId],
    );
    const staff = staffRows[0];
    if (!staff) throw new BookingError('NOT_FOUND', 'Staff member not found');

    const terms = await loadCompensation(request.staffId, request.periodStart, client);
    if (!terms) {
      throw new BookingError(
        'INVALID_STATE',
        'No compensation terms are in force for that period',
      );
    }

    const lines = await loadEarningLines(
      request.staffId,
      request.periodStart,
      request.periodEnd,
      client,
    );

    const summary = computePayout({
      terms,
      lines,
      periodDays: daysInclusive(request.periodStart, request.periodEnd),
    });

    let payoutId: string | null = null;

    if (request.persist) {
      const existing = await client.query(
        `SELECT id, status FROM payouts
          WHERE staff_id = $1 AND period_start = $2 AND period_end = $3`,
        [request.staffId, request.periodStart, request.periodEnd],
      );

      if (existing.rows[0] && existing.rows[0].status !== 'draft') {
        throw new BookingError(
          'INVALID_STATE',
          `Payout is already ${existing.rows[0].status} and cannot be recomputed`,
        );
      }

      if (existing.rows[0]) {
        await client.query(`DELETE FROM payouts WHERE id = $1`, [existing.rows[0].id]);
      }

      const { rows } = await client.query(
        `INSERT INTO payouts
           (location_id, staff_id, period_start, period_end,
            service_revenue_cents, retail_revenue_cents,
            service_earnings_cents, retail_earnings_cents,
            tips_cents, rent_cents, net_cents,
            compensation_kind, currency)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::compensation_kind,$13)
         RETURNING id`,
        [
          staff.location_id,
          request.staffId,
          request.periodStart,
          request.periodEnd,
          summary.serviceRevenueCents,
          summary.retailRevenueCents,
          summary.serviceEarningsCents,
          summary.retailEarningsCents,
          summary.tipsCents,
          summary.rentCents,
          summary.netCents,
          summary.compensationKind,
          staff.currency,
        ],
      );
      payoutId = rows[0].id;

      for (const line of summary.lines) {
        await client.query(
          `INSERT INTO payout_lines
             (payout_id, checkout_id, checkout_item_id, kind, description,
              gross_cents, rate_bps, earnings_cents, occurred_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            payoutId,
            line.checkoutId ?? null,
            line.checkoutItemId ?? null,
            line.kind,
            line.description,
            line.grossCents,
            line.rateBps,
            line.earningsCents,
            new Date(line.occurredAt || Date.now()),
          ],
        );
      }
    }

    return {
      ...summary,
      payoutId,
      staffId: request.staffId,
      periodStart: request.periodStart,
      periodEnd: request.periodEnd,
      currency: staff.currency,
    };
  });
}

export async function approvePayout(payoutId: string, now = new Date()): Promise<void> {
  const { rowCount } = await getPool().query(
    `UPDATE payouts SET status = 'approved', approved_at = $2
      WHERE id = $1 AND status = 'draft'`,
    [payoutId, now],
  );
  if (rowCount === 0) {
    throw new BookingError('INVALID_STATE', 'Only a draft payout can be approved');
  }
}

export async function markPayoutPaid(payoutId: string, now = new Date()): Promise<void> {
  const { rowCount } = await getPool().query(
    `UPDATE payouts SET status = 'paid', paid_at = $2
      WHERE id = $1 AND status = 'approved'`,
    [payoutId, now],
  );
  if (rowCount === 0) {
    throw new BookingError('INVALID_STATE', 'Only an approved payout can be marked paid');
  }
}

export async function getPayoutLines(payoutId: string): Promise<
  Array<{ kind: string; description: string; grossCents: number; earningsCents: number }>
> {
  const { rows } = await getPool().query(
    `SELECT kind, description, gross_cents, earnings_cents
       FROM payout_lines WHERE payout_id = $1 ORDER BY occurred_at, description`,
    [payoutId],
  );
  return rows.map((r) => ({
    kind: r.kind,
    description: r.description,
    grossCents: r.gross_cents,
    earningsCents: r.earnings_cents,
  }));
}
