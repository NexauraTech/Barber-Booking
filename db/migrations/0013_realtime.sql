-- Realtime event sequence.
--
-- A deployment-wide monotonic number on every event, so a subscriber that
-- reconnects can compare the seq it last saw against the seq it now receives
-- and tell whether it missed anything. A gap means refetch the authoritative
-- state rather than trusting a replayed stream
-- (docs/research/03-realtime.md §3.5).
--
-- A sequence rather than a table: it is transaction-safe, contention-free, and
-- gaps from rolled-back transactions are harmless here — subscribers only care
-- about ordering and about noticing a jump, not about every number being used.

CREATE SEQUENCE IF NOT EXISTS realtime_event_seq AS bigint START 1 CACHE 1;
