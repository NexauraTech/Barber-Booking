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
`vitest.config.ts` sets `fileParallelism: false`. **Keep it that way** — this
is not a performance tweak. Running the database test files concurrently makes
them truncate each other's fixtures mid-test; forcing it on fails roughly 79 of
84 tests.

## Layout

```
db/migrations/        forward-only SQL, applied in filename order
src/domain/           pure logic — no SQL, no clock, no I/O
  interval.ts         half-open interval arithmetic
  localtime.ts        wall-clock rules -> instants, DST, shift rotation
  availability.ts     the slot engine
  queue.ts            walk-in queue simulation and ETA ranges
  policy.ts           deposit and cancellation policy evaluation
  reminders.ts        the 48h/24h/2h ladder, quiet hours
  channels.ts         push/SMS/WhatsApp selection and consent
  money.ts            integer-cent arithmetic, tax, discounts, allocation
  compensation.ts     commission, chair rent and salary payouts
src/db/               loading facts and resolving recurring rules
src/booking/          commands: hold, confirm, cancel, no-show, fees
src/queue/            walk-in queue service
src/waitlist/         offers, acceptance, expiry cascade
src/notifications/    outbox, scheduling, worker
src/checkout/         point of sale: items, discounts, tips, split payment
src/payouts/          payout computation and approval
src/reporting/        utilisation, rebook rate, no-show cost, dashboards
src/auth/             phone-OTP login, session tokens, staff memberships
src/api/              Fastify server, routes, error mapping, authorisation
src/realtime/         event catalogue, channels, LISTEN/NOTIFY bus, hub, socket
app/customer/         the customer web app (Preact, mobile-first)
  src/state/          pure flow machine and formatting — no DOM, no fetch
  src/api/            typed API client and realtime client
  src/screens/        booking flow and walk-in queue
scripts/              migrate, seed, serve, smoke-app
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

## Working on the outbox

Two rules keep reminders from being sent twice or dropped:

- **Queueing is idempotent** through `dedupe_key`. Re-running the scheduler
  for an appointment must never produce a second copy of a message.
- **Claiming takes a lease**, not just a row lock. `FOR UPDATE SKIP LOCKED`
  only stops simultaneous claims — the lock dies with the transaction, so a
  worker that claims, commits, then crashes would otherwise have its message
  re-sent by the next poll. `claimed_at` holds the message for
  `DEFAULT_LEASE_SECONDS`; if the worker died, the lease lapses and it
  retries.

The transport is injected (`src/notifications/worker.ts`). Twilio, the
WhatsApp Business API and FCM/APNs are not wired up; `RecordingTransport` and
`FailingTransport` stand in for them.

## Working on money

Three rules, and all three have bitten real products:

1. **Integer minor units only.** Cents, pence, paise — never floats. Rates are
   basis points (4250 = 42.5%), because percentages as floats reintroduce
   exactly the rounding problem integers were chosen to avoid.
2. **Tax convention is not cosmetic.** A UK shop advertises £45 *including*
   VAT, so tax is carved out of the price; a US shop advertises $45 and adds
   sales tax on top. `locations.prices_include_tax` decides which, and getting
   it backwards misstates the tax on every sale by the tax amount.
3. **Splitting money must not lose a penny.** `allocate()` distributes a
   remainder one unit at a time rather than rounding each share
   independently, so the parts always sum to the whole.

Rounding is half-away-from-zero, which is what a till does. `Math.round`
rounds half *up*, so it turns -2.5 into -2 and rounds discount lines the wrong
way.

## Working on the API

See [API.md](API.md) for the endpoint reference. Three things to preserve:

1. **Browsing is public.** Shop details, availability and queue status need no
   account. An auth gate in front of the booking flow is the biggest single
   drop-off there is.
2. **Authorisation is per location.** A barber at one shop is not staff at
   another, and seeing money is a different permission from taking a booking.
   Use `requireStaff(request, locationId, roles)` — never trust a staff id
   from a request body.
3. **Clients never write appointment rows.** Every booking goes through a
   command in `src/booking/`. The API is the enforcement point for that.

Tests drive the real app with Fastify's `inject()`, so they need no ports and
cannot collide.

## Working on realtime

See [REALTIME.md](REALTIME.md) for the protocol. Four rules:

1. **The socket is read-only.** Subscribe, unsubscribe, ping. Writes go through
   the HTTP API, because a booking is a command with a server-decided outcome.
2. **Redaction happens in one place.** An event is published once and
   projected per channel by `projectForChannel`. Never build a per-channel
   payload at a call site — that is how a client's name ends up on a channel
   other clients can join.
3. **Publish on the transaction's client.** Postgres holds the notification
   until COMMIT and discards it on ROLLBACK, so an event can only describe a
   write that landed. Publishing outside the transaction loses that.
4. **Emitting must never break a write.** The helpers in `src/realtime/emit.ts`
   swallow their own errors on purpose. A degraded UI beats a lost booking.
   `REALTIME_DEBUG=true` logs them.

Events carry deltas, not rows — partly discipline, partly the 8000-byte NOTIFY
ceiling. Anything larger becomes a `resync`.

The WebSocket tests are the only ones in the suite that bind a port; `inject()`
cannot exercise an upgrade.

## Working on the customer app

See [CUSTOMER-APP.md](CUSTOMER-APP.md). Four rules:

1. **Browsing needs no account.** Identity is collected at the end of the
   flow, never as a gate. No password field, no email field.
2. **`state/` stays pure.** No React, no fetch, no clock — the flow's rules
   are testable without a DOM, as `src/domain` is on the server.
3. **Bundle size is a feature.** The app ships Preact via compat (16KB rather
   than 77KB gzipped) because the budget is under three seconds to interactive
   on a mid-range Android. Check `npm run app:build` output before adding a
   dependency.
4. **Losing a slot is a flow outcome, not an error.** `SLOT_TAKEN` returns to
   the grid naming the lost time with the selection intact.

`npm run app:smoke <locationId>` drives a real Chromium at 375px and checks
touch-target size, overflow and the no-account path by measurement rather than
by class name.

## What's built

Phases 1 and 2 of the plan in `docs/research/05-reference-architecture.md` §5.4.

**Phase 1 — booking core.** Schema, availability engine, and the booking
commands with holds and idempotency.

**Phase 2 — walk-in and no-show economics.**
- Walk-in queue: QR join with no account, simulated ETAs as ranges, call-up
  notifications, promotion into a real appointment through the same exclusion
  constraint as any booking.
- Waitlist: automatic offers on cancellation, ranked best-match-first, held as
  a real pending appointment for an exclusive window, cascading to the next
  match when an offer lapses.
- Policy: deposits aimed at first-time and no-show-risk clients, cancellation
  and no-show fees raised automatically and always waivable, terms snapshotted
  onto the appointment at booking.
- Notifications: outbox with leases and retry, the 48h/24h/2h reminder ladder,
  quiet hours, per-market channel selection with consent.

**Phase 3 — money and the shop.**
- Checkout: opens pre-filled from the appointment at booked prices, retail
  with stock tracking, discounts that relieve tax proportionally, tips
  attributed per barber, split payment across cash and card, and deposits
  credited against the bill. Completing marks the appointment done and
  returns a rebook suggestion learned from the client's own visit rhythm.
- Payouts: commission, chair rent (which can leave a barber owing on a quiet
  week) and salary, effective-dated so recomputing an old period uses the
  deal that applied then. Draft → approved → paid, with line-by-line backing.
- Reporting: revenue by barber, chair utilisation against shift hours, rebook
  rate, no-show cost against fees recovered, new-vs-returning mix, and a
  daily dashboard.

**HTTP API.** Phone-OTP authentication with hashed codes and tokens, the public
booking and queue endpoints, staff-side queue and checkout, reporting and
payouts, per-location role checks, rate limiting and structured errors.

**Realtime.** Postgres LISTEN/NOTIFY bus with transactional delivery, a
connection hub with per-channel projection, and a read-only WebSocket endpoint.
Public channels for availability deltas and queue position; staff channels with
full detail; per-location authorisation on every subscription.

**Customer app.** Mobile-first web app over the API and socket: browse, book,
walk-in queue, and cancel. Preact, 16KB gzipped, no account needed to browse or
to join a queue.

Not built yet: payment processor integration (payments are recorded, not
charged), marketing and loyalty, and the barber/back-office apps.

