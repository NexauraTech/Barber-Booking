# 1. Market landscape — how barber booking works around the world

Research date: September 2026.

---

## 1.1 Two fundamentally different product archetypes

Almost every product in this space is one of two things, and the difference decides the
entire business model, the data model and who the customer is.

### A. Business tools (SaaS)

The shop is the customer. Software sits behind the shop's own brand: the shop's booking link,
the shop's website widget, the shop's Instagram bio link. The vendor never owns the client
relationship, and never sells the shop's clients to a competitor.

Examples: **SQUIRE**, **Mangomint**, **Vagaro**, **Zenoti**, **GlossGenius**, **Phorest**,
**Setmore**, **Acuity**, **Schedulicity**, **You'reOnTime**, **Barberly**.

Revenue: flat monthly subscription (per-shop or per-chair), plus payment processing margin,
plus hardware and optional marketing add-ons.

### B. Consumer marketplaces

The *client* is the audience. The vendor runs a consumer app where people search
"barber near me", and the shop gets discovery in exchange for a cut of the booking.

Examples: **Booksy**, **Fresha**, **Treatwell** (Europe), **StyleSeat** (US).

Revenue: subscription *plus* commission on marketplace-sourced bookings, plus payments.

### Why this matters for a new product

Marketplaces have a cold-start problem (no clients → no value to shops → no shops → no clients)
and a trust problem (see §1.4). Business tools have no cold-start problem: one shop with one
booking link is already a working product. **Almost every successful marketplace in this space
started as a business tool and added the marketplace later, once it had supply.** That is the
sequencing to copy.

---

## 1.2 Pricing models observed (2026)

| Product | Subscription | Marketplace commission | Notes |
| --- | --- | --- | --- |
| Booksy Biz | ~$1/day (~$29.99/mo), all features in one tier | ~30% of the service price on a new client's first booking ("Boost") | Deliberately simple tiering; no per-feature add-ons |
| Fresha | Free core tier historically; moved to paid subscriptions in 2025 | 20% on new-client marketplace bookings, ~$6 minimum per qualifying booking | Strong POS, inventory, memberships, multi-location |
| SQUIRE | Subscription only, barbershop-specific | None | Flat cost regardless of booking volume; walk-in management, split payments |
| Mangomint | ~$165/mo entry, ~$245/mo typical mid-size team | None | Self-checkout, two-way texting, smart waitlist, Express Booking |
| Zenoti / Phorest | Enterprise/multi-location subscription | None | Chains, franchise reporting, deep marketing automation |

**Reading the table:** commission models are cheap for a solo barber with few new clients and
brutally expensive for a busy multi-chair shop. Thirty marketplace clients a month on $80
tickets is ~$480/mo in commission — roughly 2–3× a flat subscription. Flat pricing is the
easier story to sell into an established shop; commission is the easier story to sell into a
new or empty chair.

---

## 1.3 The feature set everyone converges on

Across every serious platform the core is remarkably consistent:

- Online booking (link, widget, marketplace, Instagram/Google integration)
- Calendar: day/week views, drag-and-drop, per-staff columns
- Client profiles: history, notes, photos, preferences, no-show count
- Automated reminders (SMS / push / email / WhatsApp)
- Deposits and cancellation policies with card-on-file
- POS / checkout: services, retail, tips, split payments, receipts
- Staff management: rosters, commission, payroll reports, permissions
- Reporting: revenue, utilization, rebooking rate, retention, top services
- Marketing: campaigns, reviews, loyalty, gift cards, referrals
- Inventory (mostly salon-driven; barbershops use it lightly for pomades/retail)

Barbershop-specific differentiators that general salon software handles badly:

- **Walk-in queue management** — see §1.5
- **Per-barber pricing tiers** (apprentice / barber / master charge different prices for the
  same service, and take different durations)
- **Split payments and chair rent** — many barbers are independent contractors renting a chair,
  not employees. Payouts, not payroll.
