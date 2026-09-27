/**
 * Reporting.
 *
 * The metrics that actually change behaviour, per
 * docs/research/04-apps-and-ux.md §4.3 — not a wall of charts. Chair
 * utilisation tells an owner whether to hire; rebook rate tells a barber
 * whether they are building a book or churning through strangers; no-show
 * cost puts a number on the problem deposits are there to solve.
 *
 * These are read-only aggregate queries. Polling is fine — none of this needs
 * to be realtime (docs/research/03-realtime.md §3.1).
 */
import { getPool } from '../db/pool.js';

export interface DateRange {
  from: string;
  to: string;
}

export interface RevenueRow {
  staffId: string;
  staffName: string;
  serviceRevenueCents: number;
  retailRevenueCents: number;
  tipsCents: number;
  checkoutCount: number;
}

/** Revenue by barber over a period, from completed sales only. */
export async function revenueByStaff(
  locationId: string,
  range: DateRange,
): Promise<RevenueRow[]> {
  const { rows } = await getPool().query(
    `SELECT s.id AS staff_id,
            s.display_name,
            coalesce(sum(ci.line_total_cents)
                     FILTER (WHERE ci.kind = 'service'), 0)::int AS service_revenue,
            coalesce(sum(ci.line_total_cents)
                     FILTER (WHERE ci.kind = 'product'), 0)::int AS retail_revenue,
            coalesce((SELECT sum(t.amount_cents) FROM checkout_tips t
                        JOIN checkouts tc ON tc.id = t.checkout_id
                       WHERE t.staff_id = s.id
                         AND tc.status = 'completed'
                         AND tc.completed_at >= $2::date
                         AND tc.completed_at < ($3::date + 1)), 0)::int AS tips,
            count(DISTINCT c.id)::int AS checkout_count
       FROM staff s
       LEFT JOIN checkout_items ci ON ci.earned_by_staff_id = s.id
       LEFT JOIN checkouts c ON c.id = ci.checkout_id
             AND c.status = 'completed'
             AND c.completed_at >= $2::date
             AND c.completed_at < ($3::date + 1)
      WHERE s.location_id = $1 AND s.active
      GROUP BY s.id, s.display_name
      ORDER BY service_revenue DESC`,
    [locationId, range.from, range.to],
  );

  return rows.map((r) => ({
    staffId: r.staff_id,
    staffName: r.display_name,
    serviceRevenueCents: r.service_revenue,
    retailRevenueCents: r.retail_revenue,
    tipsCents: r.tips,
    checkoutCount: r.checkout_count,
  }));
}

export interface UtilisationRow {
  staffId: string;
  staffName: string;
  bookedMinutes: number;
  availableMinutes: number;
  utilisationPercent: number;
}

/**
 * Chair utilisation: booked minutes as a share of shift minutes.
 *
 * Shift minutes come from the shifts table rather than opening hours, because
 * a barber who only works Tuesdays should not look 80% idle.
 */
export async function utilisation(
  locationId: string,
  range: DateRange,
): Promise<UtilisationRow[]> {
  const { rows } = await getPool().query(
    `WITH days AS (
        SELECT d::date AS day
          FROM generate_series($2::date, $3::date, '1 day') d
     ),
     shift_minutes AS (
        SELECT sh.staff_id,
               sum(extract(epoch FROM (sh.ends_at - sh.starts_at)) / 60)::int AS minutes
          FROM shifts sh
          JOIN days ON extract(isodow FROM days.day) = sh.weekday
         WHERE sh.effective_from <= days.day
           AND (sh.effective_to IS NULL OR sh.effective_to >= days.day)
           AND NOT EXISTS (
               SELECT 1 FROM shift_exceptions se
                WHERE se.staff_id = sh.staff_id
                  AND se.on_date = days.day
                  AND se.kind = 'off')
         GROUP BY sh.staff_id
     ),
     booked AS (
        SELECT a.staff_id,
               sum(extract(epoch FROM (a.ends_at - a.starts_at)) / 60)::int AS minutes
          FROM appointments a
         WHERE a.location_id = $1
           AND a.status IN ('completed','in_progress','confirmed')
           AND a.starts_at >= $2::date
           AND a.starts_at < ($3::date + 1)
         GROUP BY a.staff_id
     )
     SELECT s.id AS staff_id, s.display_name,
            coalesce(b.minutes, 0) AS booked_minutes,
            coalesce(sm.minutes, 0) AS available_minutes
       FROM staff s
       LEFT JOIN shift_minutes sm ON sm.staff_id = s.id
       LEFT JOIN booked b ON b.staff_id = s.id
      WHERE s.location_id = $1 AND s.active
      ORDER BY s.display_name`,
    [locationId, range.from, range.to],
  );

  return rows.map((r) => ({
    staffId: r.staff_id,
    staffName: r.display_name,
    bookedMinutes: r.booked_minutes,
    availableMinutes: r.available_minutes,
    utilisationPercent:
      r.available_minutes === 0
        ? 0
        : Math.round((r.booked_minutes / r.available_minutes) * 100),
  }));
}

