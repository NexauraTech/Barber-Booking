/**
 * The booking flow screens.
 *
 * One decision per screen, per docs/research/04-apps-and-ux.md §4.4. The
 * running price and duration stay visible in the sticky bar at every step,
 * because surprise at checkout is the top complaint in this category.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Availability, BookingApi, Shop } from '../api/client.js';
import { ApiError, newIdempotencyKey } from '../api/client.js';
import {
  type FlowAction,
  type FlowState,
  canAdvance,
  selectionTotals,
} from '../state/flow.js';
import {
  addDays,
  applySlotDelta,
  formatCountdown,
  formatDate,
  formatDuration,
  formatMoney,
  formatTime,
  groupByDaypart,
  isoDateIn,
  timezoneDiffers,
} from '../state/format.js';
import type { RealtimeClient } from '../api/realtime.js';
import { channels } from '../api/realtime.js';

interface Props {
  shop: Shop;
  api: BookingApi;
  realtime: RealtimeClient | null;
  state: FlowState;
  dispatch: (action: FlowAction) => void;
}

/** The sticky bar: running total on the left, the one primary action on the right. */
function CtaBar({
  shop,
  state,
  label,
  onPress,
  busy,
}: Props & { label: string; onPress: () => void; busy?: boolean }) {
  const totals = selectionTotals(state.serviceIds, shop.services);

  return (
    <div className="cta-bar">
      <div>
        <div className="cta-summary">
          {totals.priceCents > 0 ? (
            <>
              <strong>{formatMoney(totals.priceCents, shop.currency)}</strong>
              {formatDuration(totals.durationMinutes)}
            </>
          ) : (
            <span>Choose a service</span>
          )}
        </div>
        <button
          className="btn"
          onClick={onPress}
          disabled={busy || !canAdvance(state)}
          aria-busy={busy || undefined}
        >
          {busy ? 'Working…' : label}
        </button>
      </div>
    </div>
  );
}

export function ServicesScreen(props: Props) {
  const { shop, state, dispatch } = props;
  const main = shop.services.filter((s) => !s.isAddon);
  const addons = shop.services.filter((s) => s.isAddon);

  const renderService = (service: Shop['services'][number]) => {
    const selected = state.serviceIds.includes(service.serviceId);
    return (
      <button
        key={service.serviceId}
        className="row"
        aria-pressed={selected}
        onClick={() => dispatch({ type: 'toggleService', serviceId: service.serviceId })}
      >
        <span>
          <span className="name">{service.name}</span>
          <br />
          <span className="meta">{formatDuration(service.durationMinutes)}</span>
        </span>
        <span className="price">
          {formatMoney(service.priceCents, shop.currency)}
          {selected ? <span className="check"> ✓</span> : null}
        </span>
      </button>
    );
  };

  return (
    <>
      <main>
        <h2>Services</h2>
        <div>{main.map(renderService)}</div>

        {addons.length > 0 ? (
          <>
            <h2>Add-ons</h2>
            <div>{addons.map(renderService)}</div>
          </>
        ) : null}
      </main>

      {/* Advance to the barber screen; the barber is chosen there, not here. */}
      <CtaBar {...props} label="Next" onPress={() => dispatch({ type: 'next' })} />
    </>
  );
}

export function BarberScreen(props: Props) {
  const { shop, state, dispatch } = props;

  return (
    <>
      <main>
        <h2>Who with?</h2>

        {/* "Any barber" first and prominent: it is the fastest path to a slot,
            and hiding it pushes people into needlessly narrow availability. */}
        <button
          className="row"
          aria-pressed={state.staffId === null}
          onClick={() => dispatch({ type: 'chooseBarber', staffId: null })}
        >
          <span>
            <span className="name">Any barber</span>
            <br />
            <span className="meta">Earliest availability</span>
          </span>
          {state.staffId === null ? <span className="check">✓</span> : null}
        </button>

        <div>
          {shop.staff.map((barber) => (
            <button
              key={barber.staffId}
              className="row"
              aria-pressed={state.staffId === barber.staffId}
              onClick={() => dispatch({ type: 'chooseBarber', staffId: barber.staffId })}
            >
              <span>
                <span className="name">{barber.name}</span>
                {barber.tier ? (
                  <>
                    <br />
                    <span className="meta">{barber.tier}</span>
                  </>
                ) : null}
              </span>
              {state.staffId === barber.staffId ? <span className="check">✓</span> : null}
            </button>
          ))}
        </div>
      </main>
    </>
  );
}

