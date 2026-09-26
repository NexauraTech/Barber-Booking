# 2. The scheduling engine

This is the part that decides whether the product works. Everything else — UI, payments,
marketing — is comparatively ordinary software. Get this wrong and no amount of polish saves it.

---

## 2.1 The golden rule: availability is computed, never stored

The most common design mistake is creating a `slots` table with rows like
`(barber_id, 10:00, available)` and flipping a boolean when someone books.

It breaks immediately:

- A 45-minute service booked at 10:00 must invalidate the 10:15 and 10:30 slots too — now you
  are hand-maintaining overlap logic across rows
- Changing shop hours, a barber's shift, or a service duration requires regenerating rows
- Rows must be generated forward forever (or a cron job does it, and then breaks)
- Two services of different lengths need two different slot grids for the same barber

**Correct model:** store only *facts* — shifts, time off, services, bookings, resources — and
compute free slots on demand for a given `(shop, barber|any, service[], date)`.

Compute is cheap: a single barber's day is at most a few hundred candidate start times.
Cache the result in memory for 30–60 seconds, and invalidate on any booking write for that
`(barber, date)`.

---

## 2.2 The inputs to availability

A slot is bookable only if **every** one of these agrees:

| Input | Example |
| --- | --- |
| Shop opening hours | Mon–Sat 09:00–20:00, Sun closed |
| Shop closures | public holidays, refurbishment week |
| Barber's working shift | Tue/Thu/Sat 10:00–18:00, alternate Mondays |
| Barber's breaks | 13:00–13:30 lunch, recurring |
| Barber's time off | approved leave, sick day, personal block |
| Service duration | beard trim 20m, skin fade 45m, cut+beard 60m |
| Duration override per barber | master barber does a fade in 35m, apprentice in 55m |
| Buffer before / after | 5m cleanup between clients |
| Existing bookings | including their buffers |
| Resource capacity | 4 chairs, 1 wash basin, 1 private room |
| Slot granularity (step) | every 15m, or every 5m for tight packing |
| Minimum lead time | no bookings starting within the next 2 hours |
| Maximum horizon | can't book more than 60 days out |
| Per-barber booking rules | "appointments only", "walk-ins only", "online booking off" |
| Timezone / DST | shop-local time, stored UTC |

Anything a shop can configure must appear in this list, or it will be wrong for someone.

---

## 2.3 Slot generation algorithm

```
function availableSlots(shopId, barberIds, serviceIds, date, tz):
    duration = sum(service.durationFor(barber) for service in serviceIds)
    bufferBefore, bufferAfter = maxBuffers(serviceIds)
    step   = shop.slotStep                      # 5 / 10 / 15 minutes
    now    = clock.now()
    result = []

    for barber in barberIds:
        # 1. Base windows the barber is actually working, in shop-local time
        windows = intersect(
            shop.openingHours(date),            # minus shop closures
            barber.shift(date)                  # minus breaks and approved time off
        )
        if barber.onlineBookingDisabled: continue

        # 2. Everything already occupying the barber, expanded by its buffers
        busy = barber.bookings(date).map(b => expand(b, b.bufferBefore, b.bufferAfter))
             + barber.manualBlocks(date)

        # 3. Walk every candidate start time on the grid
        for window in windows:
            t = ceilToStep(window.start, step)
            while t + duration <= window.end:
                candidate = [t - bufferBefore, t + duration + bufferAfter]

                if not overlapsAny(candidate, busy)
                   and t >= now + shop.minLeadTime
                   and date <= now + shop.maxHorizon
                   and resourcesFree(shopId, serviceIds, t, duration):
                    result.push({barber, start: t, duration})

                t += step

    return dedupeAndSort(result)
```

Notes that matter in practice:

- **`step` is independent of `duration`.** A 45-minute cut on a 15-minute grid offers
  10:00, 10:15, 10:30… not only 10:00 and 10:45. This roughly triples perceived availability.
- **Buffers belong to the booking, not the slot.** Store `buffer_before`/`buffer_after` on the
  appointment row so historical bookings stay correct when a service's config later changes.
- **Multi-service bookings** sum durations and are booked as one contiguous block with one
  cancellation policy, not as N separate appointments.
- **"Any barber"** runs the loop for every eligible barber and merges by start time, tagging
  which barbers are free. Assign the actual barber at confirmation time, choosing the one whose
  day it fragments least (see §2.4).

### Resource capacity

Chairs, basins and rooms are shared, countable resources. A service declares what it needs; a
candidate is valid only if, at every minute of its span, the count of overlapping bookings
requiring that resource is below capacity. Implement it as a sweep over the day's interval
endpoints, not per-minute iteration.

