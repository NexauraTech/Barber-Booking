/**
 * Applying deposit and cancellation policy to real bookings.
 *
 * Every charge here is recorded as a `payments` row, including waived ones:
 * a barber forgiving a fee is information worth keeping, not an absence of
 * data.
 */
import type { PoolClient } from 'pg';
import { getPool } from '../db/pool.js';
import {
  type ClientRisk,
  type PolicySnapshot,
  buildPolicySnapshot,
  depositAmountCents,
  depositRequired,
  evaluateCancellation,
  feeAfterDeposit,
  noShowFeeCents,
  parseDepositRule,
  parsePolicySnapshot,
} from '../domain/policy.js';
import { type LocationPolicy, policySettings } from '../db/availability-repo.js';

type Db = Pick<PoolClient, 'query'>;
const db = (client?: Db): Db => client ?? getPool();

/**
 * A client is "first time" when they have never completed an appointment at
 * this organisation. A cancelled or no-showed booking does not earn trust.
 */
export async function loadClientRisk(
  clientId: string,
  orgId: string,
  client?: Db,
): Promise<ClientRisk> {
  const { rows } = await db(client).query(
    `SELECT c.no_show_count,
            EXISTS (
              SELECT 1 FROM appointments a
                JOIN locations l ON l.id = a.location_id
               WHERE a.client_id = c.id
                 AND l.org_id = $2
                 AND a.status = 'completed'
            ) AS has_history
       FROM clients c
      WHERE c.id = $1`,
    [clientId, orgId],
  );

  const row = rows[0];
  if (!row) return { isFirstTime: true, noShowCount: 0 };

  return {
    isFirstTime: !row.has_history,
    noShowCount: row.no_show_count,
  };
}

/** Total price of an appointment's services, as snapshotted at booking. */
export async function appointmentTotalCents(
  appointmentId: string,
  client?: Db,
): Promise<number> {
  const { rows } = await db(client).query(
    `SELECT coalesce(sum(price_cents), 0)::int AS total
       FROM appointment_services WHERE appointment_id = $1`,
    [appointmentId],
  );
  return rows[0].total;
}

export interface PolicyDecision {
  snapshot: PolicySnapshot;
  depositCents: number;
  depositRequired: boolean;
}

/**
 * Decide what this client owes up front, and freeze the terms.
 *
 * Deposits are aimed at strangers and people with a no-show history, not at
 * trusted regulars — charging everyone is the behaviour that drives clients
 * to shops that don't.
 */
export async function decidePolicy(
  location: LocationPolicy,
  appointmentId: string,
  clientId: string,
  serviceIds: readonly string[],
  client?: Db,
): Promise<PolicyDecision> {
  const settings = policySettings(location);
  const risk = await loadClientRisk(clientId, location.orgId, client);
  const totalCents = await appointmentTotalCents(appointmentId, client);

  const required = depositRequired(risk, settings);

  let depositCents = 0;
  if (required && serviceIds.length > 0) {
    const { rows } = await db(client).query(
      `SELECT deposit_policy FROM services WHERE id = ANY($1::uuid[])`,
      [serviceIds],
    );
    depositCents = depositAmountCents(
      totalCents,
      rows.map((r) => parseDepositRule(r.deposit_policy)),
    );
  }

  return {
    snapshot: buildPolicySnapshot(settings, totalCents, depositCents),
    depositCents,
    depositRequired: required && depositCents > 0,
  };
}

export interface RecordedPayment {
  id: string;
  amountCents: number;
  kind: string;
  status: string;
}