export interface RebookRate {
  completedCount: number;
  rebookedCount: number;
  rebookRatePercent: number;
}

/**
 * Rebook rate: share of completed visits where the client had a future
 * booking made within `windowDays` of the visit.
 *
 * Measures the habit of booking the next visit at the chair, which is the
 * single strongest predictor of retention.
 */
export async function rebookRate(
  locationId: string,
  range: DateRange,
  options: { staffId?: string | null; windowDays?: number } = {},
): Promise<RebookRate> {
  const { rows } = await getPool().query(
    `WITH completed AS (
        SELECT a.id, a.client_id, a.starts_at
          FROM appointments a
         WHERE a.location_id = $1
           AND a.status = 'completed'
           AND a.starts_at >= $2::date
           AND a.starts_at < ($3::date + 1)
           AND ($4::uuid IS NULL OR a.staff_id = $4::uuid)
     )
     SELECT count(*)::int AS completed_count,
            count(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM appointments nxt
                 WHERE nxt.client_id = completed.client_id
                   AND nxt.starts_at > completed.starts_at
                   AND nxt.status IN ('confirmed','completed','in_progress')
                   AND nxt.created_at <= completed.starts_at
                        + make_interval(days => $5::int)
            ))::int AS rebooked_count
       FROM completed`,
    [locationId, range.from, range.to, options.staffId ?? null, options.windowDays ?? 1],
  );

  const row = rows[0];
  return {
    completedCount: row.completed_count,
    rebookedCount: row.rebooked_count,
    rebookRatePercent:
      row.completed_count === 0
        ? 0
        : Math.round((row.rebooked_count / row.completed_count) * 100),
  };
}

export interface NoShowCost {
  noShowCount: number;
  lateCancelCount: number;
  lostRevenueCents: number;
  feesRaisedCents: number;
  feesWaivedCents: number;
}

/**
 * The cost of people not turning up.
 *
 * Reported as lost revenue against fees actually raised, so an owner can see
 * both the size of the problem and how much of it the policy recovers.
 */
export async function noShowCost(
  locationId: string,
  range: DateRange,
): Promise<NoShowCost> {
  const { rows } = await getPool().query(
    `WITH missed AS (
        SELECT a.id, a.status,
               coalesce((SELECT sum(asv.price_cents) FROM appointment_services asv
                          WHERE asv.appointment_id = a.id), 0)::int AS value_cents
          FROM appointments a
         WHERE a.location_id = $1
           AND a.starts_at >= $2::date
           AND a.starts_at < ($3::date + 1)
           AND (a.status = 'no_show'
                OR (a.status = 'cancelled' AND a.cancelled_at IS NOT NULL
                    AND a.cancelled_at > a.starts_at - interval '24 hours'))
     )
     SELECT count(*) FILTER (WHERE status = 'no_show')::int AS no_show_count,
            count(*) FILTER (WHERE status = 'cancelled')::int AS late_cancel_count,
            coalesce(sum(value_cents) FILTER (WHERE status = 'no_show'), 0)::int
                AS lost_revenue,
            coalesce((SELECT sum(p.amount_cents) FROM payments p
                       WHERE p.appointment_id IN (SELECT id FROM missed)
                         AND p.kind IN ('no_show_fee','late_cancel_fee')
                         AND p.status <> 'waived'), 0)::int AS fees_raised,
            coalesce((SELECT sum(p.amount_cents) FROM payments p
                       WHERE p.appointment_id IN (SELECT id FROM missed)
                         AND p.kind IN ('no_show_fee','late_cancel_fee')
                         AND p.status = 'waived'), 0)::int AS fees_waived
       FROM missed`,
    [locationId, range.from, range.to],
  );

  const row = rows[0];
  return {
    noShowCount: row.no_show_count,
    lateCancelCount: row.late_cancel_count,
    lostRevenueCents: row.lost_revenue,
    feesRaisedCents: row.fees_raised,
    feesWaivedCents: row.fees_waived,
  };
}

