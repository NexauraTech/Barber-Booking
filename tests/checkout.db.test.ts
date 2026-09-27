/**
 * Database-backed checkout, payouts and reporting.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../src/db/pool.js';
import { confirmAppointment, holdSlot } from '../src/booking/commands.js';
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
} from '../src/checkout/service.js';
import {
  approvePayout,
  computeStaffPayout,
  getPayoutLines,
  markPayoutPaid,
} from '../src/payouts/service.js';
import {
  clientMix,
  dashboardSummary,
  noShowCost,
  rebookRate,
  revenueByStaff,
  utilisation,
} from '../src/reporting/queries.js';
import { createFixture, resetDatabase, type Fixture } from './helpers/fixture.js';
import { resolveInstant } from '../src/domain/localtime.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const d = HAS_DB ? describe : describe.skip;

const DAY = '2026-10-01'; // Thursday
const TZ = 'Europe/London';
const t = (time: string) => resolveInstant(DAY, time, TZ);
const BEFORE = resolveInstant('2026-09-30', '08:00', TZ);

let fx: Fixture;
let keyCounter = 0;

async function bookAndConfirm(
  clientId: string,
  time: string,
  staffId: string,
  serviceIds?: string[],
) {
  const key = `key-${keyCounter++}`;
  const held = await holdSlot({
    locationId: fx.locationId,
    serviceIds: serviceIds ?? [fx.cutId],
    clientId,
    start: t(time),
    staffId,
    sessionId: key,
    now: BEFORE,
  });
  await confirmAppointment({
    appointmentId: held.id,
    sessionId: key,
    idempotencyKey: key,
    now: BEFORE,
  });
  return held;
}

/** Book, check out, pay in full and complete. */
async function sell(clientId: string, time: string, staffId: string) {
  const appointment = await bookAndConfirm(clientId, time, staffId);
  const checkout = await openCheckoutForAppointment(appointment.id, staffId);
  await takePayment(checkout.id, {
    amountCents: checkout.totalCents,
    method: 'card',
  });
  const result = await completeCheckout(checkout.id, new Date(t(time)));
  return { appointment, checkout: result.checkout, rebook: result.rebook };
}

