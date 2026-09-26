# 5. Reference architecture and build plan

A concrete recommendation, given the research in documents 1–4. Opinionated on purpose — the
alternatives are noted where the choice is genuinely close.

---

## 5.1 Recommended stack

| Layer | Choice | Why |
| --- | --- | --- |
| Database | **PostgreSQL** | The exclusion-constraint approach in §2.5 is the correctness foundation of the whole product, and it is a Postgres feature. This is not a close call. |
| Backend | **Node/TypeScript API** (NestJS or Fastify) | Shares the domain types with the web and mobile clients. Bookings must go through server-side commands, never direct client writes. |
| Realtime | **Supabase Realtime** or a managed Postgres CDC → WebSocket layer | Postgres changes + broadcast + presence covers the entire matrix in §3.1 without a bespoke publisher. |
| Customer + barber apps | **React Native (Expo)** | One codebase, two apps, native push, over-the-air updates — which matter when shops won't update from the store. |
| Booking web flow | **Next.js**, server-rendered | The QR/walk-in/no-install path in §1.5 and §4.1 must be a fast web page. Also the SEO surface for a future marketplace. |
| Back office | **Next.js** web app | Desktop-primary, shares components with the booking web flow. |
| Payments | **Stripe** (cards, card-on-file, deposits, Connect for barber payouts), plus regional rails: **Razorpay/PayU** (India), **Paystack/Flutterwave** (Africa), **mobile money**, and **cash** as a first-class method | Chair-rent and commission splits mean payouts, not just charges. Cash is the default in several target markets. |
| Messaging | **WhatsApp Business API** + **Twilio** SMS + **FCM/APNs** push | Channel priority per market (§3.6). |
| Jobs / scheduling | Durable queue (BullMQ, or a Postgres-backed queue) | Reminders, hold expiry, waitlist cascades, no-show fee capture. |
| Observability | Structured logs, traces, and booking-funnel analytics from day one | You cannot improve a conversion funnel you can't see. |

**The one architectural rule:** appointments and queue entries are written **only** through
server-side commands that enforce holds, idempotency and policy. Realtime clients *read*
broadly and *write* nothing directly. Row-level security enforces the read scoping.

---

## 5.2 Core data model

```
organisations        id, name, plan, settings
locations            id, org_id, name, address, geo, timezone, currency, settings
opening_hours        id, location_id, weekday, opens_at, closes_at          -- local wall time
closures             id, location_id, date_range, reason

users                id, phone, email?, name, avatar, locale, timezone
staff                id, user_id, location_id, tier, role, commission_terms,
                     accepts_online, accepts_walkins, accepts_any_barber, status
staff_services       staff_id, service_id, duration_override, price_override
shifts               id, staff_id, weekday, starts_at, ends_at,
                     repeat_interval_weeks, effective_from, effective_to
shift_exceptions     id, staff_id, date, starts_at?, ends_at?, kind(off|custom)
breaks               id, staff_id, weekday?, date?, starts_at, ends_at
time_off             id, staff_id, range, status(pending|approved|denied), reason

service_categories   id, location_id, name, sort
services             id, location_id, category_id, name, duration, price,
                     buffer_before, buffer_after, deposit_rule, online_bookable,
                     required_resource_type?, is_addon
resources            id, location_id, type(chair|basin|room), name, capacity

clients              id, org_id, user_id?, name, phone, email?, notes,
                     no_show_count, late_cancel_count, tags[], created_at
client_preferences   client_id, preferred_staff_id, preferred_daypart, interval_weeks

appointments         id, location_id, staff_id, client_id, resource_id?,
                     starts_at, ends_at, buffer_before, buffer_after,
                     span tstzrange GENERATED,                 -- exclusion constraint
                     status(pending|confirmed|in_progress|completed|
                            cancelled|no_show),
                     source(online|walkin|phone|marketplace|recurring),
                     hold_expires_at?, hold_session_id?, idempotency_key,
                     policy_snapshot jsonb, deposit_id?, notes, created_by
appointment_services  appointment_id, service_id, price, duration   -- snapshot at booking
recurring_series     id, template jsonb, rrule, until, staff_id, client_id

queue_entries        id, location_id, client_id?, guest_name, phone,
                     service_ids[], preferred_staff_id?, joined_at,
                     status(waiting|notified|in_chair|served|abandoned|promoted),
                     promoted_appointment_id?
waitlist_entries     id, location_id, client_id, service_ids[], staff_id?,
                     date_range, daypart_window, status, offered_at, expires_at

payments             id, appointment_id?, client_id, amount, currency, method,
                     type(deposit|service|retail|tip|no_show_fee|refund),
                     processor, processor_ref, status
payouts              id, staff_id, period, gross, commission, rent, tips, net

notifications        id, recipient, channel, template, payload, scheduled_for,
                     sent_at, status
audit_log            id, actor_id, entity, entity_id, action, diff, at
```

Snapshot fields (`policy_snapshot`, `appointment_services.price/duration`,
`appointments.buffer_*`) exist so that changing a service or policy tomorrow never rewrites the
meaning of a booking made today. This is easy to add now and painful to retrofit.

---

## 5.3 Key API surface