- **Short services, high throughput** — 20–45 min cuts mean 5- or 10-minute slot granularity
  matters far more than in a salon doing 3-hour colours.

---

## 1.4 What barbers actually complain about

From review aggregation across the major platforms:

1. **Commission on clients the shop already owned.** A regular walks in, downloads the
   marketplace app because it's convenient, and the shop is charged a "new client" fee on a
   client they acquired themselves. This is the single loudest grievance.
2. **Payment lock-in.** Payouts held, processing rates raised, or the calendar becoming unusable
   if you don't use the vendor's card processing.
3. **Pricing changes.** Free tiers becoming paid (Fresha, 2025) with short notice.
4. **Support quality and app bugs**, particularly on the business-side apps.
5. **Client data portability** — difficulty exporting the client list when leaving.

**Design implication:** a product that (a) charges flat, (b) never charges for a shop's own
returning clients, (c) allows data export, and (d) doesn't force payment processing, has a
credible wedge against the incumbents. These should be explicit product promises, not defaults
that can silently change.

---

## 1.5 Appointment culture vs walk-in culture

This is the biggest regional variable and most software gets it wrong.

**Appointment-dominant:** US, UK, Western Europe, Australia, urban Gulf. Clients expect to book
ahead; the calendar is the product. No-show policies and deposits are normal and accepted.

**Walk-in-dominant:** South Asia, most of Africa, much of Latin America, Southeast Asia, and
neighbourhood shops everywhere. The client arrives, sees who's waiting, and waits. Booking ahead
feels unnatural; a rigid appointment-only product is simply not adopted.

The bridge that works in walk-in markets is the **virtual queue**:

- Client scans a QR code at the door (or from a poster/Instagram) — no app install, no account
- Picks a service, optionally a barber, joins the queue in the browser
- Sees live position and estimated wait; can leave and come back
- Gets an SMS/WhatsApp/push nudge when their turn approaches
- Barber controls the queue from the barber app; a TV screen in the shop shows the order

Reported effects: waiting rooms empty out (the shop looks available even when fully booked),
and automated call-up notifications cut walk-offs and no-shows substantially versus shouting
names across the room.

**A serious global product must treat "appointment" and "queue entry" as two states of the same
underlying object**, so a walk-in can be promoted into a slot and a booked client can be placed
in the queue when they arrive late.

---

## 1.6 Regional notes

**United States / Canada.** Booksy and Squire dominate barbershops specifically; Vagaro and
GlossGenius are strong with independents; chair-rental contractors are the norm, so per-barber
payouts and 1099-style reporting matter. Tipping at checkout is mandatory table stakes.

**United Kingdom / Ireland.** Fresha and Booksy compete head-on; Treatwell has consumer
reach. Deposits are increasingly normalised post-2020. VAT handling and Sunday/bank-holiday
hours matter.

**Europe (mainland).** Treatwell in the UK/NL/IT/ES/DE; local players hold pockets. GDPR makes
client-data handling, consent for marketing messages, and data export legal requirements, not
features.

**Gulf / MENA.** High-end salons run appointment-first; barbershops run walk-in. WhatsApp is the
dominant communication channel — booking confirmations and reminders over WhatsApp Business API
convert far better than SMS. Arabic/RTL support and Hijri-aware holiday handling are real
requirements. Male/female segregated venues mean a shop may need separate staff visibility rules.

**South Asia (India / Pakistan / Bangladesh).** Two distinct models coexist:
- *At-home services* — **Yes Madam** (1M+ users, India and Pakistan) sends a professional to the
  client. This inverts the scheduling problem: travel time, geo-radius and technician routing
  become part of availability.
- *Salon/parlour discovery* — **Zoylee** (Delhi NCR), EvoGroom, Billu Care and others list local
  salons for appointment booking.
Cash on service is still common, so "pay at shop" must be a first-class payment method, not a
fallback. Phone number is the identity; email is often absent. Low-end Android and patchy data
make bundle size and offline tolerance real constraints.

