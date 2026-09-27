# Barber Booking

A barber appointment booking + shop management platform: a customer app, a barber app,
and a back office — mobile-first, realtime, with a scheduling engine built for the way
barbershops actually run (appointments *and* walk-ins).

**Status:** Phases 1–3 plus the HTTP API are implemented and tested — the scheduling core,
the walk-in queue, the waitlist, the deposit/no-show machinery, checkout with payouts and
reporting, and a Fastify API over all of it (384 tests, including double-booking races
against a real Postgres). There is no realtime layer or UI yet, and payments are recorded
rather than charged. See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) to run it and
[docs/API.md](docs/API.md) for the endpoints.

## Start here

| Document | What's in it |
| --- | --- |
| [docs/research/01-market-landscape.md](docs/research/01-market-landscape.md) | How barber booking works globally: the players, their business models, regional differences, what barbers complain about |
| [docs/research/02-scheduling-engine.md](docs/research/02-scheduling-engine.md) | The hard part: availability rules, slot generation, double-booking prevention, timezones, walk-in queues, no-shows |
| [docs/research/03-realtime.md](docs/research/03-realtime.md) | What genuinely needs to be realtime, channel design, optimistic UI, offline, notifications |
| [docs/research/04-apps-and-ux.md](docs/research/04-apps-and-ux.md) | Customer app, barber app, shop manager back office — screen by screen, with mobile-first UX rules |
| [docs/research/05-reference-architecture.md](docs/research/05-reference-architecture.md) | Recommended stack, data model, API surface, and a phased build plan |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Running the code: setup, tests, layout, and the invariants to preserve |
| [docs/API.md](docs/API.md) | HTTP endpoints, authentication, permissions and error codes |

## The short version

1. **Availability is computed, never stored.** Free slots are derived on demand from shifts,
   service duration, buffers, existing bookings and resources. Storing "free slots" as rows is
   the single most common design mistake in this domain.
2. **The database prevents double booking, not the application.** A PostgreSQL exclusion
   constraint on a `tstzrange` makes overlap physically impossible; app-level checks are a
   race condition waiting to happen.
3. **Walk-ins are a first-class flow, not an afterthought.** In most of the world, barbering is
   a walk-in trade. A product that only models a calendar loses to one that also models a queue.
4. **No-shows are the core economic problem.** Industry average is 15–20%; deposits plus layered
   reminders plus an auto-filling waitlist take it to low single digits.
5. **Mobile-first means the whole booking is 4 taps and no forced signup.** Service → barber →
   time → confirm, with phone-OTP auth deferred to the last step.
