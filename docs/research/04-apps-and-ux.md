# 4. The three apps — customer, barber, shop manager

Three audiences, three very different jobs. Shipping one app with a role switch is tempting and
almost always produces a product that serves neither side well.

---

## 4.1 Customer app

### The critical path

```
Open → Shop → Service → Barber → Time → Confirm → (Deposit) → Done
                                                       ↓
                                      Reminders → Arrive → Check in → Pay → Rebook
```

Target: **four taps from open to booked for a returning client**, because the app already knows
their usual barber, usual service, and preferred time of day. "Book my usual" is one tap.

### Screens

1. **Home.** Upcoming appointment card at the top (time, barber, address, directions, cancel /
   reschedule). Below: "Book again" with last service pre-filled, favourite shops, nearby shops.
2. **Shop profile.** Photos, barber roster with portfolios and ratings, service menu with prices
   and durations, opening hours, live "queue: ~20 min wait" indicator, address/map, reviews.
3. **Service selection.** Grouped by category, add-ons attachable (beard trim + hot towel), with
   running total of price and duration visible at all times.
4. **Barber selection.** Photos, tier and price difference shown clearly, "Any barber —
   earliest availability" always as a prominent first option.
5. **Time selection.** Horizontal date strip, slots grouped Morning / Afternoon / Evening.
   Never show an empty grid — if a day is full, show the next three days that aren't, inline.
6. **Confirm.** Summary, policy text with deposit amount, notes field, then phone-OTP auth
   *only now* if the user isn't signed in.
7. **Confirmation.** Add to calendar, share, directions, cancel/reschedule, and the policy
   restated.
8. **Queue join.** Reachable by QR code without any install: service → optional barber → join →
   live position and ETA, with a "leave queue" escape hatch.
9. **History.** Past cuts with photos and the barber's notes ("2 on the sides, scissor on top"),
   receipts, one-tap rebook.
10. **Profile.** Saved cards, notification channel preferences, favourite shops, family member
    profiles (booking for kids is extremely common and badly handled by most apps).

### Non-negotiable UX rules

- **No forced signup before browsing.** Collect identity at confirm, via phone OTP. Email-plus-
  password signup as a gate is the biggest single drop-off in this category.
- **Guest booking must work** — name and phone number, nothing else.
- **4–6 form fields maximum** across the entire flow.
- **44px minimum touch targets**, primary actions in the bottom thumb zone, sticky CTA.
- **Under 3 seconds to interactive** on a mid-range Android. Beyond that, bounce roughly
  doubles.
- **Inline validation**, and never reset the form on an error.
- **Prices and durations always visible.** Surprise at checkout is the top complaint in app
  reviews for this category.
- **Deep links everywhere**: Instagram bio, Google Business Profile, WhatsApp message, QR code
  at the door — each landing directly on the shop's booking screen, not the app's home.
- **Web-first, app optional.** In walk-in markets most clients will never install anything. The
  booking flow must be a fast mobile web page that happens to also live inside an app shell.

---

## 4.2 Barber app

Used standing up, one-handed, between clients, sometimes with wet hands. Optimise for glance
and tap, not for density.

### Screens

1. **Today.** The default and most-used screen. A vertical timeline of the day: current client
   highlighted with elapsed time, next client, gaps shown explicitly as bookable, queue count
   badge. Pull to refresh; realtime updates land without a refresh.
2. **Calendar.** Day and week views, per-barber columns for whoever has permission, drag-and-drop
   reschedule with a confirmation step, long-press to block time.
3. **Appointment detail.** Client photo, history, notes, formula/clipper guard preferences,
   no-show count, contact buttons (call / WhatsApp), status actions: confirm, start, complete,
   no-show, reschedule, cancel.
4. **Quick add.** Add a walk-in or a phone booking in under 10 seconds: service, name, phone,
   now-or-next-gap. This is used dozens of times a day; it deserves a persistent FAB.
5. **Queue.** Ordered list with drag-to-reorder, "call next" (fires the notification),
   promote-to-appointment, mark abandoned.
6. **Checkout.** Services, add-ons, retail, discount, tip prompt, split payment, cash or card,
   receipt by SMS/WhatsApp — and, immediately after payment, **"Book next visit?"** with the
   client's usual interval pre-selected. Rebooking at checkout is the highest-ROI habit in the
   whole business; the software should make skipping it feel like the unusual choice.