export interface ClientMix {
  newClients: number;
  returningClients: number;
  newClientPercent: number;
}

/** New versus returning clients — whether the shop is growing or churning. */
export async function clientMix(
  locationId: string,
  range: DateRange,
): Promise<ClientMix> {
  const { rows } = await getPool().query(
    `WITH visits AS (
        SELECT a.client_id,
               min(a.starts_at) AS first_in_range,
               (SELECT min(prev.starts_at) FROM appointments prev
                 WHERE prev.client_id = a.client_id
                   AND prev.status = 'completed') AS ever_first
          FROM appointments a
         WHERE a.location_id = $1
           AND a.status = 'completed'
           AND a.starts_at >= $2::date
           AND a.starts_at < ($3::date + 1)
         GROUP BY a.client_id
     )
     SELECT count(*) FILTER (WHERE ever_first >= first_in_range)::int AS new_clients,
            count(*) FILTER (WHERE ever_first < first_in_range)::int AS returning_clients
       FROM visits`,
    [locationId, range.from, range.to],
  );

  const row = rows[0];
  const total = row.new_clients + row.returning_clients;
  return {
    newClients: row.new_clients,
    returningClients: row.returning_clients,
    newClientPercent: total === 0 ? 0 : Math.round((row.new_clients / total) * 100),
  };
}

export interface DashboardSummary {
  date: string;
  bookedCount: number;
  completedCount: number;
  expectedRevenueCents: number;
  takenRevenueCents: number;
  queueLength: number;
  staffOnShift: number;
}

/** The owner's at-a-glance view for one day. */
export async function dashboardSummary(
  locationId: string,
  date: string,
): Promise<DashboardSummary> {
  const { rows } = await getPool().query(
    `SELECT
        (SELECT count(*)::int FROM appointments a
          WHERE a.location_id = $1 AND a.starts_at >= $2::date
            AND a.starts_at < ($2::date + 1)
            AND a.status IN ('confirmed','in_progress','completed')) AS booked,
        (SELECT count(*)::int FROM appointments a
          WHERE a.location_id = $1 AND a.starts_at >= $2::date
            AND a.starts_at < ($2::date + 1)
            AND a.status = 'completed') AS completed,
        (SELECT coalesce(sum(asv.price_cents), 0)::int
           FROM appointments a JOIN appointment_services asv
                ON asv.appointment_id = a.id
          WHERE a.location_id = $1 AND a.starts_at >= $2::date
            AND a.starts_at < ($2::date + 1)
            AND a.status IN ('confirmed','in_progress','completed')) AS expected,
        (SELECT coalesce(sum(c.total_cents), 0)::int FROM checkouts c
          WHERE c.location_id = $1 AND c.status = 'completed'
            AND c.completed_at >= $2::date
            AND c.completed_at < ($2::date + 1)) AS taken,
        (SELECT count(*)::int FROM queue_entries q
          WHERE q.location_id = $1 AND q.status IN ('waiting','notified')) AS queue_length,
        (SELECT count(DISTINCT sh.staff_id)::int FROM shifts sh
           JOIN staff s ON s.id = sh.staff_id
          WHERE s.location_id = $1 AND s.active
            AND sh.weekday = extract(isodow FROM $2::date)
            AND sh.effective_from <= $2::date
            AND (sh.effective_to IS NULL OR sh.effective_to >= $2::date)) AS on_shift`,
    [locationId, date],
  );

  const row = rows[0];
  return {
    date,
    bookedCount: row.booked,
    completedCount: row.completed,
    expectedRevenueCents: row.expected,
    takenRevenueCents: row.taken,
    queueLength: row.queue_length,
    staffOnShift: row.on_shift,
  };
}
