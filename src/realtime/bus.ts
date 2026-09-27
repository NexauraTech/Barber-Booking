/**
 * The event bus: Postgres LISTEN/NOTIFY.
 *
 * Why Postgres rather than Redis or a vendor:
 *
 *   **NOTIFY is transactional.** A notification published on the same
 *   connection as a write is held by Postgres until COMMIT and DISCARDED on
 *   ROLLBACK. So an event can only ever describe a write that actually landed
 *   — no "booking created" for a booking that rolled back, and no window where
 *   the event beats the row it describes. Getting that property from an
 *   external broker takes an outbox and a relay.
 *
 *   It also needs no extra infrastructure, and fans out across every API
 *   instance, which an in-process EventEmitter does not.
 *
 * The cost is a hard 8000-byte payload ceiling, which is why events carry
 * deltas rather than rows. Anything that would exceed it is replaced by a
 * `resync` telling subscribers to refetch — a dropped change is unacceptable,
 * a slightly wasteful refetch is not.
 */
import pg from 'pg';
import type { PoolClient } from 'pg';
import { getPool } from '../db/pool.js';
import type { RealtimeEvent } from './events.js';

export const CHANNEL = 'barber_booking_events';

/** Postgres' documented NOTIFY payload limit, with room for the envelope. */
const MAX_PAYLOAD_BYTES = 7500;

type Db = Pick<PoolClient, 'query'>;

/**
 * `Omit` over a union collapses it to the members' common keys, which would
 * silently drop every event-specific field. Distributing keeps each variant.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

export type EventInput = DistributiveOmit<RealtimeEvent, 'seq' | 'at'> & {
  at?: string;
};

/**
 * Publish an event.
 *
 * Pass the transaction's client to tie the event to the commit. Called without
 * one it publishes immediately, which is right for things that are not part of
 * a write (presence, for instance).
 */
export async function publish(
  event: EventInput,
  client?: Db,
): Promise<void> {
  const db: Db = client ?? getPool();

  // A Postgres sequence gives a deployment-wide monotonic number, so a
  // subscriber can spot a gap and refetch rather than quietly missing a change.
  const { rows } = await db.query(`SELECT nextval('realtime_event_seq')::bigint AS seq`);
  const seq = Number(rows[0].seq);

  const full = { ...event, seq, at: event.at ?? new Date().toISOString() };
  let payload = JSON.stringify(full);

  if (Buffer.byteLength(payload, 'utf8') > MAX_PAYLOAD_BYTES) {
    const localDate =
      'localDate' in event && typeof event.localDate === 'string'
        ? event.localDate
        : undefined;

    const resync: RealtimeEvent = {
      type: 'resync',
      seq,
      at: full.at,
      locationId: event.locationId,
      reason: `${event.type} payload exceeded the notify limit`,
      ...(localDate ? { localDate } : {}),
    };
    payload = JSON.stringify(resync);
  }

  // pg_notify() rather than NOTIFY, because the latter takes no parameters and
  // would mean interpolating JSON into SQL.
  await db.query(`SELECT pg_notify($1, $2)`, [CHANNEL, payload]);
}

export type Listener = (event: RealtimeEvent) => void;

/**
 * A dedicated connection that LISTENs and fans out locally.
 *
 * Deliberately NOT from the pool: a pooled client would be handed back to
 * other callers and lose the LISTEN registration. One long-lived connection
 * per process, reconnecting on loss.
 */
export class EventBus {
  private client: pg.Client | undefined;
  private readonly listeners = new Set<Listener>();
  private stopped = false;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  /** Highest seq seen, so a caller can tell how far behind it was. */
  lastSeq = 0;

  constructor(
    private readonly connectionString = process.env.DATABASE_URL ??
      'postgres://postgres@localhost:5432/barber_booking',
    private readonly onError: (err: unknown) => void = () => {},
  ) {}

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;

    const client = new pg.Client({ connectionString: this.connectionString });
    this.client = client;

    client.on('notification', (message) => {
      if (!message.payload) return;
      try {
        const event = JSON.parse(message.payload) as RealtimeEvent;
        if (event.seq > this.lastSeq) this.lastSeq = event.seq;
        for (const listener of this.listeners) {
          // One bad subscriber must not stop the others from being told.
          try {
            listener(event);
          } catch (err) {
            this.onError(err);
          }
        }
      } catch (err) {
        this.onError(err);
      }
    });

    client.on('error', (err) => {
      this.onError(err);
      void this.scheduleReconnect();
    });

    try {
      await client.connect();
      await client.query(`LISTEN ${CHANNEL}`);
      this.reconnectAttempts = 0;
    } catch (err) {
      this.onError(err);
      await this.scheduleReconnect();
    }
  }

  /**
   * Reconnect with exponential backoff and jitter.
   *
   * Jitter matters: without it, every API instance that lost the database
   * reconnects in lockstep and stampedes it back down.
   */
  private async scheduleReconnect(): Promise<void> {
    if (this.stopped || this.reconnectTimer) return;

    await this.client?.end().catch(() => {});
    this.client = undefined;

    const backoff = Math.min(30_000, 250 * 2 ** this.reconnectAttempts);
    const delay = backoff / 2 + Math.random() * (backoff / 2);
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.listeners.clear();
    await this.client?.end().catch(() => {});
    this.client = undefined;
  }

  get connected(): boolean {
    return this.client !== undefined;
  }
}
