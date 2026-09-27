-- Appointments — the correctness core of the entire product.
--
-- Two things in this file are load-bearing and must not be "simplified" later:
--
--   1. The `span` column and the `no_overlap_per_staff` exclusion constraint.
--      These make a double booking PHYSICALLY IMPOSSIBLE at the storage
--      layer. Application-level "check then insert" is a race condition: two
--      concurrent requests both read the slot as free and both insert.
--      See docs/research/02-scheduling-engine.md §2.5.
--
--      `span` is maintained by a BEFORE INSERT/UPDATE trigger rather than
--      being a GENERATED column, because `timestamptz - interval` is STABLE
--      (it depends on the session TimeZone) and Postgres requires generation
--      expressions to be IMMUTABLE. The trigger always runs, so the guarantee
--      is identical; the column is simply not writable by callers.
--
--   2. The snapshot columns (buffer_before_minutes, buffer_after_minutes,
--      policy_snapshot, and appointment_services.price/duration). Changing a
--      service or a cancellation policy tomorrow must never alter the meaning
--      of a booking made today.

CREATE TYPE appointment_status AS ENUM (
    'pending',      -- held during checkout, occupies the slot, expires
    'confirmed',
    'in_progress',
    'completed',
    'cancelled',
    'no_show'
);

CREATE TYPE appointment_source AS ENUM (
    'online', 'walkin', 'phone', 'marketplace', 'recurring'
);

CREATE TABLE appointments (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id  uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    staff_id     uuid NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
    client_id    uuid NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,

    starts_at    timestamptz NOT NULL,
    ends_at      timestamptz NOT NULL,

    -- Buffers are snapshotted onto the appointment, not read from the service.
    buffer_before_minutes int NOT NULL DEFAULT 0 CHECK (buffer_before_minutes >= 0),
    buffer_after_minutes  int NOT NULL DEFAULT 0 CHECK (buffer_after_minutes >= 0),

    -- The occupied interval including buffers. Half-open '[)' so an
    -- appointment ending at 10:00 does not collide with one starting at 10:00.
    -- Maintained by the appointments_set_span trigger below; never set by
    -- callers.
    span tstzrange,

    status       appointment_status NOT NULL DEFAULT 'pending',
    source       appointment_source NOT NULL DEFAULT 'online',

    -- Short-lived hold so a user can complete payment without the slot being
    -- taken, and without holding a database lock across a network round trip
    -- (§2.5, layer 2).
    hold_expires_at  timestamptz,
    hold_session_id  text,

    -- Replay protection for retries on flaky mobile networks (§2.5, layer 3).
    idempotency_key  text,

    -- The cancellation/deposit policy as accepted by this client at booking.
    policy_snapshot  jsonb NOT NULL DEFAULT '{}'::jsonb,

    notes            text,
    cancelled_at     timestamptz,
    cancellation_reason text,
    created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT appointments_ordered CHECK (ends_at > starts_at),

    -- A pending appointment must carry a hold; a non-pending one must not.
    CONSTRAINT hold_only_while_pending CHECK (
        (status = 'pending' AND hold_expires_at IS NOT NULL AND hold_session_id IS NOT NULL)
        OR (status <> 'pending' AND hold_expires_at IS NULL AND hold_session_id IS NULL)
    )
);

-- Keep `span` in lockstep with the times and buffers. This runs before the
-- exclusion constraint is checked, so the constraint always sees a current
-- value even if a caller tries to set span directly.
CREATE OR REPLACE FUNCTION appointments_set_span() RETURNS trigger AS $$
BEGIN
    NEW.span := tstzrange(
        NEW.starts_at - make_interval(mins => NEW.buffer_before_minutes),
        NEW.ends_at   + make_interval(mins => NEW.buffer_after_minutes),
        '[)'
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER appointments_set_span
    BEFORE INSERT OR UPDATE ON appointments
    FOR EACH ROW EXECUTE FUNCTION appointments_set_span();

-- THE constraint. 'blocking' statuses occupy the slot; cancelled and no_show
-- release it so the time can be resold.
ALTER TABLE appointments
    ADD CONSTRAINT no_overlap_per_staff
    EXCLUDE USING gist (
        staff_id WITH =,
        span     WITH &&
    ) WHERE (status IN ('pending', 'confirmed', 'in_progress', 'completed'));

-- Idempotent replay: the same key returns the original appointment.
CREATE UNIQUE INDEX appointments_idempotency_key_idx
    ON appointments (idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- The hot path: loading one staff member's day.
CREATE INDEX appointments_staff_span_idx ON appointments USING gist (staff_id, span);
CREATE INDEX appointments_location_starts_idx ON appointments (location_id, starts_at);
CREATE INDEX appointments_client_idx ON appointments (client_id, starts_at DESC);

-- Sweeper target: expired holds.
CREATE INDEX appointments_expiring_holds_idx ON appointments (hold_expires_at)
    WHERE status = 'pending';

-- Line items, priced and timed as at booking.
CREATE TABLE appointment_services (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    appointment_id  uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
    service_id      uuid NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
    name            text NOT NULL,          -- snapshot: services may be renamed
    duration_minutes int NOT NULL CHECK (duration_minutes > 0),
    price_cents     int NOT NULL CHECK (price_cents >= 0),
    sort_order      int NOT NULL DEFAULT 0
);

CREATE INDEX appointment_services_appointment_idx
    ON appointment_services (appointment_id);

-- Resource occupancy, kept separate from the staff constraint because a
-- resource is shared across staff and has capacity > 1.
CREATE TABLE appointment_resources (
    appointment_id   uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
    resource_type_id uuid NOT NULL REFERENCES resource_types(id) ON DELETE RESTRICT,
    PRIMARY KEY (appointment_id, resource_type_id)
);

-- Manual blocks: "gone to the bank", lunch moved, personal appointment.
-- Kept separate from appointments so they need no client and never appear in
-- revenue reporting, but they are read by the availability engine.
CREATE TABLE staff_blocks (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    staff_id   uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    starts_at  timestamptz NOT NULL,
    ends_at    timestamptz NOT NULL,
    reason     text,
    CONSTRAINT staff_blocks_ordered CHECK (ends_at > starts_at)
);

CREATE INDEX staff_blocks_staff_idx ON staff_blocks (staff_id, starts_at);

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER appointments_touch_updated_at
    BEFORE UPDATE ON appointments
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