---

## 2.4 Gap minimisation ("smart slots")

Naive slot offering fragments a barber's day: a 45-minute booking dropped at 10:15 leaves an
unsellable 15-minute hole at 10:00.

Two mitigations, both optional per shop:

1. **Edge-preferred ordering.** Rank offered times so slots adjacent to an existing booking or
   to the start/end of a shift appear first. Clients tend to take the first reasonable option.
2. **Hole suppression.** Hide a candidate start if it would create a residual gap smaller than
   the shop's shortest bookable service, *provided* an alternative start in the same window
   remains available. Never suppress the only remaining option.

For "any barber", assign to the barber for whom the booking creates the least new dead time,
then break ties by lowest utilisation that day (fairness between staff).

---

## 2.5 Preventing double booking

Application-level "check then insert" is a race condition. Two requests read the same
availability, both see the slot free, both insert.

### Layer 1 — database constraint (non-negotiable)

PostgreSQL makes overlap physically impossible:

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE appointments
  ADD COLUMN span tstzrange
    GENERATED ALWAYS AS (
      tstzrange(starts_at - buffer_before, ends_at + buffer_after, '[)')
    ) STORED;

ALTER TABLE appointments
  ADD CONSTRAINT no_overlap_per_barber
  EXCLUDE USING gist (
    barber_id WITH =,
    span      WITH &&
  ) WHERE (status IN ('pending', 'confirmed', 'in_progress'));
