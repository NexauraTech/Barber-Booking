-- Clients belong to the organisation, not to an individual barber.
--
-- This is the structural decision flagged in docs/research/05-reference-architecture.md
-- §5.5(4): chair-rent contractors want to take their client list when they
-- move shops, shops want it to stay. Owning it at the org level with a
-- preferred_staff_id is the compromise: the shop keeps the record, the barber
-- keeps the relationship, and export is a per-barber filter rather than a
-- different ownership model.

CREATE TABLE clients (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    user_id         uuid REFERENCES users(id) ON DELETE SET NULL,  -- NULL = guest
    name            text NOT NULL,
    phone           text NOT NULL,
    email           text,
    notes           text,

    -- Reputation drives deposit escalation (§2.8). Never exposed across orgs.
    no_show_count     int NOT NULL DEFAULT 0 CHECK (no_show_count >= 0),
    late_cancel_count int NOT NULL DEFAULT 0 CHECK (late_cancel_count >= 0),

    tags            text[] NOT NULL DEFAULT '{}',
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, phone)
);

CREATE INDEX clients_org_name_idx ON clients (org_id, lower(name));

CREATE TABLE client_preferences (
    client_id          uuid PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
    preferred_staff_id uuid REFERENCES staff(id) ON DELETE SET NULL,
    preferred_daypart  text,                   -- 'morning' | 'afternoon' | 'evening'
    interval_weeks     int CHECK (interval_weeks > 0)   -- drives rebook prompts
);
