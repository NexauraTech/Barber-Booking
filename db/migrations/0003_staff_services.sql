-- Staff, their working patterns, the service catalogue, and resources.

CREATE TABLE users (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    phone       text UNIQUE NOT NULL,       -- phone is the identity (§1.6)
    email       text,
    name        text NOT NULL,
    avatar_url  text,
    locale      text NOT NULL DEFAULT 'en',
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE staff_role AS ENUM ('owner', 'manager', 'front_desk', 'barber', 'apprentice');

CREATE TABLE staff (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    location_id   uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    role          staff_role NOT NULL DEFAULT 'barber',
    tier          text,                      -- 'apprentice' | 'barber' | 'master'
    display_name  text NOT NULL,

    -- Per-barber booking rules (§2.9)
    accepts_online      boolean NOT NULL DEFAULT true,
    accepts_walkins     boolean NOT NULL DEFAULT true,
    accepts_any_barber  boolean NOT NULL DEFAULT true,
    max_daily_bookings  int,

    active        boolean NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, location_id)
);

CREATE INDEX staff_location_idx ON staff (location_id) WHERE active;

-- Recurring shifts. repeat_interval_weeks = 2 with an anchor date expresses
-- "alternate Mondays"; each weekday can rotate independently (§2.9).
CREATE TABLE shifts (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    staff_id              uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    weekday               int  NOT NULL CHECK (weekday BETWEEN 1 AND 7),
    starts_at             time NOT NULL,
    ends_at               time NOT NULL,
    repeat_interval_weeks int  NOT NULL DEFAULT 1 CHECK (repeat_interval_weeks BETWEEN 1 AND 8),
    anchor_date           date NOT NULL,     -- week 0 of the rotation
    effective_from        date NOT NULL,
    effective_to          date,              -- NULL = open ended
    CONSTRAINT shifts_ordered CHECK (ends_at > starts_at)
);

CREATE INDEX shifts_staff_idx ON shifts (staff_id, weekday);

-- One-off overrides to the recurring pattern.
CREATE TYPE shift_exception_kind AS ENUM ('off', 'custom');

CREATE TABLE shift_exceptions (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    staff_id   uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    on_date    date NOT NULL,
    kind       shift_exception_kind NOT NULL,
    starts_at  time,
    ends_at    time,
    CONSTRAINT shift_exception_shape CHECK (
        (kind = 'off'    AND starts_at IS NULL AND ends_at IS NULL)
        OR (kind = 'custom' AND starts_at IS NOT NULL AND ends_at IS NOT NULL
            AND ends_at > starts_at)
    ),
    UNIQUE (staff_id, on_date)
);

-- Breaks: recurring (weekday set) or one-off (on_date set), never both.
CREATE TABLE breaks (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    staff_id   uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    weekday    int CHECK (weekday BETWEEN 1 AND 7),
    on_date    date,
    starts_at  time NOT NULL,
    ends_at    time NOT NULL,
    CONSTRAINT breaks_ordered CHECK (ends_at > starts_at),
    CONSTRAINT breaks_recurring_xor_dated CHECK (
        (weekday IS NOT NULL AND on_date IS NULL)
        OR (weekday IS NULL AND on_date IS NOT NULL)
    )
);

CREATE INDEX breaks_staff_idx ON breaks (staff_id);

CREATE TYPE time_off_status AS ENUM ('pending', 'approved', 'denied');

CREATE TABLE time_off (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    staff_id    uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    starts_at   timestamptz NOT NULL,
    ends_at     timestamptz NOT NULL,
    status      time_off_status NOT NULL DEFAULT 'pending',
    reason      text,
    CONSTRAINT time_off_ordered CHECK (ends_at > starts_at)
);

CREATE INDEX time_off_staff_idx ON time_off (staff_id, starts_at)
    WHERE status = 'approved';

-- Resources: chairs, basins, private rooms. capacity > 1 means several
-- clients can use the resource type simultaneously (§2.3).
CREATE TABLE resource_types (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id  uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    name         text NOT NULL,              -- 'chair' | 'basin' | 'room'
    capacity     int  NOT NULL CHECK (capacity > 0),
    UNIQUE (location_id, name)
);

CREATE TABLE service_categories (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id  uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    name         text NOT NULL,
    sort_order   int  NOT NULL DEFAULT 0
);

CREATE TABLE services (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id       uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    category_id       uuid REFERENCES service_categories(id) ON DELETE SET NULL,
    name              text NOT NULL,
    duration_minutes  int  NOT NULL CHECK (duration_minutes > 0),
    price_cents       int  NOT NULL CHECK (price_cents >= 0),
    buffer_before_minutes int NOT NULL DEFAULT 0 CHECK (buffer_before_minutes >= 0),
    buffer_after_minutes  int NOT NULL DEFAULT 0 CHECK (buffer_after_minutes >= 0),
    resource_type_id  uuid REFERENCES resource_types(id) ON DELETE SET NULL,
    online_bookable   boolean NOT NULL DEFAULT true,
    is_addon          boolean NOT NULL DEFAULT false,
    deposit_policy    jsonb NOT NULL DEFAULT '{"kind":"none"}'::jsonb,
    active            boolean NOT NULL DEFAULT true
);

CREATE INDEX services_location_idx ON services (location_id) WHERE active;

-- Which staff can perform which service, with per-barber duration and price
-- overrides. A master barber does a fade faster and charges more (§1.3).
CREATE TABLE staff_services (
    staff_id          uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    service_id        uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    duration_minutes  int CHECK (duration_minutes > 0),   -- NULL = use service default
    price_cents       int CHECK (price_cents >= 0),
    PRIMARY KEY (staff_id, service_id)
);