```

The `WHERE` clause is important: cancelled and no-show appointments must not block the slot.
A violation surfaces as a specific SQL error — catch it and return "that time was just taken"
with a refreshed slot list, rather than a 500.

For deliberate double-booking (a shop that wants two chairs per barber, or overlapping
processing time), make the constraint `(barber_id, chair_id)` or drop to an advisory-lock
approach with an explicit capacity check.

### Layer 2 — short-lived holds

Users abandon mid-checkout. Holding a database lock across a payment flow is unacceptable;
holding *nothing* means a user completes a card form only to fail at the end.

Create the appointment as `status = 'pending'` with `hold_expires_at = now() + 7 minutes` and a
`hold_session_id`. Pending rows participate in the exclusion constraint, so the slot is
genuinely reserved. A sweeper (or a partial index scan on write) expires stale holds. On
confirmation, verify the hold still belongs to this session before promoting to `confirmed`.

### Layer 3 — idempotency

Mobile networks retry. Every booking request carries a client-generated `Idempotency-Key`;
store it with a unique constraint and return the original result on replay. Without this,
one tap on a flaky connection becomes two appointments.

### What about optimistic UI?

The client may *show* the slot as taken immediately, but booking is a **command**, not a write
the client owns. The server's answer is the truth; the UI reconciles when it arrives. Never let
a client write an appointment row directly (this is an argument against unguarded
direct-to-database mobile SDK access for this specific table).

---

## 2.6 Time, timezones and DST

- Store every instant as `timestamptz` (UTC). Store the shop's IANA timezone
  (`Europe/London`, `Asia/Karachi`) on the shop row.
- Store *recurring* things — opening hours, shifts, breaks — as **local wall-clock time plus
  weekday**, never as UTC offsets. "Opens at 09:00" must stay 09:00 across a DST change.
- Expand recurrence to concrete instants in the shop's timezone at query time.
- DST edge cases to test explicitly: a shift spanning the spring-forward gap (02:00–03:00 does
  not exist) and the autumn fall-back repeat (02:00–03:00 happens twice).
- Display in the *shop's* timezone by default, and label it when the client's device timezone
  differs — a traveller booking from another country must not see shifted times.

---

## 2.7 Walk-ins and the queue

Model a queue entry and an appointment as the same underlying object with different states.

```
QueueEntry {
  id, shop_id, client_id?, guest_name?, phone
  service_ids[], preferred_barber_id?   # null = any
  joined_at, position                   # position derived, not stored authoritatively
  estimated_start, estimated_wait
  status: waiting | notified | in_chair | served | abandoned | promoted
  promoted_appointment_id?
}
```

**Wait-time estimation.** Naive `position × average service time` is poor. Better:
for each waiting party ahead, sum their service duration, divide by the number of barbers
eligible to serve them, and add the remaining time of each barber's current client
(actual elapsed vs. expected). Re-estimate on every state change and push to clients.
Always present it as a range ("~25–35 min"), never a precise number.

**Appointments vs queue.** Booked appointments hold priority at their start time; the queue
fills the gaps between them. When the next appointment is 40 minutes out and a walk-in needs
20 minutes, the walk-in is safely promotable — this "fits-in-the-gap" check is exactly the
`availableSlots` function with `now` as the start.

**Notifications.** Nudge at N-ahead (configurable, typically 2) and again when it's their turn.
SMS/WhatsApp, because the client has left the shop and probably has no app installed.

---

## 2.8 No-shows, deposits and the waitlist

The economics from §1.7 say this subsystem pays for the whole product.

**Layered reminders.** 48h (still cancellable for free), 24h (last free window), and 2h
(pure nudge). Every reminder carries a one-tap confirm and a one-tap reschedule link —
a cancellation 24 hours out is a *rebookable* slot, a no-show is lost revenue.

**Deposits.** Configurable per shop, per service, and per client segment. The high-leverage
default: require a deposit from first-time clients and clients with a no-show history, not from
trusted regulars. Implementation is card-on-file authorisation or an upfront partial charge,
with the no-show fee charged automatically after a grace period, and a manual "waive" always
available to the barber (relationships matter more than $15).

**Cancellation policy.** Standard shape is free cancellation up to 24–48h, then a percentage
(commonly 50%) of the service price for late cancellation, 100% for a no-show. The policy text
must be shown and accepted at booking, and stored *with the appointment* — changing the shop
policy tomorrow must not retroactively alter today's bookings.

**Auto-filling waitlist.** When a booking is cancelled, the slot is immediately offered to
waitlisted clients whose preferences match (barber, service, date range, time-of-day window).
Offer to the best match with a short exclusive window (10–15 min), then cascade. This turns
cancellations into revenue instead of holes, and is the single most-praised feature in
competitor reviews.

**Reputation.** Track per-client no-show and late-cancellation counts and surface them to the
barber at booking time. Use them to auto-escalate deposit requirements. Do not expose them to
other shops (that becomes a scoring system with fairness and legal problems).

---

## 2.9 Custom scheduling — what shops must be able to configure

Everything below is per-shop, with per-barber override where marked (†):

- Opening hours per weekday, plus dated exceptions and holiday closures
- Slot step: 5 / 10 / 15 / 20 / 30 minutes
- Minimum lead time, maximum booking horizon
- Service catalogue: name, category, duration†, price†, buffer before/after, required resources,
  deposit rule, online-bookable flag, add-on eligibility
- Barber tiers with tier pricing (apprentice / barber / master)
- Shifts: recurring patterns including alternate-week rotation (e.g. Monday every 2 weeks,
  other days weekly, off-weeks explicitly marked), plus one-off shift edits
- Breaks: recurring and ad-hoc
- Time-off requests with an approval flow
- Per-barber toggles: accepts online booking, accepts walk-ins, accepts "any barber" routing,
  max bookings per day
- Recurring / standing appointments ("every 3rd Friday at 5pm with Sam"), generated as a series
  with individual instances editable and a sensible far-horizon cap
- Group bookings (father + two sons, one payer, sequential or parallel across barbers)
- Blackout dates and shop-wide events
- For mobile/at-home barbers: service radius, travel-time buffer derived from distance, and a
  per-booking address

---

## Sources

- [I Solved Double-Booking Without Locks — Using One PostgreSQL Constraint (DEV)](https://dev.to/akincskn/i-solved-double-booking-without-locks-using-one-postgresql-constraint-209m)
- [How to Prevent Double Booking Under Concurrent Reservation Requests — Clixo](https://clixo.sh/blog/prevent-double-booking-concurrent-reservation-requests)
- [System Design: Healthcare Appointment Booking System — techinterview](https://www.techinterview.org/post/3233462790/system-design-appointment-booking-system/)
- [Salon Scheduling Software: Top Features to Look For — Zenoti](https://www.zenoti.com/thecheckin/salon-scheduling-software-guide)
- [Salon Staff Rostering Software — Zenoti](https://www.zenoti.com/salon-management-software/staff-scheduling)
- [Booking and Scheduling Software for Salons — Mindbody](https://www.mindbodyonline.com/business/education/blog/booking-scheduling-salon)
- [Barbershop Waitlist — Barberly](https://www.barberly.com/barbershop-waitlist)
- [How to Reduce Salon No-Shows — Bookeo](https://www.bookeo.com/news/2026/02/reduce-salon-no-shows-proven-strategies-actually-work/)
- [Salon Deposit Policy Template 2026 — SICUS](https://www.sicusmedia.com/blog/salon-deposit-policy-template.html)