const DATE_STRIP_DAYS = 14;

export function TimeScreen(props: Props) {
  const { shop, api, realtime, state, dispatch } = props;

  const today = useMemo(() => isoDateIn(Date.now(), shop.timezone), [shop.timezone]);
  const date = state.date ?? today;

  const [availability, setAvailability] = useState<Availability | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const dates = useMemo(
    () => Array.from({ length: DATE_STRIP_DAYS }, (_, i) => addDays(today, i)),
    [today],
  );

  // Refetch whenever the thing being booked changes.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    api
      .availability(shop.locationId, state.serviceIds, date, state.staffId)
      .then((result) => {
        if (!cancelled) setAvailability(result);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : 'Could not load times');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [api, shop.locationId, state.serviceIds, state.staffId, date]);

  /**
   * Watch only the day being looked at, and drop the subscription on leaving.
   * Subscribing to anything broader is the cost and privacy mistake the
   * research warns about.
   */
  useEffect(() => {
    if (!realtime) return;
    const channel = channels.availability(shop.locationId, date);
    realtime.setChannels([channel]);
    return () => realtime.unsubscribe(channel);
  }, [realtime, shop.locationId, date]);

  // Apply realtime deltas so the grid updates under the user's finger.
  useEffect(() => {
    if (!realtime) return;

    const handler = (channel: string, event: Record<string, unknown>) => {
      if (channel !== channels.availability(shop.locationId, date)) return;
      if (event.type !== 'availability.changed') return;

      setAvailability((current) =>
        current
          ? {
              ...current,
              options: applySlotDelta(current.options, {
                taken: event.taken as string[] | undefined,
                released: event.released as string[] | undefined,
              }),
            }
          : current,
      );
    };

    return realtime.onEvent(handler);
  }, [realtime, shop.locationId, date]);

  const groups = useMemo(
    () => groupByDaypart(availability?.options ?? [], shop.timezone),
    [availability, shop.timezone],
  );

  // Never show an empty grid with no way forward: offer the next days that do
  // have availability instead.
  const nextAvailableDates = dates
    .filter((candidate) => candidate > date)
    .slice(0, 3);

  return (
    <>
      <main>
        <div className="dates" role="group" aria-label="Choose a date">
          {dates.map((candidate) => (
            <button
              key={candidate}
              className="date"
              aria-pressed={candidate === date}
              onClick={() => dispatch({ type: 'chooseDate', date: candidate })}
            >
              {formatDate(candidate, shop.timezone)}
            </button>
          ))}
        </div>

        {timezoneDiffers(shop.timezone) ? (
          <p className="muted">
            Times shown in {shop.name}&rsquo;s local time ({shop.timezone}).
          </p>
        ) : null}

        {state.lostSlot ? (
          <p className="notice warn" role="status">
            {formatTime(state.lostSlot, shop.timezone)} was just booked by someone
            else. Here&rsquo;s what&rsquo;s still free.
          </p>
        ) : null}

        {error ? <p className="error">{error}</p> : null}

        {loading ? (
          <div className="slots" aria-hidden="true">
            {Array.from({ length: 9 }, (_, i) => (
              <div key={i} className="skeleton" />
            ))}
          </div>
        ) : groups.length === 0 ? (
          <div className="stack">
            <p className="muted">Nothing free on {formatDate(date, shop.timezone)}.</p>
            {nextAvailableDates.map((candidate) => (
              <button
                key={candidate}
                className="btn secondary block"
                onClick={() => dispatch({ type: 'chooseDate', date: candidate })}
              >
                Try {formatDate(candidate, shop.timezone)}
              </button>
            ))}
          </div>
        ) : (
          groups.map((group) => (
            <section key={group.daypart}>
              <h2>{group.daypart}</h2>
              <div className="slots">
                {group.slots.map((slot) => (
                  <button
                    key={slot.start}
                    className="slot"
                    aria-pressed={state.start === slot.start}
                    onClick={() => dispatch({ type: 'chooseSlot', start: slot.start })}
                  >
                    {formatTime(slot.start, shop.timezone)}
                  </button>
                ))}
              </div>
            </section>
          ))
        )}
      </main>
    </>
  );
}

