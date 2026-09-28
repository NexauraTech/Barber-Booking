/**
 * The walk-in queue.
 *
 * This is the QR-code-at-the-door path (docs/research/01-market-landscape.md
 * §1.5): scan, pick a service, join, watch your position, leave and come back.
 * No install, no account, no password. In walk-in markets most clients will
 * never install anything, so an install requirement here kills adoption.
 *
 * The token is kept in localStorage so returning to the page still shows their
 * place — losing it would mean losing their spot from their point of view.
 */
import { useEffect, useState } from 'react';
import type { BookingApi, QueueStatus, Shop } from '../api/client.js';
import { ApiError } from '../api/client.js';
import type { RealtimeClient } from '../api/realtime.js';
import { channels } from '../api/realtime.js';
import { formatDuration, formatMoney, formatWaitRange } from '../state/format.js';

const TOKEN_KEY = 'barber.queueToken';

function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function writeToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Works for this page view either way.
  }
}

interface Props {
  shop: Shop;
  api: BookingApi;
  realtime: RealtimeClient | null;
}

export function QueueScreen({ shop, api, realtime }: Props) {
  const [token, setToken] = useState<string | null>(readToken);
  const [status, setStatus] = useState<QueueStatus | null>(null);
  const [serviceIds, setServiceIds] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connection, setConnection] = useState<'connecting' | 'open' | 'closed'>(
    'connecting',
  );

  const refresh = async (current: string) => {
    try {
      setStatus(await api.queueStatus(current));
    } catch (err) {
      // A token for an entry that no longer exists should clear, not loop.
      if (err instanceof ApiError && err.status === 404) {
        writeToken(null);
        setToken(null);
      }
    }
  };

  useEffect(() => {
    if (!token) return;
    void refresh(token);
  }, [token]);

  /**
   * Live position over the public queue channel.
   *
   * Poll as well as subscribe: the research is explicit that realtime is an
   * optimisation and never the source of truth, and someone watching a queue
   * from a patchy connection must not be left on a stale number.
   */
  useEffect(() => {
    if (!token) return;

    const timer = setInterval(() => void refresh(token), 20_000);
    return () => clearInterval(timer);
  }, [token]);

  useEffect(() => {
    if (!realtime || !token) return;

    const channel = channels.queue(shop.locationId);
    realtime.setChannels([channel]);

    const off = realtime.onEvent((incoming) => {
      if (incoming !== channel) return;
      // The public payload carries no identities, so the client cannot pick
      // itself out of it — refetch its own status instead.
      void refresh(token);
    });

    return () => {
      off();
      realtime.unsubscribe(channel);
    };
  }, [realtime, token, shop.locationId]);

  useEffect(() => {
    if (!realtime) return;
    return realtime.onStatusChange(setConnection);
  }, [realtime]);

  const join = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.joinQueue(shop.locationId, {
        serviceIds,
        name: name || undefined,
        phone: phone || undefined,
      });
      writeToken(result.publicToken);
      setToken(result.publicToken);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not join the queue');
    } finally {
      setBusy(false);
    }
  };

  const leave = async () => {
    if (!token) return;
    setBusy(true);
    try {
      await api.leaveQueue(token);
    } catch {
      // Leaving is best-effort; the local token goes either way.
    } finally {
      writeToken(null);
      setToken(null);
      setStatus(null);
      setBusy(false);
    }
  };

  if (token && status) {
    const waiting = status.status === 'waiting' || status.status === 'notified';

    return (
      <main className="centre stack">
        {waiting ? (
          <>
            <p className="muted">Your position</p>
            <div className="position" aria-live="polite">
              {status.position ?? '—'}
            </div>
            <p aria-live="polite">{formatWaitRange(status.waitMinutes)}</p>

            {status.status === 'notified' ? (
              <p className="notice good" role="status">
                You&rsquo;re nearly up — please head back to the shop.
              </p>
            ) : (
              <p className="muted">
                You can step out. We&rsquo;ll text you when you&rsquo;re nearly up.
              </p>
            )}

            <span className="live" data-status={connection}>
              {connection === 'open' ? 'Live' : 'Reconnecting…'}
            </span>

            <button className="btn danger block" onClick={leave} disabled={busy}>
              Leave the queue
            </button>
          </>
        ) : (
          <>
            <p className="notice" role="status">
              {status.status === 'promoted' || status.status === 'in_chair'
                ? "You're up — see you in the chair."
                : status.status === 'served'
                  ? 'All done. Thanks for coming in.'
                  : 'You are no longer in the queue.'}
            </p>
            <button
              className="btn block"
              onClick={() => {
                writeToken(null);
                setToken(null);
                setStatus(null);
              }}
            >
              Join again
            </button>
          </>
        )}
      </main>
    );
  }

  return (
    <main>
      <h2>Join the queue at {shop.name}</h2>
      <p className="muted">
        No app needed. Pick what you&rsquo;re after and we&rsquo;ll text you when
        you&rsquo;re nearly up.
      </p>

      <div>
        {shop.services
          .filter((service) => !service.isAddon)
          .map((service) => {
            const selected = serviceIds.includes(service.serviceId);
            return (
              <button
                key={service.serviceId}
                className="row"
                aria-pressed={selected}
                onClick={() =>
                  setServiceIds((current) =>
                    selected
                      ? current.filter((id) => id !== service.serviceId)
                      : [...current, service.serviceId],
                  )
                }
              >
                <span>
                  <span className="name">{service.name}</span>
                  <br />
                  <span className="meta">
                    {formatDuration(service.durationMinutes)}
                  </span>
                </span>
                <span className="price">
                  {formatMoney(service.priceCents, shop.currency)}
                  {selected ? <span className="check"> ✓</span> : null}
                </span>
              </button>
            );
          })}
      </div>

      {/* Name and number only — the minimum to call someone back in. */}
      <div className="field">
        <label htmlFor="q-name">Name</label>
        <input
          id="q-name"
          autoComplete="name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="q-phone">Mobile number</label>
        <input
          id="q-phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
        />
      </div>

      {error ? <p className="error">{error}</p> : null}

      <button
        className="btn block"
        onClick={join}
        disabled={busy || serviceIds.length === 0 || name.trim() === '' || phone.trim().length < 5}
      >
        {busy ? 'Joining…' : 'Join the queue'}
      </button>
    </main>
  );
}