7. **My schedule.** Shifts, request time off, set breaks, clock in/out.
8. **Earnings.** Today / week / month, commission or chair-rent split, tips, services vs retail,
   and the metrics that change behaviour: rebook rate, retention, average ticket, chair
   utilisation.
9. **Clients.** Search, profiles, notes and photo history, message.

### Details that earn loyalty

- Working offline for today's schedule (§3.5)
- Before/after photos attached to the appointment, which double as portfolio content
- A running "you're 12 minutes behind" indicator, with one tap to notify affected clients
- Marking a no-show triggers the fee flow automatically, with an obvious waive button
- A daily end-of-day summary push: what you earned, who's booked tomorrow

---

## 4.3 Shop manager / back office

Tablet and desktop first — this is the only surface where desktop is genuinely primary, because
rosters, reporting and payroll are wide-table work.

- **Dashboard:** today's bookings, expected revenue, chair utilisation, queue length, no-show
  count, staff clocked in.
- **Calendar:** all barbers side by side, drag between barbers, bulk actions.
- **Staff:** profiles, tiers, services each can perform with per-barber durations and prices,
  commission/rent terms, permissions, shift rostering with rotation patterns, time-off approvals.
- **Services:** catalogue, categories, durations, buffers, deposit rules, resources required,
  online-bookable flags, add-on relationships.
- **Clients:** search, merge duplicates (endemic — same person books as "Mike" and "Michael"),
  segments, export.
- **Reporting:** revenue by barber/service/day-part, utilisation, rebook rate, new vs returning
  client mix, retention cohorts, no-show cost, waitlist fill rate, average ticket, retail
  attachment rate.
- **Marketing:** campaigns to segments, automated win-back ("haven't seen you in 8 weeks"),
  review requests after checkout, loyalty points, gift cards, referrals.
- **Settings:** hours, closures, policies, deposits, slot step, lead time, horizon, payment
  configuration, tax, notification templates and channels, branding, locations.
- **Multi-location:** location switcher, cross-location reporting, staff working across
  locations, per-location hours and pricing.
- **Roles and permissions:** owner, manager, front desk, barber, apprentice — with a sharp line
  around who can see revenue, other barbers' earnings, and client contact details.

---

## 4.4 Mobile-first, concretely

"Mobile-first" as a checklist rather than a slogan:

- Design at 375px width first; the desktop layout is the adaptation, not the origin
- Bottom navigation, 3–5 primary items, icons *and* labels
- Primary actions in the bottom third of the screen (thumb zone)
- 44px minimum touch targets, 8px minimum spacing between them
- Sticky primary CTA that never scrolls out of view during booking
- Native inputs: `type="tel"` for phone, native date/time pickers, `autocomplete` attributes
- One decision per screen in the booking flow — resist combining service + barber + time
- Skeleton screens rather than spinners; the slot grid should never flash empty
- Every async action has three visible states: idle, pending, result
- Support RTL from day one if the Gulf or MENA is in scope — retrofitting it is expensive
- Respect the safe area, dynamic type, and dark mode
- Test on a low-end Android over a throttled connection as part of CI, not as an afterthought

---

## Sources

- [Booking UX Best Practices to Boost Conversions — RaLabs](https://ralabs.org/blog/booking-ux-best-practices/)
- [Mobile Booking: Why It's Essential in 2026 — Reservio](https://www.reservio.com/blog/tips/mobile-first-booking)
- [Mobile Navigation UX Best Practices, Patterns & Examples — DesignStudio](https://www.designstudiouiux.com/blog/mobile-navigation-ux/)
- [4 best practices for salon and spa online booking that converts — Zenoti](https://www.zenoti.com/blogs/4-best-practices-for-online-booking-that-converts)
- [Mobile Booking Optimization — Shamrok](https://www.shamrok.com/blog/mobile-booking-optimization-appointment-conversion)
- [Walk-In Barbershop Software — You'reOnTime](https://youreontime.com/barber-shop-software)
- [How to Set Up a Digital Queue At Your Barbershop — WaitQ](https://waitq.app/blog/set-up-digital-queue-barbershop)
