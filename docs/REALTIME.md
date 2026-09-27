# Realtime

```
ws://host/realtime                       anonymous
ws://host/realtime?token=<bearer>        authenticated
Authorization: Bearer <token>            preferred, where the client can set headers
```

The browser `WebSocket` API cannot set headers, so the token may go in the
query string. That puts it in access logs, so prefer the header where you can.

## The socket is read-only

A client may `subscribe`, `unsubscribe` and `ping`. That is the whole
protocol. There is no way to publish an event or write state over this socket,
because **a booking is a command with a server-decided outcome, not state a
client owns**. The HTTP API is the only write path.

## Connecting needs no account

A walk-in watching their queue position and a client browsing a day's
availability both connect anonymously. A token *widens* what you may subscribe
to; it is not a gate on connecting. A stale or invalid token is treated as
anonymous rather than refused, so browsing keeps working.

## Channels

| Channel | Who may subscribe | Carries |
| --- | --- | --- |
| `shop:{locationId}:availability:{YYYY-MM-DD}` | anyone | which start times were taken or freed |
| `shop:{locationId}:queue` | anyone | positions and wait ranges |
| `shop:{locationId}:day:{YYYY-MM-DD}` | staff at that location | the calendar, with client names |
| `shop:{locationId}:queue:staff` | staff at that location | the queue, with names and numbers |
| `shop:{locationId}:presence` | staff at that location | who is clocked in and what they are doing |
| `staff:{staffId}:day:{YYYY-MM-DD}` | that barber, or an owner/manager | one barber's column |
| `client:{clientId}` | that client | their own bookings and waitlist offers |

A channel name that does not parse exactly is rejected. There are no wildcards
and no prefix matching.

**A client browsing slots should subscribe to the one `(date)` they are looking
at and unsubscribe when they navigate away.** One connection may hold at most
20 channels.

## The privacy rule

**Client PII never reaches a channel a client can join.** The public queue
channel carries positions and wait ranges; names and phone numbers live on the
separate staff channel.

This is not enforced at the call site. An event is published **once** and
*projected* per channel by `projectForChannel`, so a publisher cannot leak a
name onto a public channel by forgetting to strip it — it never chooses the
per-channel payload at all. There is one place redaction happens, and it is
tested on both sides: the public projection must not contain the name, and the
staff projection must.

## Messages

Client to server:

```json
{ "action": "subscribe",   "channel": "shop:<uuid>:queue" }
{ "action": "unsubscribe", "channel": "shop:<uuid>:queue" }
{ "action": "ping" }
```

Server to client:

```json
{ "type": "welcome",      "connectionId": "c1", "authenticated": false, "serverSeq": 0 }
{ "type": "subscribed",   "channel": "..." }
{ "type": "unsubscribed", "channel": "..." }
{ "type": "pong" }
{ "type": "error",        "error": "FORBIDDEN", "channel": "..." }
{ "type": "event",        "channel": "...", "event": { "type": "...", "seq": 42, "at": "..." } }
```

Discriminate on `type`. Note that `subscribed` also carries a `channel`, so
keying off the presence of `channel` alone would conflate an ack with a
delivery — deliveries are `type: "event"`.

Errors: `INVALID_CHANNEL`, `FORBIDDEN`, `TOO_MANY_SUBSCRIPTIONS`,
`MESSAGE_TOO_LARGE`, `BAD_JSON`, `UNKNOWN_ACTION`. An unparseable channel and
an unauthorised one are both reported as a plain refusal, so probing reveals
nothing about what exists.

## Events

| Event | Reaches |
| --- | --- |
| `appointment.created` | shop day, availability (as a delta), barber's day, the client |
| `appointment.cancelled` | same, with `refilled` |
| `appointment.status` | same; `in_progress` / `completed` / `no_show` |
| `availability.changed` | the availability channel only — `{ taken: [...], released: [...] }` |
| `queue.changed` | public queue (redacted) and staff queue (full) |
| `queue.called` | staff queue and the called client |
| `waitlist.offered` / `waitlist.resolved` | the client and staff queue |
| `checkout.completed` | presence and staff queue |
| `staff.presence` | presence |
| `resync` | everywhere relevant — refetch, do not try to patch |

Things the research matrix says are fine on ordinary refresh — shift approvals,
revenue dashboards — are deliberately **not** events. Poll those.

## Detecting missed events

Every event carries a deployment-wide monotonic `seq`. On reconnect, compare
the `serverSeq` in the `welcome` frame against the last `seq` you saw: **a gap
means refetch the authoritative state**, not replay. Realtime is an
optimisation over the HTTP API, never the source of truth.

A `resync` event means the same thing: refetch.

## Optimistic UI

Safe to apply optimistically: dragging an appointment on the barber's
calendar, marking a client in-chair, toggling a break, reordering the queue.
Staff actions on state the staff member controls — a rollback is annoying, not
harmful.

**Never optimistic:** creating a booking, paying, accepting a waitlist offer.
Show a determinate pending state and reconcile on the server's answer. A UI
that says "Booked!" and then retracts it costs more trust than a 600ms spinner
ever cost.

## How it works

Postgres `LISTEN`/`NOTIFY`, not Redis and not a vendor. The reason is
**transactional delivery**: a notification published on the same connection as
a write is held by Postgres until `COMMIT` and *discarded on `ROLLBACK`*. So an
event can only ever describe a write that actually landed — no "booking
created" for a booking that rolled back, and no window where the event beats
the row it describes. Getting that from an external broker needs an outbox and
a relay. It also fans out across every API instance, which an in-process
emitter does not.

The cost is an 8000-byte `NOTIFY` payload ceiling, which is why events carry
deltas. Anything that would exceed it is replaced by a `resync` — a dropped
change is unacceptable, a slightly wasteful refetch is not.

```
write txn ──NOTIFY (held until commit)──► Postgres
                                            │
                          one LISTEN connection per API process
                                            │
                                          Hub ──projection per channel──► sockets
```

The bus reconnects with exponential backoff **and jitter**; without jitter,
every instance that lost the database reconnects in lockstep and stampedes it.

Emitting never breaks a write: every helper in `src/realtime/emit.ts` swallows
its own errors. A failed fan-out is a degraded UI; a booking that fails because
the fan-out did is lost revenue. Set `REALTIME_DEBUG=true` to log them.

## Running without realtime

`buildServer({ realtime: false })` skips the WebSocket route and the LISTEN
connection. HTTP-only tests use this so they hold no extra connection.
