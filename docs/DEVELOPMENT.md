# Development

## Requirements

- Node 20+
- PostgreSQL 14+ (16 recommended) with the `btree_gist` and `pgcrypto`
  extensions available

`btree_gist` is not optional: without it the `no_overlap_per_staff` exclusion
constraint cannot be created, and that constraint is the product's guarantee
against double booking.

## Setup

```bash
npm install

# Point at any Postgres you like.
export DATABASE_URL="postgres://postgres@localhost:5432/barber_booking"
createdb barber_booking

npm run db:migrate     # apply schema
npm run db:seed        # one shop, two barbers, three services
```

`npm run db:reset` drops and rebuilds the schema, then reseeds.

### A throwaway local cluster

If you don't have a server running, a scratch cluster on a non-standard port
keeps this project away from anything else:

```bash
export PGDATA=/tmp/bb-pg
initdb -D "$PGDATA" -U postgres --auth=trust
pg_ctl -D "$PGDATA" -o "-p 55432 -k /tmp" -l "$PGDATA/server.log" start
psql -h /tmp -p 55432 -U postgres -c "CREATE DATABASE barber_booking"

export DATABASE_URL="postgres://postgres@/barber_booking?host=/tmp&port=55432"
```

On Debian/Ubuntu, `initdb` and `pg_ctl` live in `/usr/lib/postgresql/<version>/bin`,
and neither will run as root — use an unprivileged user that owns `$PGDATA`.

## Tests

```bash
npm test              # everything
npm run test:watch
npm run typecheck
```

The suite splits in two:

- **Pure domain tests** (`interval`, `localtime`, `availability`) need no
  database. The scheduling rules are deliberately testable without one.
- **Database tests** (`booking.db`) exercise the guarantees only a real
  Postgres can demonstrate: the exclusion constraint under concurrent load,
  hold expiry, and idempotent retries. They **skip automatically** when
  `DATABASE_URL` is unset, so `npm test` still passes on a machine with no
  database — check the output rather than assuming they ran.

Database tests share one schema and `TRUNCATE` between cases, so
`vitest.config.ts` disables file parallelism. Keep it that way.

## Layout

```
db/migrations/        forward-only SQL, applied in filename order
src/domain/           pure scheduling logic — no SQL, no clock, no I/O
  interval.ts         half-open interval arithmetic
  localtime.ts        wall-clock rules -> instants, DST, shift rotation
  availability.ts     the slot engine
src/db/               loading facts and resolving recurring rules
src/booking/          commands: hold, confirm, cancel, no-show
scripts/              migrate, seed
tests/
```

The dependency rule: `src/domain` imports nothing from `src/db`. Scheduling
rules stay pure and fast to test; everything that touches Postgres or the
clock lives outside them.

## Working on the scheduling engine

Three invariants to preserve:

1. **Availability is computed, never stored.** There is no `slots` table and
   there must not be one — see `docs/research/02-scheduling-engine.md` §2.1.
2. **The database prevents double booking.** The engine's collision check is
   a UX affordance so users see accurate times; the exclusion constraint is
   the actual guarantee. A `SLOT_TAKEN` error from a constraint violation is
   the expected losing path in a race, not a bug.
3. **One clock per request.** The caller's `now` flows through the engine and
   into SQL parameters. Never mix it with SQL `now()` — they disagree the
   moment the clock is simulated, which silently breaks hold expiry.

Half-open intervals `[start, end)` are used throughout, matching the `[)`
bounds of the `tstzrange` in the constraint. An appointment ending at 10:00
does not collide with one starting at 10:00.

## What's built

Phase 1 of the plan in `docs/research/05-reference-architecture.md` §5.4:
schema, availability engine, and the booking commands with holds and
idempotency.

Not built yet: HTTP API, realtime channels, queue and waitlist logic (tables
exist, behaviour doesn't), notifications, payments, checkout, and the apps.
