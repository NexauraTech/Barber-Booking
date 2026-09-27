-- Claim leases for the notification outbox.
--
-- `FOR UPDATE SKIP LOCKED` only stops two workers claiming the same row at
-- the same instant — the lock dies with the transaction. A worker that claims
-- a message, commits, and then crashes mid-send leaves a row that still reads
-- `scheduled`, so the next poll claims and re-sends it. For reminders that
-- means a client gets the same message twice.
--
-- A claim therefore takes a LEASE: `claimed_at` is stamped on the row and the
-- claim query ignores rows leased recently. If the worker dies, the lease
-- lapses and the message becomes claimable again; if it succeeds, the status
-- moves off `scheduled` and it never comes back.

ALTER TABLE notifications
    ADD COLUMN claimed_at timestamptz;

-- The claim query's index: due, unsent, and not currently leased.
DROP INDEX IF EXISTS notifications_due_idx;
CREATE INDEX notifications_due_idx
    ON notifications (scheduled_for, claimed_at)
    WHERE status = 'scheduled';
