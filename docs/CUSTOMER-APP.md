# Customer app

```bash
npm run db:reset          # seed a shop, prints its location id
npm run serve             # API on :3000
npm run app:dev           # app on :5173, proxying to the API
npm run app:build         # production build
npm run app:smoke <id>    # browser checks against a running app
```

Then open `http://localhost:5173/#/s/<locationId>`.

## Web-first, app optional

This is a **web** app, not React Native, and that is deliberate. In walk-in
markets most clients will never install anything
(`docs/research/01-market-landscape.md` §1.5), so the booking flow has to be a
fast mobile web page that could later live inside an app shell. An install
requirement at the QR code kills adoption outright.

## Links

Deep links matter more than navigation — Instagram bio, Google Business
Profile, a WhatsApp message, a QR code at the door — and each lands directly on
the right screen rather than the app's home.

```
#/s/<locationId>          the shop, start of the booking flow
#/s/<locationId>/queue    join the walk-in queue  ← the QR target
#/bookings                my appointments
```

Query strings are tolerated, since links arrive with `utm_*` tags attached.

## The flow

```
Services → Barber → Time → [phone + code] → Confirm → Booked
```

Four decisions. A returning client skips to Time with their usual services and
barber, and a signed-in client skips the phone step entirely.

**Identity is collected at the end.** Browsing the menu, the barbers and the
availability needs no account at all — an auth gate in front of the booking
flow is the biggest single drop-off there is. There is no password field and no
email field anywhere in the flow; `npm run app:smoke` asserts both.

### One caveat worth knowing

`POST /appointments/hold` requires a session, so the phone-and-code step sits
**between** choosing a slot and holding it. The research asks for true guest
booking (name and phone, no account) — the API does not offer that today.

The consequence is a wider window in which someone else can take the chosen
slot, which is why `SLOT_TAKEN` is handled as a first-class in-flow outcome:
the app returns to the grid, names the time that went, keeps the services and
barber, and shows what is still free. It never restarts the flow or shows a
dead-end error.

Closing the gap properly means a rate-limited guest hold on the API. The queue
already joins anonymously and is rate-limited, so the pattern exists.

## Architecture

```
app/customer/src/
  state/flow.ts      the booking flow as a PURE state machine
  state/format.ts    money, time, dates, slot grouping — pure
  api/client.ts      typed fetch wrapper, idempotency, typed 409s
  api/realtime.ts    WebSocket client: reconnect, gap detection
  screens/           Booking.tsx, Queue.tsx
  App.tsx            hash router and shell
```

`state/` imports nothing from `api/` or React, so the flow's rules are testable
without a DOM — the same split `src/domain` uses on the server. Most of the
app's test value lives there.

## Why Preact

The app is authored against the React API but **ships Preact via compat**:
16KB gzipped instead of 77KB. Bundle size is the dominant term in the "under
three seconds to interactive on a mid-range Android" budget, and React was
~60% of the bundle for an app this simple.

The aliases live in `app/customer/vite.config.ts` and are mirrored in
`vitest.config.ts`, so tests exercise what actually ships. They are **anchored
regexes, not object keys** — an object alias matches by prefix in key order, so
a bare `react` entry swallows `react-dom` and produces a nonsense specifier.

Component tests use `@testing-library/preact`, not the React version: the React
one resolves its own copy of `react-dom` through Node, bypassing the bundler
alias and mixing two renderers.

To go back to React, delete the alias blocks from both configs.

## Realtime

On the Time screen the app subscribes to **only** the day being viewed
(`shop:<id>:availability:<date>`) and unsubscribes on leaving. Slots taken by
other people disappear under the user's finger.

Realtime is an optimisation and never the source of truth. Every event carries
a `seq`; a gap, or the server reporting itself ahead after a reconnect, raises
a "you may have missed an update" notice with a refresh rather than an attempt
to patch forward. The queue screen polls every 20 seconds as well as
subscribing, because someone watching their place on a patchy connection must
not be left on a stale number.

## Mobile-first, concretely

Measured by `npm run app:smoke` in a real browser at 375px, not asserted from
class names:

- Touch targets at least 44px, 8px apart
- No horizontal overflow at phone width
- Running price and duration visible from the first screen
- Sticky primary action in the thumb zone
- Skeletons, never an empty grid
- Native inputs: `type="tel"`, `autocomplete="one-time-code"`, `inputmode`
- Dark mode, safe-area insets, `prefers-reduced-motion`
- RTL via logical properties (`inset-inline`, `text-align: start`)
- Pinch-zoom left enabled — no `maximum-scale`

## Not built

- Booking for family members from one account
- Photo and formula history
- Rescheduling from the app (cancel and rebook works)
- Deposit payment — the API records deposits but charges nothing
- Push notifications; reminders go out over SMS/WhatsApp from the server
- Offline reading of a confirmed booking (the research asks for it; the app
  currently needs the network to show an appointment)
