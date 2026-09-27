-- Walk-in queue and waitlist.
--
-- A queue entry and an appointment are two states of the same underlying
-- thing (docs/research/01-market-landscape.md §1.5): a walk-in is promoted
-- into a real appointment the moment a barber takes them, which is how
-- walk-in revenue reaches the same reporting and checkout path as booked
-- revenue.
--
-- Position is NOT stored authoritatively. It is derived from joined_at
-- ordering among waiting entries, so there is no renumbering to get wrong
-- when someone abandons. Manual reordering is expressed as a priority bump.

CREATE TYPE queue_status AS ENUM (
    'waiting', 'notified', 'in_chair', 'served', 'abandoned', 'promoted'
);

CREATE TABLE queue_entries (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id       uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    client_id         uuid REFERENCES clients(id) ON DELETE SET NULL,

    -- Walk-ins join by QR code with no account (§1.5), so name/phone are
    -- carried on the entry itself.
    guest_name        text,
    guest_phone       text,

    service_ids       uuid[] NOT NULL CHECK (cardinality(service_ids) > 0),
    preferred_staff_id uuid REFERENCES staff(id) ON DELETE SET NULL,  -- NULL = any

    joined_at         timestamptz NOT NULL DEFAULT now(),
    priority          int NOT NULL DEFAULT 0,   -- higher = earlier; manual bumps
    status            queue_status NOT NULL DEFAULT 'waiting',

    notified_at       timestamptz,
    promoted_appointment_id uuid REFERENCES appointments(id) ON DELETE SET NULL,

    -- Public token for the no-auth "where am I in the queue" page.
    public_token      text NOT NULL DEFAULT encode(gen_random_bytes(16), 'hex'),

    CONSTRAINT queue_identifiable CHECK (
        client_id IS NOT NULL OR (guest_name IS NOT NULL AND guest_phone IS NOT NULL)
    )
);

CREATE UNIQUE INDEX queue_entries_public_token_idx ON queue_entries (public_token);

-- The live-queue read: ordered, filtered to entries still in play.
CREATE INDEX queue_entries_live_idx
    ON queue_entries (location_id, priority DESC, joined_at)
    WHERE status IN ('waiting', 'notified');

CREATE TYPE waitlist_status AS ENUM (
    'active', 'offered', 'accepted', 'expired', 'cancelled'
);

CREATE TABLE waitlist_entries (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id   uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    client_id     uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    service_ids   uuid[] NOT NULL CHECK (cardinality(service_ids) > 0),
    staff_id      uuid REFERENCES staff(id) ON DELETE CASCADE,   -- NULL = any

    -- The window the client would accept.
    from_date     date NOT NULL,
    to_date       date NOT NULL,
    earliest_time time,
    latest_time   time,

    status        waitlist_status NOT NULL DEFAULT 'active',

    -- Exclusive offer window before cascading to the next match (§2.8).
    offered_at            timestamptz,
    offer_expires_at      timestamptz,
    offered_appointment_id uuid REFERENCES appointments(id) ON DELETE SET NULL,

    created_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT waitlist_dates_ordered CHECK (to_date >= from_date),
    CONSTRAINT waitlist_times_ordered CHECK (
        earliest_time IS NULL OR latest_time IS NULL OR latest_time > earliest_time
    )
);

CREATE INDEX waitlist_active_idx
    ON waitlist_entries (location_id, from_date, to_date)
    WHERE status = 'active';

CREATE INDEX waitlist_expiring_offers_idx
    ON waitlist_entries (offer_expires_at)
    WHERE status = 'offered';