**Africa / Latin America.** Booking overwhelmingly happens over WhatsApp and Instagram DMs
today. The realistic entry product is not "replace WhatsApp" but "give the barber a link to
paste into WhatsApp" — plus mobile-money payment rails (M-Pesa and similar) rather than cards.

---

## 1.7 Benchmarks worth designing against

| Metric | Observed value | Source context |
| --- | --- | --- |
| Salon/barbershop no-show rate, no reminders | 20–30% | industry reports, 2025–26 |
| Average no-show rate overall | 15–20% | Professional Beauty Association, 2025 |
| No-show rate with deposits on first bookings | 2–5% | vendor-reported |
| Reduction in missed appointments with full deposits | ~29% fewer | vendor-reported |
| Revenue lost to no-shows, average salon | $1,500–$3,000/month | 2026 benchmarks |
| Walk-off reduction with automated queue notifications | 60–80% | queue-system vendors |
| Mobile booking conversion vs desktop | ~62% vs ~45% | 2026 booking UX research |
| Bounce penalty above 3s page load | ~50% higher bounce | mobile booking optimisation studies |

Vendor-published figures are marketing numbers and should be treated as directional, not
precise. The consistent signal across all of them: **reminders + deposits + auto-filling
waitlist is where the money is.**

---

## Sources

- [Best barber software in 2026 — GlossGenius](https://glossgenius.com/blog/barber-software)
- [7 best barber booking software for 2026 — Guideflow](https://www.guideflow.com/blog/barber-booking-software)
- [Booksy vs TrimCheck vs Fresha vs Squire — TheConsciousBarber](https://medium.com/@theconsciousbarber/booksy-vs-trimcheck-vs-fresha-vs-squire-which-booking-app-is-cheaper-2f474e9c633b)
- [Best Barbershop Software 2026 — Zenoti](https://www.zenoti.com/thecheckin/best-barbershop-software-2026)
- [10 Best Barber Booking & Scheduling Apps — Booksy](https://biz.booksy.com/en-us/blog/what-app-do-barbers-choose-the-best-booking-app-for-barbers)
- [Booksy Pricing 2026 — Slotcut](https://slotcut.com/blog/booksy-pricing-2026-what-you-actually-pay)
- [Fresha vs Booksy (2026) — Twizzlo](https://twizzlo.com/articles/fresha-vs-booksy/)
- [Fresha vs Booksy for UK Salons and Barbers — Solovi](https://solovi.co.uk/blog/fresha-vs-booksy-uk)
- [Flat Pricing vs Marketplace Commissions — Ascenta Digital](https://ascentadigital.com/blog/flat-pricing-vs-marketplace-commissions)
- [Walk-in queue management for barbershops — Barberly](https://www.barberly.com/barbershop-walk-in-queue-management)
- [Barbershop Queue Management — ScanQueue](https://scanqueue.com/blog/barbershop-queue-management)
- [Barber Shop Waiting List System — QueueAway](https://www.queueaway.co.uk/blog/barber-shop-waiting-list-system)
- [The 2026 Salon & Barbershop No-Show Report — Bookr Hub](https://www.bookrhub.com/en/no-show-report-2026)
- [No-Show Statistics for Barbershops & Salons — Bookwize](https://bookwizeapp.com/blog/no-show-statistics-barbershops)
- [Salon cancellation policies — Zenoti](https://www.zenoti.com/thecheckin/salon-cancellation-policies)
- [5 Best Salon Appointment Apps in India — EvoGroom](https://evogroom.com/blog/salon-appointment-apps-in-india)
- [Zoylee — salon appointment booking application](https://www.zoylee.com/zoylee-a-salon-appointment-booking-application/)
- [Yes Madam — Salon at Home](https://play.google.com/store/apps/details?id=yesmadamservices.app.com.yesmadamservices&hl=en_IN)
