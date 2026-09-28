/**
 * App shell.
 *
 * Routing is a hash router written by hand: a router library is 10–15KB for
 * what amounts to three destinations, and the budget is under three seconds to
 * interactive on a mid-range Android.
 *
 * Deep links matter more than navigation here — Instagram bio, Google Business
 * Profile, a WhatsApp message, a QR code at the door — and each must land
 * directly on the right screen, not the app's home
 * (docs/research/04-apps-and-ux.md §4.1).
 *
 *   #/s/<locationId>          the shop, start of the booking flow
 *   #/s/<locationId>/queue    join the walk-in queue (the QR target)
 *   #/bookings                my bookings
 */
import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { ApiError, BookingApi, type Booking, type Shop } from './api/client.js';
import { RealtimeClient } from './api/realtime.js';
import { initialState, reducer } from './state/flow.js';
import {
  BarberScreen,
  BookedScreen,
  ConfirmScreen,
  IdentifyScreen,
  ServicesScreen,
  TimeScreen,
} from './screens/Booking.js';
import { QueueScreen } from './screens/Queue.js';
import { formatDate, formatTime, isoDateIn } from './state/format.js';

export interface Route {
  view: 'shop' | 'queue' | 'bookings' | 'missing';
  locationId?: string;
}

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, '').split('?')[0] ?? '';
  const parts = path.split('/').filter(Boolean);

  if (parts[0] === 's' && parts[1]) {
    return parts[2] === 'queue'
      ? { view: 'queue', locationId: parts[1] }
      : { view: 'shop', locationId: parts[1] };
  }
  if (parts[0] === 'bookings') return { view: 'bookings' };
  return { view: 'missing' };
}

function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(location.hash));

  useEffect(() => {
    const update = () => setRoute(parseRoute(location.hash));
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);

  return route;
}

const STEP_TITLES: Record<string, string> = {
  services: 'Book',
  barber: 'Choose a barber',
  time: 'Pick a time',
  identify: 'Your details',
  confirm: 'Confirm',
  booked: 'Booked',
};

export interface AppProps {
  api?: BookingApi;
  /** Injected in tests; the real app builds its own from the API base. */
  realtime?: RealtimeClient | null;
  apiBase?: string;
  realtimeUrl?: string;
}

