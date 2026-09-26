# 3. Realtime

"Realtime" is often specified as a vibe. It needs to be specified as a list of events, an
audience for each, and a latency budget.

---

## 3.1 What actually needs to be realtime

| Event | Who must see it | Budget | Mechanism |
| --- | --- | --- | --- |
| New booking created | every staff member in the shop, back office | < 1s | WebSocket push |
| Booking cancelled / rescheduled / no-showed | shop staff; the affected client | < 1s | push + notification |
| Slot taken while a client is mid-booking | that client only | < 2s | subscription on the day being viewed |
| Walk-in joins / leaves the queue | shop staff, lobby screen, everyone in that queue | < 1s | broadcast on queue channel |
| Queue position / ETA changes | each waiting client | < 2s | broadcast on queue channel |
| "You're next" call-up | one client | immediate | push + SMS/WhatsApp fallback |
| Barber starts / finishes a client | shop staff, lobby screen | < 1s | broadcast |
| Barber clocks in / out, goes on break | shop staff | < 2s | presence + DB change |
| Checkout completed, payment received | barber + front desk | < 2s | push |
| Waitlist offer sent / accepted / expired | offered client + staff | < 2s | push + notification |
| Shift or time-off approved | affected barber | minutes | ordinary refresh is fine |
| Revenue dashboards | owner | minutes | polling is fine |

Two conclusions: the realtime surface is **smaller than it first appears**, and it is almost
entirely scoped to *one shop on one day*. Design channels around that.

---

## 3.2 Channel design

Subscribing every client to a whole table is the classic cost and privacy mistake. Scope
narrowly:

```
shop:{shopId}:day:{YYYY-MM-DD}     # calendar changes — staff only
shop:{shopId}:queue                # walk-in queue — staff + lobby screen + waiting clients
barber:{barberId}:day:{YYYY-MM-DD} # a single barber's column
client:{clientId}                  # this client's own appointments + waitlist offers
shop:{shopId}:presence             # who is clocked in, who is with a client
```

Rules:

- **A customer browsing slots subscribes only to the specific `(barber|any, date)` they are
  looking at**, and unsubscribes when they navigate away. Availability deltas arrive as
  "these start times are gone", not as raw table rows.
- **Never broadcast client PII on a channel a client can join.** The queue channel a waiting
  customer subscribes to carries positions and ETAs, not names and phone numbers. Staff get a
  separate, authorised channel with full detail. Enforce this server-side — row-level security
  or an authorising server, not client-side filtering.
- **Authorise every subscription.** Channel membership must be checked against the user's role
  and shop membership at connect time, and re-checked on token refresh.

---

## 3.3 Transport options

| Approach | Fit |
| --- | --- |
| **Postgres change streams** (Supabase Realtime, logical decoding → WAL → JSON → WebSocket) | Excellent default. Changes to `appointments`/`queue_entries` fan out automatically; no custom publisher to keep in sync with writes. Needs row-level security to be airtight. |
| **Explicit broadcast** from the API after a successful write | Better for derived events (recomputed ETAs, "slots X/Y/Z now gone") that aren't a single row change. Use alongside change streams, not instead. |
| **Presence** | Purpose-built for "who is online / clocked in / viewing this calendar". Ephemeral, no DB writes. |
| **Raw WebSocket / Socket.IO service** | Full control, more ops burden. Justified only at large scale or with unusual routing needs. |
| **SSE** | One-directional and simple; fine for the lobby TV screen and for a public queue page. |
| **Polling** | Perfectly adequate for dashboards and reports. Don't over-engineer these. |

A practical hybrid: Postgres change streams for appointment/queue row changes, explicit
broadcast for recomputed ETAs and availability deltas, presence for staff status, and plain
polling for everything in the reporting layer.

**Always pair realtime with push notifications.** Apps get backgrounded and killed. FCM/APNs
delivers the "you're next" and "your slot was released" messages when the socket is gone, with
SMS/WhatsApp as the final fallback for clients who never installed an app (the majority, in a
QR-code walk-in flow).

---

