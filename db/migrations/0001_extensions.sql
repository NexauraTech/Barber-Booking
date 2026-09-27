-- Extensions required by the schema.
--
-- btree_gist lets a GiST exclusion constraint mix an equality operator on a
-- scalar column (staff_id WITH =) with an overlap operator on a range
-- (span WITH &&). Without it, the no-overlap constraint in 0005 cannot be
-- created. See docs/research/02-scheduling-engine.md §2.5.

CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