export function App({ api: injectedApi, realtime: injectedRealtime, apiBase = '', realtimeUrl }: AppProps) {
  const route = useRoute();
  const api = useMemo(() => injectedApi ?? new BookingApi(apiBase), [injectedApi, apiBase]);
  const [state, dispatch] = useReducer(reducer, {
    ...initialState,
    authenticated: api.authenticated,
  });

  const [shop, setShop] = useState<Shop | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [realtime, setRealtime] = useState<RealtimeClient | null>(
    injectedRealtime ?? null,
  );
  const [staleNotice, setStaleNotice] = useState(false);

  // One socket for the app's lifetime, not one per screen.
  useEffect(() => {
    if (injectedRealtime !== undefined) return;
    if (!realtimeUrl) return;

    const client = new RealtimeClient({
      url: realtimeUrl,
      token: api.bearer,
      // A gap means local state may be stale; say so rather than presenting
      // an out-of-date grid as live.
      onResync: () => setStaleNotice(true),
    });
    client.connect();
    setRealtime(client);

    return () => client.close();
  }, [api, injectedRealtime, realtimeUrl]);

  useEffect(() => {
    if (!route.locationId) return;

    let cancelled = false;
    setLoadError(null);

    api
      .shop(route.locationId)
      .then((result) => {
        if (!cancelled) setShop(result);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(
          err instanceof ApiError && err.status === 404
            ? 'We could not find that shop.'
            : 'Could not load the shop. Check your connection and try again.',
        );
      });

    return () => {
      cancelled = true;
    };
  }, [api, route.locationId]);

  const goBack = useCallback(() => dispatch({ type: 'back' }), []);

  if (route.view === 'bookings') {
    return <MyBookings api={api} />;
  }

  if (route.view === 'missing') {
    return (
      <div className="app">
        <main>
          <h2>Nothing here</h2>
          <p className="muted">
            Open the link your barber gave you, or scan the code in the shop.
          </p>
        </main>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="app">
        <main>
          <p className="notice warn">{loadError}</p>
        </main>
      </div>
    );
  }

  if (!shop) {
    return (
      <div className="app">
        <main aria-busy="true">
          <div className="skeleton" style={{ height: 24, maxWidth: 180 }} />
          <div className="skeleton" style={{ height: 72 }} />
          <div className="skeleton" style={{ height: 72 }} />
        </main>
      </div>
    );
  }

  if (route.view === 'queue') {
    return (
      <div className="app">
        <header className="header">
          <h1>{shop.name}</h1>
        </header>
        <QueueScreen shop={shop} api={api} realtime={realtime} />
      </div>
    );
  }

  const screenProps = { shop, api, realtime, state, dispatch };
  const canGoBack = state.step !== 'services' && state.step !== 'booked';

  return (
    <div className="app">
      <header className="header">
        {canGoBack ? (
          <button className="back" onClick={goBack} aria-label="Back">
            ‹
          </button>
        ) : null}
        <h1>{STEP_TITLES[state.step] ?? shop.name}</h1>
      </header>

      {staleNotice ? (
        <div style={{ padding: '0 16px' }}>
          <p className="notice warn" role="status">
            You may have missed an update.{' '}
            <button
              className="btn secondary"
              style={{ minHeight: 32, padding: '0 10px' }}
              onClick={() => {
                setStaleNotice(false);
                // Realtime is never the source of truth, so recovery is a
                // refetch rather than an attempt to patch forward.
                location.reload();
              }}
            >
              Refresh
            </button>
          </p>
        </div>
      ) : null}

      {state.step === 'services' ? <ServicesScreen {...screenProps} /> : null}
      {state.step === 'barber' ? <BarberScreen {...screenProps} /> : null}
      {state.step === 'time' ? <TimeScreen {...screenProps} /> : null}
      {state.step === 'identify' ? <IdentifyScreen {...screenProps} /> : null}
      {state.step === 'confirm' ? <ConfirmScreen {...screenProps} /> : null}
      {state.step === 'booked' ? <BookedScreen {...screenProps} /> : null}
    </div>
  );
}

function MyBookings({ api }: { api: BookingApi }) {
  const [bookings, setBookings] = useState<Booking[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .myBookings(true)
      .then((result) => setBookings(result.appointments))
      .catch((err: unknown) => {
        setError(
          err instanceof ApiError && err.status === 401
            ? 'Sign in from a booking link to see your appointments.'
            : 'Could not load your bookings.',
        );
      });
  }, [api]);

  useEffect(load, [load]);

  const cancel = async (appointmentId: string) => {
    setCancelling(appointmentId);
    try {
      const result = await api.cancel(appointmentId);
      if (result.feeCents > 0) {
        // A fee is stated plainly, never discovered on a statement later.
        setError(`Cancelled. A late cancellation fee applies.`);
      }
      load();
    } catch {
      setError('Could not cancel that booking.');
    } finally {
      setCancelling(null);
    }
  };

  return (
    <div className="app">
      <header className="header">
        <h1>Your appointments</h1>
      </header>
      <main>
        {error ? <p className="notice warn">{error}</p> : null}

        {bookings === null && !error ? (
          <div className="skeleton" style={{ height: 96 }} />
        ) : null}

        {bookings?.length === 0 ? (
          <p className="muted">Nothing booked at the moment.</p>
        ) : null}

        {bookings?.map((booking) => (
          <div key={booking.appointmentId} className="card stack">
            <div>
              <strong>
                {formatDate(
                  isoDateIn(Date.parse(booking.startsAt), booking.timezone),
                  booking.timezone,
                )}{' '}
                at {formatTime(booking.startsAt, booking.timezone)}
              </strong>
              <div className="meta">
                {booking.locationName} · with {booking.staffName}
              </div>
              {booking.address ? <div className="meta">{booking.address}</div> : null}
            </div>
            <button
              className="btn danger"
              onClick={() => cancel(booking.appointmentId)}
              disabled={cancelling === booking.appointmentId}
            >
              {cancelling === booking.appointmentId ? 'Cancelling…' : 'Cancel'}
            </button>
          </div>
        ))}
      </main>
    </div>
  );
}