async function recordPayment(
  params: {
    locationId: string;
    appointmentId: string;
    clientId: string;
    amountCents: number;
    currency: string;
    kind: string;
    method?: string;
    status?: string;
    idempotencyKey?: string | null;
  },
  client?: Db,
): Promise<RecordedPayment> {
  const { rows } = await db(client).query(
    `INSERT INTO payments
       (location_id, appointment_id, client_id, amount_cents, currency,
        kind, method, status, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6::payment_kind,$7::payment_method,$8::payment_status,$9)
     -- The unique index on idempotency_key is partial, so the conflict target
     -- must repeat its predicate for Postgres to infer the index.
     ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
       DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
     RETURNING id, amount_cents, kind, status`,
    [
      params.locationId,
      params.appointmentId,
      params.clientId,
      params.amountCents,
      params.currency,
      params.kind,
      params.method ?? 'card',
      params.status ?? 'pending',
      params.idempotencyKey ?? null,
    ],
  );

  const row = rows[0];
  return {
    id: row.id,
    amountCents: row.amount_cents,
    kind: row.kind,
    status: row.status,
  };
}

export async function recordDeposit(
  location: LocationPolicy,
  appointmentId: string,
  clientId: string,
  amountCents: number,
  currency: string,
  client?: Db,
): Promise<RecordedPayment> {
  return recordPayment(
    {
      locationId: location.id,
      appointmentId,
      clientId,
      amountCents,
      currency,
      kind: 'deposit',
      idempotencyKey: `deposit:${appointmentId}`,
    },
    client,
  );
}

/**
 * Charge for a late cancellation, crediting any deposit already taken so a
 * client is never charged twice for one missed appointment.
 */
export async function chargeLateCancellation(
  location: LocationPolicy,
  appointment: {
    id: string;
    clientId: string;
    startsAt: number;
    policySnapshot: unknown;
  },
  cancelledAt: number,
  currency: string,
  client?: Db,
): Promise<RecordedPayment | null> {
  const snapshot = parsePolicySnapshot(appointment.policySnapshot);
  if (!snapshot) return null;

  const outcome = evaluateCancellation(snapshot, appointment.startsAt, cancelledAt);
  if (outcome.kind === 'free') return null;

  const payable = feeAfterDeposit(outcome.feeCents, snapshot.depositCents);
  if (payable === 0) return null;

  return recordPayment(
    {
      locationId: location.id,
      appointmentId: appointment.id,
      clientId: appointment.clientId,
      amountCents: payable,
      currency,
      kind: 'late_cancel_fee',
      idempotencyKey: `late_cancel:${appointment.id}`,
    },
    client,
  );
}

export async function chargeNoShow(
  location: LocationPolicy,
  appointment: { id: string; clientId: string; policySnapshot: unknown },
  currency: string,
  client?: Db,
): Promise<RecordedPayment | null> {
  const snapshot = parsePolicySnapshot(appointment.policySnapshot);
  if (!snapshot) return null;

  const payable = feeAfterDeposit(noShowFeeCents(snapshot), snapshot.depositCents);
  if (payable === 0) return null;

  return recordPayment(
    {
      locationId: location.id,
      appointmentId: appointment.id,
      clientId: appointment.clientId,
      amountCents: payable,
      currency,
      kind: 'no_show_fee',
      idempotencyKey: `no_show:${appointment.id}`,
    },
    client,
  );
}

/**
 * Forgive a fee.
 *
 * Always one action away, and recorded rather than deleted: a relationship is
 * worth more than a single fee, but the shop should still be able to see how
 * often it happens.
 */
export async function waiveFee(
  paymentId: string,
  waivedBy: string | null,
  reason: string,
  client?: Db,
): Promise<void> {
  await db(client).query(
    `UPDATE payments
        SET status = 'waived', waived_by = $2, waived_reason = $3
      WHERE id = $1 AND status IN ('pending','authorized','failed')`,
    [paymentId, waivedBy, reason],
  );
}

export async function listPayments(
  appointmentId: string,
): Promise<RecordedPayment[]> {
  const { rows } = await getPool().query(
    `SELECT id, amount_cents, kind, status FROM payments
      WHERE appointment_id = $1 ORDER BY created_at`,
    [appointmentId],
  );
  return rows.map((r) => ({
    id: r.id,
    amountCents: r.amount_cents,
    kind: r.kind,
    status: r.status,
  }));
}