d('checkout', () => {
  beforeEach(async () => {
    await resetDatabase();
    fx = await createFixture();
    keyCounter = 0;
  });

  afterAll(async () => {
    await closePool();
  });

  describe('opening', () => {
    it('pre-fills from the appointment at the booked prices', async () => {
      const appointment = await bookAndConfirm(fx.clientA, '10:00', fx.samId);
      const checkout = await openCheckoutForAppointment(appointment.id, fx.samId);

      // Sam's master-tier price, not the base £35.
      expect(checkout.subtotalCents).toBe(4500);
      expect(checkout.totalCents).toBe(4500);

      const detail = await getCheckout(checkout.id);
      expect(detail!.items).toEqual([
        { kind: 'service', name: 'Haircut', quantity: 1, lineTotalCents: 4500 },
      ]);
    });

    it('pre-fills every service of a multi-service booking', async () => {
      const appointment = await bookAndConfirm(fx.clientA, '10:00', fx.samId, [
        fx.cutId,
        fx.beardId,
      ]);
      const checkout = await openCheckoutForAppointment(appointment.id, fx.samId);
      expect(checkout.subtotalCents).toBe(4500 + 2000);
    });

    it('returns the same till when opened twice', async () => {
      const appointment = await bookAndConfirm(fx.clientA, '10:00', fx.samId);
      const first = await openCheckoutForAppointment(appointment.id, fx.samId);
      const second = await openCheckoutForAppointment(appointment.id, fx.alexId);

      expect(second.id).toBe(first.id);
      // And it is not double-filled with the services.
      expect(second.subtotalCents).toBe(4500);
    });

    it('refuses to check out a cancelled appointment', async () => {
      const appointment = await bookAndConfirm(fx.clientA, '10:00', fx.samId);
      await getPool().query(
        `UPDATE appointments SET status = 'cancelled', cancelled_at = now() WHERE id = $1`,
        [appointment.id],
      );

      await expect(
        openCheckoutForAppointment(appointment.id, fx.samId),
      ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    });

    it('opens a standalone retail sale', async () => {
      const checkout = await openRetailCheckout(fx.locationId, {
        cashierStaffId: fx.samId,
      });
      expect(checkout.appointmentId).toBeNull();
      expect(checkout.totalCents).toBe(0);
    });
  });

  describe('retail', () => {
    it('adds a product and decrements stock', async () => {
      const checkout = await openRetailCheckout(fx.locationId, { cashierStaffId: fx.samId });
      const updated = await addProduct(checkout.id, fx.pomadeId, 2, fx.samId);

      expect(updated.subtotalCents).toBe(3000);

      const { rows } = await getPool().query(
        `SELECT stock_quantity FROM products WHERE id = $1`,
        [fx.pomadeId],
      );
      expect(rows[0].stock_quantity).toBe(8);
    });

    it('refuses to sell more than is in stock', async () => {
      const checkout = await openRetailCheckout(fx.locationId, { cashierStaffId: fx.samId });
      await expect(addProduct(checkout.id, fx.pomadeId, 99)).rejects.toMatchObject({
        code: 'INVALID_STATE',
      });
    });

    it('returns stock when a sale is voided', async () => {
      const checkout = await openRetailCheckout(fx.locationId, { cashierStaffId: fx.samId });
      await addProduct(checkout.id, fx.pomadeId, 3, fx.samId);
      await voidCheckout(checkout.id, 'client changed their mind');

      const { rows } = await getPool().query(
        `SELECT stock_quantity FROM products WHERE id = $1`,
        [fx.pomadeId],
      );
      expect(rows[0].stock_quantity).toBe(10);
    });

    it('combines services and retail on one bill', async () => {
      const appointment = await bookAndConfirm(fx.clientA, '10:00', fx.samId);
      const checkout = await openCheckoutForAppointment(appointment.id, fx.samId);
      const updated = await addProduct(checkout.id, fx.pomadeId, 1, fx.samId);

      expect(updated.subtotalCents).toBe(4500 + 1500);
    });
  });

  describe('discounts and tips', () => {
    it('applies a percentage discount', async () => {
      const appointment = await bookAndConfirm(fx.clientA, '10:00', fx.samId);
      const checkout = await openCheckoutForAppointment(appointment.id, fx.samId);
      const updated = await applyDiscount(checkout.id, { kind: 'percent', bps: 1000 });

      expect(updated.discountCents).toBe(450);
      expect(updated.totalCents).toBe(4050);
    });

    it('applies a fixed discount', async () => {
      const appointment = await bookAndConfirm(fx.clientA, '10:00', fx.samId);
      const checkout = await openCheckoutForAppointment(appointment.id, fx.samId);
      const updated = await applyDiscount(checkout.id, {
        kind: 'amount',
        amountCents: 500,
      });
      expect(updated.totalCents).toBe(4000);
    });

    it('never discounts below zero', async () => {
      const appointment = await bookAndConfirm(fx.clientA, '10:00', fx.samId);
      const checkout = await openCheckoutForAppointment(appointment.id, fx.samId);
      const updated = await applyDiscount(checkout.id, {
        kind: 'amount',
        amountCents: 99_999,
      });
      expect(updated.totalCents).toBe(0);
    });

    it('adds a tip on top of the bill', async () => {
      const appointment = await bookAndConfirm(fx.clientA, '10:00', fx.samId);
      const checkout = await openCheckoutForAppointment(appointment.id, fx.samId);
      const updated = await addTip(checkout.id, fx.samId, 500);

      expect(updated.tipCents).toBe(500);
      expect(updated.totalCents).toBe(5000);
    });

    it('replaces rather than stacks a corrected tip', async () => {
      const appointment = await bookAndConfirm(fx.clientA, '10:00', fx.samId);
      const checkout = await openCheckoutForAppointment(appointment.id, fx.samId);
      await addTip(checkout.id, fx.samId, 500);
      const updated = await addTip(checkout.id, fx.samId, 800);

      expect(updated.tipCents).toBe(800);
    });
  });

  describe('tax', () => {
    it('adds tax on top where prices exclude it', async () => {
      await resetDatabase();
      fx = await createFixture({ pricesIncludeTax: false, taxRateBps: 800 });

      const appointment = await bookAndConfirm(fx.clientA, '10:00', fx.samId);
      const checkout = await openCheckoutForAppointment(appointment.id, fx.samId);

      expect(checkout.taxCents).toBe(360); // 8% of £45
      expect(checkout.totalCents).toBe(4860);
    });

    it('carves tax out where prices include it', async () => {
      await resetDatabase();
      fx = await createFixture({ pricesIncludeTax: true, taxRateBps: 2000 });

      const appointment = await bookAndConfirm(fx.clientA, '10:00', fx.samId);
      const checkout = await openCheckoutForAppointment(appointment.id, fx.samId);

      expect(checkout.taxCents).toBe(750); // VAT inside £45
      expect(checkout.totalCents).toBe(4500); // client still pays £45
    });
  });

  describe('payment', () => {
    it('reports what is still owed after a part payment', async () => {
      const appointment = await bookAndConfirm(fx.clientA, '10:00', fx.samId);
      const checkout = await openCheckoutForAppointment(appointment.id, fx.samId);

      const result = await takePayment(checkout.id, { amountCents: 2000, method: 'cash' });
      expect(result.outstandingCents).toBe(2500);
    });

    it('settles a bill split across cash and card', async () => {
      const appointment = await bookAndConfirm(fx.clientA, '10:00', fx.samId);
      const checkout = await openCheckoutForAppointment(appointment.id, fx.samId);

      await takePayment(checkout.id, { amountCents: 2000, method: 'cash' });
      const second = await takePayment(checkout.id, { amountCents: 2500, method: 'card' });

      expect(second.outstandingCents).toBe(0);
      const completed = await completeCheckout(checkout.id);
      expect(completed.checkout.status).toBe('completed');
    });

    it('credits a deposit taken at booking', async () => {
      await getPool().query(
        `UPDATE services SET deposit_policy = '{"kind":"percent","percent":20}'::jsonb
          WHERE id = $1`,
        [fx.cutId],
      );

      const appointment = await bookAndConfirm(fx.clientA, '10:00', fx.samId);
      const checkout = await openCheckoutForAppointment(appointment.id, fx.samId);

      // £9 deposit already held against a £45 bill.
      const detail = await getCheckout(checkout.id);
      expect(detail!.outstandingCents).toBe(3600);
    });

    it('refuses to complete while money is outstanding', async () => {
      const appointment = await bookAndConfirm(fx.clientA, '10:00', fx.samId);
      const checkout = await openCheckoutForAppointment(appointment.id, fx.samId);
      await takePayment(checkout.id, { amountCents: 2000, method: 'cash' });

      await expect(completeCheckout(checkout.id)).rejects.toMatchObject({
        code: 'INVALID_STATE',
      });
    });

    it('rejects a zero or negative payment', async () => {
      const checkout = await openRetailCheckout(fx.locationId);
      await expect(
        takePayment(checkout.id, { amountCents: 0, method: 'cash' }),
      ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    });
  });

  describe('completion', () => {
    it('marks the appointment completed', async () => {
      const { appointment } = await sell(fx.clientA, '10:00', fx.samId);

      const { rows } = await getPool().query(
        `SELECT status, completed_at FROM appointments WHERE id = $1`,
        [appointment.id],
      );
      expect(rows[0].status).toBe('completed');
      expect(rows[0].completed_at).not.toBeNull();
    });

    it('suggests the next visit', async () => {
      const { rebook } = await sell(fx.clientA, '10:00', fx.samId);

      expect(rebook).not.toBeNull();
      expect(rebook!.staffId).toBe(fx.samId);
      expect(rebook!.serviceIds).toEqual([fx.cutId]);
      expect(rebook!.intervalWeeks).toBe(4); // default with no history
    });

    it("uses the client's stated interval when there is no history", async () => {
      await getPool().query(
        `INSERT INTO client_preferences (client_id, interval_weeks) VALUES ($1, 6)`,
        [fx.clientA],
      );
      const { rebook } = await sell(fx.clientA, '10:00', fx.samId);
      expect(rebook!.intervalWeeks).toBe(6);
    });

    it('learns the interval from the client\'s own rhythm', async () => {
      // Two prior completed visits three weeks apart.
      for (const iso of ['2026-09-10T10:00:00Z', '2026-09-17T10:00:00Z']) {
        await getPool().query(
          `INSERT INTO appointments
             (location_id, staff_id, client_id, starts_at, ends_at, status)
           VALUES ($1,$2,$3,$4::timestamptz,
                   $4::timestamptz + interval '35 minutes','completed')`,
          [fx.locationId, fx.samId, fx.clientA, iso],
        );
      }

      const { rebook } = await sell(fx.clientA, '10:00', fx.samId);
      expect(rebook!.intervalWeeks).toBe(1);
    });

    it('gives no rebook suggestion for a pure retail sale', async () => {
      const checkout = await openRetailCheckout(fx.locationId, { cashierStaffId: fx.samId });
      await addProduct(checkout.id, fx.pomadeId, 1, fx.samId);
      await takePayment(checkout.id, { amountCents: 1500, method: 'cash' });

      const result = await completeCheckout(checkout.id);
      expect(result.rebook).toBeNull();
    });

    it('cannot be completed twice', async () => {
      const appointment = await bookAndConfirm(fx.clientA, '10:00', fx.samId);
      const checkout = await openCheckoutForAppointment(appointment.id, fx.samId);
      await takePayment(checkout.id, { amountCents: 4500, method: 'card' });
      await completeCheckout(checkout.id);

      await expect(completeCheckout(checkout.id)).rejects.toMatchObject({
        code: 'INVALID_STATE',
      });
    });
  });
});

d('payouts', () => {
  beforeEach(async () => {
    await resetDatabase();
    fx = await createFixture();
    keyCounter = 0;
  });

  afterAll(async () => {
    await closePool();
  });

  const setTerms = (staffId: string, sql: string, params: unknown[]) =>
    getPool().query(sql, [staffId, ...params]);

  const commissionTerms = (staffId: string) =>
    setTerms(
      staffId,
      `INSERT INTO staff_compensation
         (staff_id, kind, service_commission_bps, retail_commission_bps, effective_from)
       VALUES ($1, 'commission', $2, $3, '2026-01-01')`,
      [4000, 1000],
    );

  const rentTerms = (staffId: string) =>
    setTerms(
      staffId,
      `INSERT INTO staff_compensation
         (staff_id, kind, rent_cents_per_week, effective_from)
       VALUES ($1, 'chair_rent', $2, '2026-01-01')`,
      [20_000],
    );

  it('pays commission on services and retail', async () => {
    await commissionTerms(fx.samId);

    const appointment = await bookAndConfirm(fx.clientA, '10:00', fx.samId);
    const checkout = await openCheckoutForAppointment(appointment.id, fx.samId);
    await addProduct(checkout.id, fx.pomadeId, 1, fx.samId);
    await addTip(checkout.id, fx.samId, 500);
    await takePayment(checkout.id, { amountCents: 4500 + 1500 + 500, method: 'card' });
    await completeCheckout(checkout.id, new Date(t('10:30')));

    const payout = await computeStaffPayout({
      staffId: fx.samId,
      periodStart: DAY,
      periodEnd: DAY,
    });

    expect(payout.serviceRevenueCents).toBe(4500);
    expect(payout.retailRevenueCents).toBe(1500);
    expect(payout.serviceEarningsCents).toBe(1800); // 40%
    expect(payout.retailEarningsCents).toBe(150); // 10%
    expect(payout.tipsCents).toBe(500);
    expect(payout.netCents).toBe(2450);
  });

  it('passes revenue through and charges rent under chair rent', async () => {
    await rentTerms(fx.samId);
    await sell(fx.clientA, '10:00', fx.samId);

    const payout = await computeStaffPayout({
      staffId: fx.samId,
      periodStart: '2026-09-28',
      periodEnd: '2026-10-04', // a full week
    });

    expect(payout.serviceEarningsCents).toBe(4500);
    expect(payout.rentCents).toBe(20_000);
    expect(payout.netCents).toBe(4500 - 20_000);
  });

  it('ignores open and voided checkouts', async () => {
    await commissionTerms(fx.samId);

    // Open, never completed.
    const appointment = await bookAndConfirm(fx.clientA, '10:00', fx.samId);
    await openCheckoutForAppointment(appointment.id, fx.samId);

    const payout = await computeStaffPayout({
      staffId: fx.samId,
      periodStart: DAY,
      periodEnd: DAY,
    });
    expect(payout.serviceRevenueCents).toBe(0);
  });

  it('does not pay one barber for another\'s work', async () => {
    await commissionTerms(fx.samId);
    await commissionTerms(fx.alexId);

    await sell(fx.clientA, '10:00', fx.samId);
    await sell(fx.clientB, '10:00', fx.alexId);

    const sam = await computeStaffPayout({
      staffId: fx.samId, periodStart: DAY, periodEnd: DAY,
    });
    const alex = await computeStaffPayout({
      staffId: fx.alexId, periodStart: DAY, periodEnd: DAY,
    });

    expect(sam.serviceRevenueCents).toBe(4500); // master rate
    expect(alex.serviceRevenueCents).toBe(2500); // apprentice rate
  });

  it('refuses to compute without terms in force', async () => {
    await expect(
      computeStaffPayout({ staffId: fx.samId, periodStart: DAY, periodEnd: DAY }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('uses the terms that applied at the time, not the current ones', async () => {
    await getPool().query(
      `INSERT INTO staff_compensation
         (staff_id, kind, service_commission_bps, retail_commission_bps,
          effective_from, effective_to)
       VALUES ($1, 'commission', 3000, 1000, '2026-01-01', '2026-10-31')`,
      [fx.samId],
    );
    await getPool().query(
      `INSERT INTO staff_compensation
         (staff_id, kind, service_commission_bps, retail_commission_bps, effective_from)
       VALUES ($1, 'commission', 5000, 1000, '2026-11-01')`,
      [fx.samId],
    );

    await sell(fx.clientA, '10:00', fx.samId);

    const payout = await computeStaffPayout({
      staffId: fx.samId, periodStart: DAY, periodEnd: DAY,
    });
    expect(payout.serviceEarningsCents).toBe(1350); // 30%, the old deal
  });

  describe('persistence and approval', () => {
    it('stores the payout with its backing lines', async () => {
      await commissionTerms(fx.samId);
      await sell(fx.clientA, '10:00', fx.samId);

      const payout = await computeStaffPayout({
        staffId: fx.samId, periodStart: DAY, periodEnd: DAY, persist: true,
      });

      expect(payout.payoutId).not.toBeNull();
      const lines = await getPayoutLines(payout.payoutId!);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        kind: 'service',
        description: 'Haircut',
        grossCents: 4500,
        earningsCents: 1800,
      });
    });

    it('replaces a draft when recomputed', async () => {
      await commissionTerms(fx.samId);
      await sell(fx.clientA, '10:00', fx.samId);

      const first = await computeStaffPayout({
        staffId: fx.samId, periodStart: DAY, periodEnd: DAY, persist: true,
      });
      await sell(fx.clientB, '11:00', fx.samId);
      const second = await computeStaffPayout({
        staffId: fx.samId, periodStart: DAY, periodEnd: DAY, persist: true,
      });

      expect(second.payoutId).not.toBe(first.payoutId);
      expect(second.serviceRevenueCents).toBe(9000);

      const { rows } = await getPool().query(
        `SELECT count(*)::int AS n FROM payouts WHERE staff_id = $1`,
        [fx.samId],
      );
      expect(rows[0].n).toBe(1);
    });

    it('freezes an approved payout against recomputation', async () => {
      await commissionTerms(fx.samId);
      await sell(fx.clientA, '10:00', fx.samId);

      const payout = await computeStaffPayout({
        staffId: fx.samId, periodStart: DAY, periodEnd: DAY, persist: true,
      });
      await approvePayout(payout.payoutId!);

      await expect(
        computeStaffPayout({
          staffId: fx.samId, periodStart: DAY, periodEnd: DAY, persist: true,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    });

    it('runs draft -> approved -> paid in order', async () => {
      await commissionTerms(fx.samId);
      await sell(fx.clientA, '10:00', fx.samId);
      const payout = await computeStaffPayout({
        staffId: fx.samId, periodStart: DAY, periodEnd: DAY, persist: true,
      });

      // Cannot pay before approving.
      await expect(markPayoutPaid(payout.payoutId!)).rejects.toMatchObject({
        code: 'INVALID_STATE',
      });

      await approvePayout(payout.payoutId!);
      await markPayoutPaid(payout.payoutId!);

      const { rows } = await getPool().query(
        `SELECT status FROM payouts WHERE id = $1`,
        [payout.payoutId],
      );
      expect(rows[0].status).toBe('paid');
    });
  });
});

d('reporting', () => {
  beforeEach(async () => {
    await resetDatabase();
    fx = await createFixture();
    keyCounter = 0;
  });

  afterAll(async () => {
    await closePool();
  });

  const range = { from: DAY, to: DAY };

  it('reports revenue by barber', async () => {
    await sell(fx.clientA, '10:00', fx.samId);
    await sell(fx.clientB, '10:00', fx.alexId);

    const rows = await revenueByStaff(fx.locationId, range);
    const sam = rows.find((r) => r.staffId === fx.samId)!;
    const alex = rows.find((r) => r.staffId === fx.alexId)!;

    expect(sam.serviceRevenueCents).toBe(4500);
    expect(alex.serviceRevenueCents).toBe(2500);
    expect(sam.checkoutCount).toBe(1);
  });

  it('counts retail and tips separately from services', async () => {
    const appointment = await bookAndConfirm(fx.clientA, '10:00', fx.samId);
    const checkout = await openCheckoutForAppointment(appointment.id, fx.samId);
    await addProduct(checkout.id, fx.pomadeId, 2, fx.samId);
    await addTip(checkout.id, fx.samId, 700);
    await takePayment(checkout.id, { amountCents: 4500 + 3000 + 700, method: 'card' });
    await completeCheckout(checkout.id, new Date(t('10:30')));

    const rows = await revenueByStaff(fx.locationId, range);
    const sam = rows.find((r) => r.staffId === fx.samId)!;

    expect(sam.serviceRevenueCents).toBe(4500);
    expect(sam.retailRevenueCents).toBe(3000);
    expect(sam.tipsCents).toBe(700);
  });

  it('computes chair utilisation against shift hours', async () => {
    await bookAndConfirm(fx.clientA, '10:00', fx.samId); // 35 minutes

    const rows = await utilisation(fx.locationId, range);
    const sam = rows.find((r) => r.staffId === fx.samId)!;

    expect(sam.availableMinutes).toBe(480); // 09:00-17:00
    expect(sam.bookedMinutes).toBe(35);
    expect(sam.utilisationPercent).toBe(7);
  });

  it('reports zero utilisation for a barber who is off', async () => {
    const rows = await utilisation(fx.locationId, { from: '2026-10-04', to: '2026-10-04' });
    expect(rows.every((r) => r.utilisationPercent === 0)).toBe(true);
  });

  it('measures the rebook rate', async () => {
    await sell(fx.clientA, '10:00', fx.samId);
    // Client A books their next visit the same day.
    await holdSlot({
      locationId: fx.locationId, serviceIds: [fx.cutId], clientId: fx.clientA,
      start: resolveInstant('2026-10-02', '10:00', TZ), staffId: fx.samId,
      sessionId: 'rebook', now: BEFORE,
    });
    await getPool().query(
      `UPDATE appointments SET status = 'confirmed', hold_expires_at = NULL,
              hold_session_id = NULL
        WHERE hold_session_id = 'rebook'`,
    );

    await sell(fx.clientB, '11:00', fx.samId); // never rebooks

    const rate = await rebookRate(fx.locationId, range, { windowDays: 7 });
    expect(rate.completedCount).toBe(2);
    expect(rate.rebookedCount).toBe(1);
    expect(rate.rebookRatePercent).toBe(50);
  });

  it('reports zero rebook rate with no completed visits', async () => {
    const rate = await rebookRate(fx.locationId, range);
    expect(rate).toMatchObject({ completedCount: 0, rebookRatePercent: 0 });
  });

  it('puts a number on no-shows', async () => {
    const appointment = await bookAndConfirm(fx.clientA, '10:00', fx.samId);
    const { markNoShow } = await import('../src/booking/commands.js');
    await markNoShow(appointment.id);

    const cost = await noShowCost(fx.locationId, range);
    expect(cost.noShowCount).toBe(1);
    expect(cost.lostRevenueCents).toBe(4500);
    expect(cost.feesRaisedCents).toBe(4500);
  });

  it('separates waived fees from raised ones', async () => {
    const appointment = await bookAndConfirm(fx.clientA, '10:00', fx.samId);
    const { markNoShow } = await import('../src/booking/commands.js');
    const { waiveFee } = await import('../src/booking/policy-service.js');
    const result = await markNoShow(appointment.id);
    await waiveFee(result.feePaymentId!, null, 'regular, forgiven');

    const cost = await noShowCost(fx.locationId, range);
    expect(cost.feesRaisedCents).toBe(0);
    expect(cost.feesWaivedCents).toBe(4500);
  });

  it('splits new from returning clients', async () => {
    await sell(fx.clientA, '10:00', fx.samId);
    await sell(fx.clientB, '10:00', fx.alexId);

    const mix = await clientMix(fx.locationId, range);
    expect(mix.newClients).toBe(2);
    expect(mix.returningClients).toBe(0);
    expect(mix.newClientPercent).toBe(100);
  });

  it('counts a client with earlier history as returning', async () => {
    await getPool().query(
      `INSERT INTO appointments
         (location_id, staff_id, client_id, starts_at, ends_at, status)
       VALUES ($1,$2,$3,'2026-09-01T10:00:00Z','2026-09-01T10:35:00Z','completed')`,
      [fx.locationId, fx.samId, fx.clientA],
    );
    await sell(fx.clientA, '10:00', fx.samId);

    const mix = await clientMix(fx.locationId, range);
    expect(mix.returningClients).toBe(1);
    expect(mix.newClients).toBe(0);
  });

  it('summarises the day for the owner dashboard', async () => {
    await sell(fx.clientA, '10:00', fx.samId);
    await bookAndConfirm(fx.clientB, '11:00', fx.samId); // booked, not yet done

    const summary = await dashboardSummary(fx.locationId, DAY);
    expect(summary.bookedCount).toBe(2);
    expect(summary.completedCount).toBe(1);
    expect(summary.expectedRevenueCents).toBe(9000);
    expect(summary.takenRevenueCents).toBe(4500);
    expect(summary.staffOnShift).toBe(2);
  });
});
