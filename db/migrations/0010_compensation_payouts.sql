-- Staff compensation and payouts.
--
-- Many barbers are independent contractors renting a chair, not employees
-- (docs/research/01-market-landscape.md §1.3). That means PAYOUTS, not
-- payroll: the shop owes the barber money, or the barber owes the shop rent,
-- and which way it runs depends on the arrangement.
--
-- Three arrangements cover almost every shop:
--   commission  — the shop takes a cut of service revenue; barber keeps tips
--   chair_rent  — the barber keeps service revenue and owes a fixed rent
--   salary      — employed; revenue is the shop's, wages are payroll's problem

CREATE TYPE compensation_kind AS ENUM ('commission', 'chair_rent', 'salary');

CREATE TABLE staff_compensation (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    staff_id      uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    kind          compensation_kind NOT NULL,

    -- Basis points, so 4250 = 42.5%. Integers avoid the rounding drift that
    -- makes a barber's payout disagree with the shop's books.
    service_commission_bps int CHECK (service_commission_bps BETWEEN 0 AND 10000),
    retail_commission_bps  int CHECK (retail_commission_bps BETWEEN 0 AND 10000),

    rent_cents_per_week    int CHECK (rent_cents_per_week >= 0),

    -- Tips are the barber's in every arrangement unless a shop pools them.
    tips_retained_bps int NOT NULL DEFAULT 10000
        CHECK (tips_retained_bps BETWEEN 0 AND 10000),

    effective_from date NOT NULL,
    effective_to   date,

    CONSTRAINT compensation_shape CHECK (
        (kind = 'commission' AND service_commission_bps IS NOT NULL)
        OR (kind = 'chair_rent' AND rent_cents_per_week IS NOT NULL)
        OR (kind = 'salary')
    ),
    CONSTRAINT compensation_dates_ordered CHECK (
        effective_to IS NULL OR effective_to >= effective_from
    )
);

CREATE INDEX staff_compensation_staff_idx
    ON staff_compensation (staff_id, effective_from DESC);

CREATE TYPE payout_status AS ENUM ('draft', 'approved', 'paid', 'voided');

CREATE TABLE payouts (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id    uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    staff_id       uuid NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,

    period_start   date NOT NULL,
    period_end     date NOT NULL,

    -- Every figure a barber would want to check, kept rather than recomputed:
    -- a payout is a statement of what was agreed at the time.
    service_revenue_cents int NOT NULL DEFAULT 0,
    retail_revenue_cents  int NOT NULL DEFAULT 0,
    service_earnings_cents int NOT NULL DEFAULT 0,
    retail_earnings_cents  int NOT NULL DEFAULT 0,
    tips_cents            int NOT NULL DEFAULT 0,
    rent_cents            int NOT NULL DEFAULT 0,
    -- Net can be negative: a quiet week on chair rent means the barber owes
    -- the shop. Hiding that with a CHECK >= 0 would be lying to both parties.
    net_cents             int NOT NULL DEFAULT 0,

    compensation_kind compensation_kind NOT NULL,
    currency       char(3) NOT NULL,
    status         payout_status NOT NULL DEFAULT 'draft',

    computed_at    timestamptz NOT NULL DEFAULT now(),
    approved_at    timestamptz,
    paid_at        timestamptz,

    CONSTRAINT payout_period_ordered CHECK (period_end >= period_start),
    UNIQUE (staff_id, period_start, period_end)
);

CREATE INDEX payouts_location_period_idx
    ON payouts (location_id, period_start DESC);

-- The line-by-line backing for a payout, so a barber can see exactly which
-- sales it came from rather than being handed a single number.
CREATE TABLE payout_lines (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    payout_id         uuid NOT NULL REFERENCES payouts(id) ON DELETE CASCADE,
    checkout_id       uuid REFERENCES checkouts(id) ON DELETE SET NULL,
    checkout_item_id  uuid REFERENCES checkout_items(id) ON DELETE SET NULL,
    kind              text NOT NULL,      -- 'service' | 'product' | 'tip' | 'rent'
    description       text NOT NULL,
    gross_cents       int  NOT NULL,
    rate_bps          int,
    earnings_cents    int  NOT NULL,
    occurred_at       timestamptz NOT NULL
);

CREATE INDEX payout_lines_payout_idx ON payout_lines (payout_id);