/**
 * Phone plus a code.
 *
 * Reached only AFTER a slot is chosen — browsing never required an account.
 * The one caveat: the server needs a session before it will hold a slot, so
 * this sits between choosing a time and the hold, which widens the window in
 * which someone else can take it. That is why `SLOT_TAKEN` is handled as a
 * first-class in-flow outcome rather than an error.
 */
export function IdentifyScreen(props: Props) {
  const { api, shop, dispatch } = props;
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sendCode = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.requestCode(phone, shop.locationId);
      setChallengeId(result.challengeId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send a code');
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    if (!challengeId) return;
    setBusy(true);
    setError(null);
    try {
      await api.verifyCode(challengeId, code, name || undefined);
      dispatch({ type: 'authenticated' });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not verify that code');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main>
      <h2>Almost done</h2>
      <p className="muted">
        We&rsquo;ll text you a code to confirm the booking. No password needed.
      </p>

      {challengeId === null ? (
        <>
          <div className="field">
            <label htmlFor="phone">Mobile number</label>
            <input
              id="phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder="+44 7700 900000"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="name">Name</label>
            <input
              id="name"
              autoComplete="name"
              placeholder="So your barber knows who to expect"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          {error ? <p className="error">{error}</p> : null}
          <button
            className="btn block"
            onClick={sendCode}
            disabled={busy || phone.trim().length < 5}
          >
            {busy ? 'Sending…' : 'Send code'}
          </button>
        </>
      ) : (
        <>
          <div className="field">
            <label htmlFor="code">Six-digit code</label>
            <input
              id="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="000000"
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
            />
          </div>
          {error ? <p className="error">{error}</p> : null}
          <button
            className="btn block"
            onClick={verify}
            disabled={busy || code.length < 4}
          >
            {busy ? 'Checking…' : 'Confirm'}
          </button>
          <button className="btn secondary block" onClick={() => setChallengeId(null)}>
            Use a different number
          </button>
        </>
      )}
    </main>
  );
}

export function ConfirmScreen(props: Props) {
  const { shop, api, state, dispatch } = props;

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [policy, setPolicy] = useState<string | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);

  // One key per booking attempt, reused across retries of that attempt. A
  // fresh key per call would defeat idempotency entirely.
  const idempotencyKey = useRef(newIdempotencyKey());

  const totals = selectionTotals(state.serviceIds, shop.services);
  const barber = shop.staff.find((s) => s.staffId === state.staffId);

  // Hold the slot on arrival, so it cannot be taken while the client reads the
  // policy and decides.
  useEffect(() => {
    if (state.appointmentId || !state.start) return;

    let cancelled = false;
    setBusy(true);

    api
      .hold({
        locationId: shop.locationId,
        serviceIds: state.serviceIds,
        start: state.start,
        staffId: state.staffId,
      })
      .then((held) => {
        if (cancelled) return;
        dispatch({
          type: 'held',
          appointmentId: held.appointmentId,
          holdExpiresAt: held.holdExpiresAt,
          start: held.startsAt,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Someone got there first. Back to the grid with the loss named,
        // rather than an error dialog and a lost place in the flow.
        if (err instanceof ApiError && err.isSlotGone) {
          dispatch({ type: 'slotLost', start: state.start! });
          return;
        }
        setError(err instanceof ApiError ? err.message : 'Could not hold that time');
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });

    return () => {
      cancelled = true;
    };
  }, [api, dispatch, shop.locationId, state.appointmentId, state.serviceIds, state.staffId, state.start]);

  // Countdown on the hold, so the client knows the time is reserved and for
  // how long rather than guessing.
  useEffect(() => {
    if (!state.holdExpiresAt) {
      setRemaining(null);
      return;
    }
    const expiry = Date.parse(state.holdExpiresAt);
    const tick = () => setRemaining(expiry - Date.now());
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [state.holdExpiresAt]);

  const confirm = async () => {
    if (!state.appointmentId) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.confirm(state.appointmentId, idempotencyKey.current);
      setPolicy(result.policy?.summary ?? null);
      dispatch({ type: 'confirmed' });
    } catch (err) {
      if (err instanceof ApiError && err.isSlotGone) {
        dispatch({ type: 'slotLost', start: state.start! });
        return;
      }
      setError(err instanceof ApiError ? err.message : 'Could not confirm');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <main>
        <h2>Confirm</h2>

        <div className="card stack">
          <div>
            <strong>{shop.name}</strong>
            {shop.address ? <div className="meta">{shop.address}</div> : null}
          </div>
          <div>
            {state.start ? (
              <>
                <strong>
                  {formatDate(
                    isoDateIn(Date.parse(state.start), shop.timezone),
                    shop.timezone,
                  )}{' '}
                  at {formatTime(state.start, shop.timezone)}
                </strong>
                <div className="meta">
                  with {barber ? barber.name : 'the first available barber'} ·{' '}
                  {formatDuration(totals.durationMinutes)}
                </div>
              </>
            ) : null}
          </div>
          <div>
            {state.serviceIds.map((id) => {
              const service = shop.services.find((s) => s.serviceId === id);
              if (!service) return null;
              return (
                <div key={id} className="row" style={{ cursor: 'default' }}>
                  <span className="name">{service.name}</span>
                  <span className="price">
                    {formatMoney(service.priceCents, shop.currency)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {remaining !== null && remaining > 0 ? (
          <p className="notice" role="status">
            This time is held for you for {formatCountdown(remaining)}.
          </p>
        ) : null}

        {/* The terms are stated before the tap that accepts them, not after. */}
        <p className="muted">
          Free cancellation up to {shop.cancellationWindowHours} hours before your
          appointment.
        </p>

        {error ? <p className="error">{error}</p> : null}
        {policy ? <p className="muted">{policy}</p> : null}
      </main>

      <CtaBar {...props} label="Book it" onPress={confirm} busy={busy} />
    </>
  );
}

export function BookedScreen(props: Props) {
  const { shop, state, dispatch } = props;
  const barber = shop.staff.find((s) => s.staffId === state.staffId);

  return (
    <main>
      <p className="notice good" role="status">
        Booked. We&rsquo;ll text you a reminder before your appointment.
      </p>

      <div className="card stack">
        <strong>{shop.name}</strong>
        {state.start ? (
          <div>
            {formatDate(isoDateIn(Date.parse(state.start), shop.timezone), shop.timezone)}{' '}
            at {formatTime(state.start, shop.timezone)}
            <div className="meta">with {barber ? barber.name : 'your barber'}</div>
          </div>
        ) : null}
        {shop.address ? <div className="meta">{shop.address}</div> : null}
      </div>

      <div className="stack">
        {shop.address ? (
          <a
            className="btn secondary block"
            style={{ textAlign: 'center', lineHeight: '44px', textDecoration: 'none' }}
            href={`https://maps.google.com/?q=${encodeURIComponent(shop.address)}`}
            target="_blank"
            rel="noreferrer noopener"
          >
            Directions
          </a>
        ) : null}
        <button className="btn secondary block" onClick={() => dispatch({ type: 'reset' })}>
          Book another
        </button>
      </div>
    </main>
  );
}
