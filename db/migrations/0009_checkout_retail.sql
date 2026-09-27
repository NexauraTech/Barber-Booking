-- Phase 3: checkout, retail and tax.
--
-- All money is integer minor units (cents/pence/paise). No floats anywhere in
-- the money path: 0.1 + 0.2 != 0.3 is not an acceptable property of a till.
--
-- Tax handling has to cope with both conventions, because they are not
-- cosmetic. A UK shop advertises £45 INCLUDING VAT, so the tax is carved out
-- of the price; a US shop advertises $45 and adds sales tax on top. Storing
-- only "price" and "tax rate" without saying which convention applies gets
-- one of them wrong by the tax amount on every single sale.

ALTER TABLE locations
    ADD COLUMN prices_include_tax boolean NOT NULL DEFAULT false,
    ADD COLUMN default_tax_rate_bps int NOT NULL DEFAULT 0
        CONSTRAINT tax_rate_sane CHECK (default_tax_rate_bps BETWEEN 0 AND 10000);

-- Retail stock. Barbershops sell pomade and beard oil rather than running a
-- full salon inventory, so this stays deliberately thin.
CREATE TABLE products (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id       uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    name              text NOT NULL,
    sku               text,
    price_cents       int  NOT NULL CHECK (price_cents >= 0),
    cost_cents        int  CHECK (cost_cents >= 0),
    tax_rate_bps      int  CHECK (tax_rate_bps BETWEEN 0 AND 10000),
    stock_quantity    int  NOT NULL DEFAULT 0,
    track_stock       boolean NOT NULL DEFAULT true,
    active            boolean NOT NULL DEFAULT true,
    created_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (location_id, sku)
);

CREATE INDEX products_location_idx ON products (location_id) WHERE active;

CREATE TYPE checkout_status AS ENUM ('open', 'completed', 'voided');

CREATE TABLE checkouts (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id     uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    -- Null for a pure retail sale with no appointment behind it.
    appointment_id  uuid REFERENCES appointments(id) ON DELETE SET NULL,
    client_id       uuid REFERENCES clients(id) ON DELETE SET NULL,
    -- Who operated the till, which is not necessarily who did the haircut.
    cashier_staff_id uuid REFERENCES staff(id) ON DELETE SET NULL,

    status          checkout_status NOT NULL DEFAULT 'open',

    -- Denormalised totals, recomputed from the items on every change. Stored
    -- so a completed sale keeps the figures it was rung up with even if a
    -- price or tax rate later changes.
    subtotal_cents  int NOT NULL DEFAULT 0,
    discount_cents  int NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
    tax_cents       int NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
    tip_cents       int NOT NULL DEFAULT 0 CHECK (tip_cents >= 0),
    total_cents     int NOT NULL DEFAULT 0,

    currency        char(3) NOT NULL,
    prices_include_tax boolean NOT NULL,

    opened_at       timestamptz NOT NULL DEFAULT now(),
    completed_at    timestamptz,
    voided_at       timestamptz,
    void_reason     text,

    idempotency_key text,

    CONSTRAINT checkout_completion_shape CHECK (
        (status = 'completed' AND completed_at IS NOT NULL)
        OR (status = 'voided' AND voided_at IS NOT NULL)
        OR (status = 'open' AND completed_at IS NULL AND voided_at IS NULL)
    )
);

CREATE UNIQUE INDEX checkouts_idempotency_key_idx
    ON checkouts (idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE INDEX checkouts_location_idx ON checkouts (location_id, opened_at DESC);
CREATE INDEX checkouts_appointment_idx ON checkouts (appointment_id);
CREATE INDEX checkouts_client_idx ON checkouts (client_id, opened_at DESC);

-- One open checkout per appointment, so two staff ringing up the same client
-- cannot produce two tills.
CREATE UNIQUE INDEX checkouts_one_open_per_appointment
    ON checkouts (appointment_id)
    WHERE status = 'open' AND appointment_id IS NOT NULL;

CREATE TYPE checkout_item_kind AS ENUM ('service', 'product', 'discount');

CREATE TABLE checkout_items (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    checkout_id     uuid NOT NULL REFERENCES checkouts(id) ON DELETE CASCADE,
    kind            checkout_item_kind NOT NULL,

    service_id      uuid REFERENCES services(id) ON DELETE SET NULL,
    product_id      uuid REFERENCES products(id) ON DELETE SET NULL,

    -- Snapshot: a sale must still read correctly after a rename or reprice.
    name            text NOT NULL,
    quantity        int  NOT NULL DEFAULT 1 CHECK (quantity > 0),
    unit_price_cents int NOT NULL,
    line_total_cents int NOT NULL,
    tax_rate_bps    int  NOT NULL DEFAULT 0 CHECK (tax_rate_bps BETWEEN 0 AND 10000),
    tax_cents       int  NOT NULL DEFAULT 0,

    -- Who earns commission on this line. For a service it is the barber who
    -- performed it; for retail, whoever sold it. Not necessarily the cashier.
    earned_by_staff_id uuid REFERENCES staff(id) ON DELETE SET NULL,

    sort_order      int NOT NULL DEFAULT 0,

    -- Discounts are negative lines, so the subtotal is a plain sum.
    CONSTRAINT discount_lines_are_negative CHECK (
        (kind = 'discount' AND line_total_cents <= 0)
        OR (kind <> 'discount' AND line_total_cents >= 0)
    )
);

CREATE INDEX checkout_items_checkout_idx ON checkout_items (checkout_id);
CREATE INDEX checkout_items_earner_idx ON checkout_items (earned_by_staff_id);

-- Tips are attributed per barber rather than held as one checkout-level
-- number: a father-and-sons booking across two barbers must split correctly,
-- and tips are almost always 100% the barber's regardless of commission.
CREATE TABLE checkout_tips (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    checkout_id  uuid NOT NULL REFERENCES checkouts(id) ON DELETE CASCADE,
    staff_id     uuid NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
    amount_cents int  NOT NULL CHECK (amount_cents >= 0),
    UNIQUE (checkout_id, staff_id)
);

-- Link payments to the checkout that collected them, so split payment
-- (part cash, part card) is a set of rows against one sale.
ALTER TABLE payments
    ADD COLUMN checkout_id uuid REFERENCES checkouts(id) ON DELETE SET NULL;

CREATE INDEX payments_checkout_idx ON payments (checkout_id);
