-- Organisations, locations, and the recurring/dated rules that define when a
-- shop is open at all.
--
-- Opening hours and closures are stored as LOCAL WALL-CLOCK TIME plus a
-- weekday or date, never as instants. "Opens at 09:00" must stay 09:00 across
-- a DST transition. The availability engine expands these to instants in the
-- location's IANA timezone at query time.
-- See docs/research/02-scheduling-engine.md §2.6.

CREATE TABLE organisations (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text        NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE locations (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id       uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    name         text NOT NULL,
    address      text,
    timezone     text NOT NULL,                 -- IANA, e.g. 'Asia/Karachi'
    currency     char(3) NOT NULL DEFAULT 'USD',

    -- Scheduling policy (docs/research/02-scheduling-engine.md §2.9)
    slot_step_minutes    int NOT NULL DEFAULT 15
        CONSTRAINT slot_step_sane CHECK (slot_step_minutes BETWEEN 1 AND 120),
    min_lead_minutes     int NOT NULL DEFAULT 0
        CONSTRAINT min_lead_sane CHECK (min_lead_minutes >= 0),
    max_horizon_days     int NOT NULL DEFAULT 60
        CONSTRAINT max_horizon_sane CHECK (max_horizon_days BETWEEN 1 AND 365),
    hold_ttl_seconds     int NOT NULL DEFAULT 420    -- 7 minutes
        CONSTRAINT hold_ttl_sane CHECK (hold_ttl_seconds BETWEEN 30 AND 3600),

    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX locations_org_idx ON locations (org_id);

-- Recurring weekly opening hours. Multiple rows per weekday are allowed so a
-- shop can close for lunch (09:00-13:00 and 14:00-20:00).
CREATE TABLE opening_hours (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id  uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    weekday      int  NOT NULL CHECK (weekday BETWEEN 1 AND 7),   -- ISO: 1=Mon
    opens_at     time NOT NULL,
    closes_at    time NOT NULL,
    CONSTRAINT opening_hours_ordered CHECK (closes_at > opens_at)
);

CREATE INDEX opening_hours_location_idx ON opening_hours (location_id, weekday);

-- Dated overrides: holidays, refurbishment, or special hours.
-- opens_at/closes_at NULL means "closed all day".
CREATE TABLE closures (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id  uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    on_date      date NOT NULL,
    opens_at     time,
    closes_at    time,
    reason       text,
    CONSTRAINT closures_ordered CHECK (
        (opens_at IS NULL AND closes_at IS NULL)
        OR (opens_at IS NOT NULL AND closes_at IS NOT NULL AND closes_at > opens_at)
    ),
    UNIQUE (location_id, on_date)
);