## 3.4 Optimistic UI, correctly

Optimistic updates make the app feel instant, but bookings are money. The split:

**Optimistic is fine for:** dragging an appointment on the barber's calendar, marking a client
in-chair, toggling a break, reordering the queue, editing a client note. These are staff actions
on state the staff member controls; a rollback is annoying but harmless.

**Never optimistic for:** creating a booking, paying, and accepting a waitlist offer. These are
commands with a server-decided outcome. Show a determinate pending state — "Holding your
slot…" — and reconcile on the server's answer. A UI that says "Booked!" and then retracts it
destroys trust faster than a 600ms spinner ever cost.

**Conflict handling.** When a client's chosen slot is taken between page load and confirm,
don't dump them back to the start: show "10:30 was just booked" *in place*, with the nearest
alternatives already loaded and the rest of the form intact.

---

## 3.5 Offline and poor networks

Non-negotiable in the markets described in §1.6 — low-end Android, patchy data, a barber
standing in a basement shop.

- **Barber app:** today's schedule must be readable offline. Cache the day locally and show a
  clear "last synced at 14:32" marker. Queue mutations (check-in, mark complete, start client)
  in a durable local outbox, replay on reconnect with idempotency keys, and surface conflicts
  for manual resolution rather than silently dropping them.
- **Customer app:** upcoming appointments and confirmation details must be visible offline —
  the client needs the address and time while on the way. Never require a network round trip to
  read a confirmed booking.
- **Reconnection:** exponential backoff with jitter; on resume, re-fetch the authoritative day
  rather than trusting a replayed event stream. Assume missed messages.
- **Budget:** target first meaningful paint under 3 seconds on a mid-range Android over 3G.
  The booking flow above all — that's where the bounce penalty lands.

---

## 3.6 Notification matrix

| Trigger | Client | Barber | Owner |
| --- | --- | --- | --- |
| Booking confirmed | push + SMS/WhatsApp + calendar invite | push | — |
| Reminder 48h / 24h / 2h | push, SMS/WhatsApp fallback | 24h digest | — |
| Client cancels | confirmation | push | — |
| Barber cancels / shop closes | push + SMS (high priority) | — | push |
| Waitlist slot offered | push + SMS, expires in 10–15 min | — | — |
| Queue: 2 ahead → your turn | push + SMS/WhatsApp | — | — |
| No-show recorded, fee charged | receipt + explanation | — | daily summary |
| Payment received | receipt | push | — |
| Daily summary | — | end-of-day earnings | revenue + utilisation |

Channel selection should be per-market: WhatsApp-first in MENA, South Asia, LatAm and much of
Africa; SMS-first in the US/UK; push where the app is installed, always with a fallback. SMS
costs real money at scale — prefer push when a valid device token exists, and let shops see
their messaging spend.

Respect quiet hours, per-client channel preferences, and consent (GDPR/TCPA). Transactional
messages (your booking is confirmed) and marketing messages (20% off Tuesdays) need separate
consent and separate opt-outs.

---

## Sources

- [Supabase Realtime — architecture](https://supabase.com/docs/guides/realtime/architecture)
- [supabase/realtime — Broadcast, Presence, and Postgres Changes via WebSockets](https://github.com/supabase/realtime)
- [Implementing Realtime Features in Supabase Using Websockets — Chat2DB](https://chat2db.ai/resources/blog/implementing-realtime-features-in-supabase-using-websockets)
- [Real-Time Data Sync Architectures Guide 2026 — ZTABS](https://ztabs.co/blog/real-time-data-sync-architectures)
- [Building Ultra-Fast Booking Sites with Next.js 15 and Supabase — DEV](https://dev.to/caze/building-ultra-fast-booking-business-sites-with-nextjs-15-and-supabase-adria-case-study-1lh3)
- [Queue Management System for Barbershops — QueueAway](https://www.queueaway.co.uk/queue-management-system-for-barbershops)
- [Virtual Queue & Waitlist for Walk-in Businesses — ScanQueue](https://scanqueue.com/solutions/barbershops)