```
GET  /locations/:id/availability?services=&staff=&from=&to=
       → [{ staffId, start, duration }]        # computed, never stored (§2.1)

POST /appointments/hold
       { locationId, staffId|any, serviceIds[], start, clientRef }
       → { appointmentId, status: 'pending', holdExpiresAt }

POST /appointments/:id/confirm
       Idempotency-Key: <uuid>
       { paymentMethodId?, notes?, acceptedPolicyVersion }
       → { appointment }                        # 409 + fresh slots if the hold lapsed

POST   /appointments/:id/cancel      { reason, by }   # triggers waitlist cascade
POST   /appointments/:id/reschedule  { start, staffId? }
POST   /appointments/:id/status      { status }       # start | complete | no_show

POST /queue           { locationId, serviceIds[], staffId?, name, phone }
GET  /queue/:token    → { position, etaRange, status }     # public, no auth
POST /queue/:id/call  POST /queue/:id/promote

POST /waitlist        { locationId, serviceIds[], staffId?, dateRange, daypart }
POST /waitlist/:id/accept                              # exclusive window, then cascade

POST /checkout        { appointmentId, items[], tip, payments[] }
```

`GET /availability` is the hottest endpoint in the system. Cache per
`(location, staff, date, serviceSet)` for 30–60 seconds; invalidate on any write touching that
`(staff, date)`.

---

## 5.4 Phased build plan

**Phase 1 — the booking core (the only phase that must be perfect)**
Location, staff, services, shifts. The availability engine. The exclusion constraint, holds and
idempotency. A mobile web booking flow reachable from a link. Booking confirmation and
reminders over one channel. Barber app: today view, quick add, appointment status actions.
*Done when a real shop runs a full week on it without touching paper.*

**Phase 2 — the walk-in and no-show economics**
QR queue join, live position and ETA, call-next notifications. Waitlist with automatic
cancellation fill. Deposits, cancellation policy, no-show fees. Layered reminders with one-tap
confirm and reschedule. *This is where the product starts paying for itself (§1.7).*

**Phase 3 — money and the shop**
Checkout and POS, tips, split payments, retail. Commission and chair-rent payouts. Rebook-at-
checkout. Reporting: utilisation, rebook rate, retention, no-show cost. Roster management and
time-off approvals.

**Phase 4 — retention and reach**
Client profiles with photo/formula history, loyalty, gift cards, win-back campaigns, review
requests. Native apps for both audiences. Multi-location. Google Reserve / Instagram booking
integrations.

**Phase 5 — marketplace (only if Phase 1–4 has real supply)**
Consumer discovery, search, ratings. Per §1.1, supply comes first; and per §1.4, never charge a
shop for its own returning client.

---

## 5.5 Things to decide before writing code

1. **Target market first.** Appointment-dominant or walk-in-dominant (§1.5)? It changes the
   default screen of both apps, and the whole onboarding story.
2. **Pricing model.** Flat subscription is the honest differentiator against the incumbents'
   most-hated behaviour, but it is slower revenue early. Commission is easier to sell into an
   empty chair. Pick one and make it a published promise.
3. **Payment processing: required or optional?** Forcing it is the second-loudest complaint in
   competitor reviews; making it optional weakens deposits and no-show fees, which are the
   product's biggest value. A reasonable middle: optional processing, but deposits and no-show
   protection only work if you use it — stated plainly up front.
4. **Independent barbers or shops as the unit of sale?** Chair-rent contractors need their own
   client list, their own payouts, and portability when they move shops. Shops want the client
   list to belong to the shop. This tension is structural; decide it in the data model
   (`clients.org_id` vs `clients.staff_id`) rather than discovering it later.
5. **Messaging spend.** SMS at scale is a real cost line. Decide who pays: absorbed in
   subscription, or metered to the shop with a visible meter.

---

## 5.6 Test cases that catch the expensive bugs

- Two clients confirm the same slot within the same millisecond → exactly one succeeds, the
  other gets a friendly 409 with fresh slots
- A hold expires mid-payment → the slot is genuinely released and re-offered
- A retried request on a flaky network → one appointment, not two
- A 45-minute service on a 15-minute grid → offers 10:00, 10:15, 10:30, not just 10:00/10:45
- Buffers block an adjacent booking, but a cancelled appointment's buffers do not
- A booking spanning a DST transition, in both directions
- A shop in `Asia/Karachi` booked by a client whose phone is in `America/New_York`
- A barber's alternate-week Monday shift, across a month boundary
- Cancellation → the waitlist offer fires, expires unaccepted, and cascades to the next match
- A walk-in promoted into a 25-minute gap before a booked appointment, with buffers respected
- A resource-capacity service when all chairs are occupied by other barbers' clients
- Changing a service's duration → yesterday's completed appointments are unchanged
- A no-show fee charged, then waived → payment state and reporting both stay consistent

---

## Cross-references

- Market context and competitor behaviour: [01-market-landscape.md](01-market-landscape.md)
- Availability, concurrency, queues, no-shows: [02-scheduling-engine.md](02-scheduling-engine.md)
- Realtime events, channels, offline: [03-realtime.md](03-realtime.md)
- Screens and mobile-first rules: [04-apps-and-ux.md](04-apps-and-ux.md)
