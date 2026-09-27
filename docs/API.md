# HTTP API

```bash
npm run serve     # PORT=3000 by default
npm run dev       # with reload
```

All responses are JSON. Errors have the shape:

```json
{ "error": "SLOT_TAKEN", "message": "That time was just taken", "details": { } }
```

## The rule this API enforces

**A booking is a command, not a row a client writes.** Clients read availability
freely and write nothing directly; every appointment goes through a server-side
command that enforces holds, idempotency and policy. That is what makes the
double-booking guarantee hold end to end.

## Authentication

Phone plus a one-time code. There is no password and no separate signup — the
account is created on first successful verification, and identity is collected
at *confirm*, not before browsing.

```
POST /auth/otp        { phone, locationId? }  -> { challengeId, expiresAt }
POST /auth/verify     { challengeId, code, name? } -> { token, userId, expiresAt }
GET  /auth/me         -> { userId, name, phone, staff: [...] }
POST /auth/logout     -> 204
```

Send the token as `Authorization: Bearer <token>`.

`POST /auth/otp` answers identically whether or not the number has an account —
anything else turns it into an account-enumeration oracle. It is rate limited to
5 per 15 minutes because it sends SMS, which costs real money.

Codes and tokens are stored as SHA-256 hashes. A wrong code costs an attempt
even if the request is abandoned, and five wrong attempts lock the challenge.

## Public endpoints

No account required. Browsing must work for someone who has never used the app —
an auth gate here is the biggest single drop-off in the booking funnel.

```
GET  /health
GET  /locations/:locationId
GET  /locations/:locationId/availability?serviceIds=a,b&date=YYYY-MM-DD&staffId=
POST /locations/:locationId/queue          join the walk-in queue as a guest
GET  /queue/:publicToken                   live position and ETA
DELETE /queue/:publicToken                 leave the queue
```

Availability returns distinct start times with the barbers free at each, plus
the **shop's** timezone — a client booking from another country must never be
shown times silently shifted into their own zone.

The public queue endpoints return position and wait range only. They are
reachable by anyone holding the token, so they carry no names or numbers.

## Booking

```
POST /appointments/hold                    { locationId, serviceIds, start, staffId? }
POST /appointments/:id/confirm             Idempotency-Key: <uuid>
GET  /appointments?upcoming=true
POST /appointments/:id/cancel              { reason? }
POST /appointments/:id/no-show             staff only
POST /appointments/:id/status              { status: in_progress | completed }
```

`hold` reserves the slot as a pending appointment through the same exclusion
constraint as a confirmed booking, so nobody can take it during checkout, and it
expires on its own if the user wanders off.

**Always send `Idempotency-Key` on confirm.** It is how a retry on a flaky
mobile network produces one booking instead of two. Without it the server
generates a fresh key per attempt and you lose that protection.

Cancelling immediately offers the freed slot to the waitlist; the response says
whether it was refilled, and states any fee plainly.

## Walk-in queue (staff side)

```
GET  /locations/:locationId/queue           full queue with contact details
POST /locations/:locationId/queue/notify    nudge whoever is nearly up
POST /queue/:queueEntryId/seat              { staffId? } -> a real appointment
POST /queue/:queueEntryId/priority          { priority }
```

Seating a walk-in creates an ordinary appointment, so walk-in revenue flows
through the same checkout and reporting path as booked revenue.

## Checkout

```
POST /appointments/:id/checkout             open, pre-filled from the booking
POST /locations/:locationId/checkout        standalone retail sale
GET  /checkouts/:id
POST /checkouts/:id/items                   { productId, quantity? }
POST /checkouts/:id/discount                { kind: amount|percent, ... }
POST /checkouts/:id/tip                     { amountCents, staffId? }
POST /checkouts/:id/payments                { amountCents, method }
POST /checkouts/:id/complete
POST /checkouts/:id/void                    { reason }
POST /payments/:id/waive                    { reason }
```

Several `payments` calls make a split payment; each response says what is still
outstanding. `complete` refuses while money is owed, and returns the **rebook
suggestion** so the barber app can prompt for the next visit at the chair.

## Waitlist

```
POST /locations/:locationId/waitlist        { serviceIds, fromDate, toDate, ... }
POST /waitlist/:id/accept
```

## Reporting and payouts

```
GET  /locations/:locationId/reports/dashboard?date=
GET  /locations/:locationId/reports/summary?from=&to=
POST /staff/:staffId/payouts                { periodStart, periodEnd, persist? }
GET  /payouts/:id
POST /payouts/:id/approve
POST /payouts/:id/paid
```

## Who can do what

Access is checked **per location**: a barber at one shop is not staff at
another. Roles come from `staff.role`.

| Endpoint group | Who |
| --- | --- |
| Shop details, availability, queue join and status | anyone |
| Hold, confirm, own bookings, waitlist | any signed-in user |
| Cancel a booking | the client who owns it, or staff at that location |
| Queue management, seating, checkout, no-show | staff at that location |
| Reports, dashboards | `owner`, `manager` |
| Own earnings preview | the barber themselves, or `owner`/`manager` |
| Recording a payout, approving, marking paid | `owner`, `manager` |

A barber cannot read the shop's takings or a colleague's earnings. "Not staff
here" and "staff without the role" return the same message, so neither reveals
the shop's structure.

## Error codes

| Code | HTTP | Meaning |
| --- | --- | --- |
| `VALIDATION_FAILED` | 400 | The request body or query failed schema validation |
| `NOT_BOOKABLE` | 400 | The request cannot be fulfilled as asked |
| `UNAUTHORIZED` | 401 | No token, or an expired or revoked one |
| `INVALID_CODE` / `EXPIRED` | 401 | OTP verification failed |
| `FORBIDDEN` / `HOLD_NOT_YOURS` | 403 | Authenticated, but not allowed |
| `NOT_FOUND` | 404 | No such record or route |
| `SLOT_TAKEN` | 409 | Someone else got the slot first — refresh and re-offer |
| `HOLD_EXPIRED` | 409 | The hold lapsed before confirmation |
| `INVALID_STATE` | 409 | The record is not in a state that allows this |
| `NO_ELIGIBLE_STAFF` | 422 | No barber can perform these services then |
| `TOO_MANY_ATTEMPTS` / `RATE_LIMITED` | 429 | Slow down |
| `INTERNAL` | 500 | A bug. Details are logged, never returned |

`SLOT_TAKEN` is the expected losing path in a race, not a failure: show
"10:30 was just booked" in place, with the nearest alternatives already loaded,
rather than dropping the user back to the start of the flow.

## Rate limiting

Global default 300/minute, keyed by token where the caller has one and by IP
otherwise — so an office full of people behind one NAT is not throttled as a
single caller. `/auth/otp` is 5 per 15 minutes; `/auth/verify` is 10.

Behind a load balancer, set `TRUST_PROXY=true` so limits see the real client
address. Leave it off otherwise: trusting `X-Forwarded-For` when nothing sets it
lets anyone spoof their address.
