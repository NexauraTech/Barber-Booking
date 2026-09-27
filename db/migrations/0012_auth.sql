-- Authentication.
--
-- Phone is the identity (docs/research/01-market-landscape.md §1.6): email is
-- often absent in this product's target markets, and an email-plus-password
-- signup gate is the single biggest drop-off in the booking funnel
-- (docs/research/04-apps-and-ux.md §4.1). So: phone, one-time code, done —
-- and identity is collected at CONFIRM, not before browsing.
--
-- Neither codes nor tokens are stored in the clear. A database leak should
-- not hand over live sessions or usable login codes.

CREATE TABLE otp_challenges (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    phone        text NOT NULL,
    -- sha256(code + id). Never the code itself.
    code_hash    text NOT NULL,
    expires_at   timestamptz NOT NULL,
    -- Bounded so a code cannot be brute-forced within its lifetime.
    attempts     int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    max_attempts int NOT NULL DEFAULT 5,
    consumed_at  timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX otp_challenges_phone_idx ON otp_challenges (phone, created_at DESC);
CREATE INDEX otp_challenges_expiry_idx ON otp_challenges (expires_at)
    WHERE consumed_at IS NULL;

CREATE TABLE auth_sessions (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- sha256 of the bearer token. The token itself is returned once, to the
    -- caller, and never stored.
    token_hash   text NOT NULL,
    expires_at   timestamptz NOT NULL,
    revoked_at   timestamptz,
    user_agent   text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz
);

CREATE UNIQUE INDEX auth_sessions_token_hash_idx ON auth_sessions (token_hash);
CREATE INDEX auth_sessions_user_idx ON auth_sessions (user_id)
    WHERE revoked_at IS NULL;
