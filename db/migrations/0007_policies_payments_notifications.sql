-- Phase 2: the no-show economics.
--
-- Industry no-show rates run 15-20% without intervention and drop to 2-5%
-- with deposits on first-time bookings. Reminders, deposits and an
-- auto-filling waitlist are the subsystem that pays for the product
-- (docs/research/01-market-landscape.md §1.7, 02-scheduling-engine.md §2.8).

-- Who has to leave a deposit. The high-leverage default is `first_time_or_risky`:
-- charge strangers and people with a no-show history, never trusted regulars.
CREATE TYPE deposit_audience AS ENUM (
    'never', 'first_time', 'risky', 'first_time_or_risky', 'always'
);

ALTER TABLE locations
    ADD COLUMN cancellation_window_hours int NOT NULL DEFAULT 24
        CONSTRAINT cancellation_window_sane CHECK (cancellation_window_hours BETWEEN 0 AND 336),
    ADD COLUMN late_cancel_fee_percent int NOT NULL DEFAULT 50
        CONSTRAINT late_cancel_fee_sane CHECK (late_cancel_fee_percent BETWEEN 0 AND 100),
    ADD COLUMN no_show_fee_percent int NOT NULL DEFAULT 100
        CONSTRAINT no_show_fee_sane CHECK (no_show_fee_percent BETWEEN 0 AND 100),
    ADD COLUMN deposit_applies_to deposit_audience NOT NULL DEFAULT 'first_time_or_risky',
    -- No-shows at or above this count make a client "risky".
    ADD COLUMN risky_no_show_threshold int NOT NULL DEFAULT 1
        CONSTRAINT risky_threshold_sane CHECK (risky_no_show_threshold >= 1),
    -- Exclusive window a waitlisted client gets to accept a freed slot
    -- before it cascades to the next match.
    ADD COLUMN waitlist_offer_ttl_seconds int NOT NULL DEFAULT 900
        CONSTRAINT waitlist_offer_ttl_sane CHECK (waitlist_offer_ttl_seconds BETWEEN 60 AND 86400),
    -- How many parties ahead trigger the "you're nearly up" nudge.
    ADD COLUMN queue_notify_ahead int NOT NULL DEFAULT 2
        CONSTRAINT queue_notify_ahead_sane CHECK (queue_notify_ahead >= 0),
    -- Preferred messaging channel; per-market (WhatsApp in MENA/South Asia,
    -- SMS in US/UK). Push is always tried first when a device token exists.
    ADD COLUMN preferred_message_channel text NOT NULL DEFAULT 'sms'
        CONSTRAINT preferred_channel_known
        CHECK (preferred_message_channel IN ('sms', 'whatsapp', 'email'));

-- Actual service timings, distinct from scheduled times. The gap between
-- them is what makes queue ETAs honest: a barber running 12 minutes late
-- should push every downstream estimate, not just the next one.
ALTER TABLE appointments
    ADD COLUMN started_at   timestamptz,
    ADD COLUMN completed_at timestamptz;

CREATE TYPE payment_kind AS ENUM (
    'deposit', 'service', 'retail', 'tip',
    'no_show_fee', 'late_cancel_fee', 'refund'
);

CREATE TYPE payment_method AS ENUM (
    'card', 'cash', 'mobile_money', 'bank_transfer', 'other'
);

CREATE TYPE payment_status AS ENUM (
    'pending', 'authorized', 'captured', 'failed', 'refunded', 'waived'
);

CREATE TABLE payments (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id     uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    appointment_id  uuid REFERENCES appointments(id) ON DELETE SET NULL,
    client_id       uuid NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,

    amount_cents    int  NOT NULL CHECK (amount_cents >= 0),
    currency        char(3) NOT NULL,
    kind            payment_kind   NOT NULL,
    method          payment_method NOT NULL DEFAULT 'card',
    status          payment_status NOT NULL DEFAULT 'pending',

    processor       text,
    processor_ref   text,

    -- Relationships matter more than a £15 fee, so waiving is always one
    -- action away and is recorded rather than deleted.
    waived_by       uuid REFERENCES users(id) ON DELETE SET NULL,
    waived_reason   text,

    -- Replay protection for retried charge requests.
    idempotency_key text,

    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT waived_has_reason CHECK (
        status <> 'waived' OR waived_reason IS NOT NULL
    )
);

CREATE UNIQUE INDEX payments_idempotency_key_idx
    ON payments (idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE INDEX payments_appointment_idx ON payments (appointment_id);
CREATE INDEX payments_client_idx ON payments (client_id, created_at DESC);

CREATE TRIGGER payments_touch_updated_at
    BEFORE UPDATE ON payments
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Notification outbox.
--
-- Messages are rows first and sends second, so a crashed worker retries
-- instead of losing a reminder, and a cancelled appointment can withdraw
-- reminders that have not gone out yet.
CREATE TYPE notification_channel AS ENUM ('push', 'sms', 'whatsapp', 'email');

CREATE TYPE notification_status AS ENUM (
    'scheduled', 'sent', 'failed', 'cancelled', 'suppressed'
);

CREATE TABLE notifications (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id     uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,

    -- Recipients may be guests with no account, so the address is denormalised
    -- onto the row rather than joined at send time.
    client_id       uuid REFERENCES clients(id) ON DELETE CASCADE,
    staff_id        uuid REFERENCES staff(id) ON DELETE CASCADE,
    address         text NOT NULL,              -- phone, email or device token

    channel         notification_channel NOT NULL,
    template        text NOT NULL,              -- 'reminder_24h', 'queue_next', …
    payload         jsonb NOT NULL DEFAULT '{}'::jsonb,

    scheduled_for   timestamptz NOT NULL,
    sent_at         timestamptz,
    failed_at       timestamptz,
    attempts        int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_error      text,
    status          notification_status NOT NULL DEFAULT 'scheduled',

    appointment_id   uuid REFERENCES appointments(id) ON DELETE CASCADE,
    queue_entry_id   uuid REFERENCES queue_entries(id) ON DELETE CASCADE,
    waitlist_entry_id uuid REFERENCES waitlist_entries(id) ON DELETE CASCADE,

    -- Makes scheduling idempotent: re-running the scheduler for an
    -- appointment cannot produce a second copy of the same reminder.
    dedupe_key      text NOT NULL,

    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX notifications_dedupe_key_idx ON notifications (dedupe_key);

-- The worker's claim query: what is due now.
CREATE INDEX notifications_due_idx ON notifications (scheduled_for)
    WHERE status = 'scheduled';

CREATE INDEX notifications_appointment_idx ON notifications (appointment_id);

-- Per-client channel and consent preferences. Transactional and marketing
-- consent are tracked separately: confirming a booking is not permission to
-- send Tuesday discounts (GDPR/TCPA, docs/research/03-realtime.md §3.6).
CREATE TABLE client_contact_preferences (
    client_id            uuid PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
    preferred_channel    notification_channel,
    push_token           text,
    transactional_opt_in boolean NOT NULL DEFAULT true,
    marketing_opt_in     boolean NOT NULL DEFAULT false,
    -- Local wall-clock quiet hours; non-urgent messages are held until after.
    quiet_hours_start    time,
    quiet_hours_end      time
);
