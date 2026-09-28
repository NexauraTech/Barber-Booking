/**
 * Realtime client.
 *
 * Two rules from docs/research/03-realtime.md that this enforces:
 *
 *   **Realtime is an optimisation, never the source of truth.** A gap in the
 *   `seq` numbers means refetch the authoritative state rather than trying to
 *   patch forward from a stream that may have holes.
 *
 *   **Reconnect with backoff AND jitter.** Without jitter, every client that
 *   dropped when the server blipped reconnects in lockstep and stampedes it.
 *
 * Subscriptions are re-sent on reconnect, because the server holds them per
 * connection and a new socket starts with none.
 */

export interface RealtimeMessage {
  type: string;
  channel?: string;
  event?: {
    type: string;
    seq: number;
    at: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export type EventHandler = (channel: string, event: NonNullable<RealtimeMessage['event']>) => void;

/** Called when a seq gap means local state may be stale. */
export type ResyncHandler = (reason: string) => void;

export interface RealtimeOptions {
  url: string;
  token?: string | null;
  /** Optional; screens usually register their own via `onEvent()`. */
  onEvent?: EventHandler;
  onResync?: ResyncHandler;
  onStatus?: (status: 'connecting' | 'open' | 'closed') => void;
  /** Injectable for tests. */
  socketFactory?: (url: string) => WebSocketLike;
  now?: () => number;
}

/** The slice of WebSocket this client uses, so tests can substitute a fake. */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((event?: unknown) => void) | null;
  onclose: ((event?: unknown) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
}

const MAX_BACKOFF_MS = 30_000;

export class RealtimeClient {
  private socket: WebSocketLike | undefined;
  private readonly channels = new Set<string>();
  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private lastSeq = 0;
  /** Screens register and deregister as they mount and unmount. */
  private readonly handlers = new Set<EventHandler>();
  private readonly statusHandlers = new Set<
    (status: 'connecting' | 'open' | 'closed') => void
  >();
  private status: 'connecting' | 'open' | 'closed' = 'closed';

  constructor(private readonly options: RealtimeOptions) {
    if (options.onEvent) this.handlers.add(options.onEvent);
  }

  /** Register an event handler. Returns a deregister function. */
  onEvent(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /**
   * Watch the connection state, so the UI can show "Reconnecting…" rather
   * than a stale number presented as live.
   */
  onStatusChange(handler: (status: 'connecting' | 'open' | 'closed') => void): () => void {
    this.statusHandlers.add(handler);
    handler(this.status);
    return () => this.statusHandlers.delete(handler);
  }

  connect(): void {
    this.stopped = false;
    this.open();
  }

  private open(): void {
    if (this.stopped) return;

    this.setStatus('connecting');

    const url = this.options.token
      ? `${this.options.url}?token=${encodeURIComponent(this.options.token)}`
      : this.options.url;

    const factory =
      this.options.socketFactory ??
      ((target: string) => new WebSocket(target) as unknown as WebSocketLike);

    let socket: WebSocketLike;
    try {
      socket = factory(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.attempts = 0;
      this.setStatus('open');
      // The server holds subscriptions per connection, so a new socket has
      // none — re-send them all.
      for (const channel of this.channels) {
        socket.send(JSON.stringify({ action: 'subscribe', channel }));
      }
    };

    socket.onmessage = (message) => {
      let parsed: RealtimeMessage;
      try {
        parsed = JSON.parse(message.data) as RealtimeMessage;
      } catch {
        return;
      }
      this.handle(parsed);
    };

    socket.onclose = () => {
      this.setStatus('closed');
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      // `onclose` follows an error, so reconnection is handled there; closing
      // here too would double-schedule.
      try {
        socket.close();
      } catch {
        // Already closing.
      }
    };
  }

  private setStatus(status: 'connecting' | 'open' | 'closed'): void {
    this.status = status;
    this.options.onStatus?.(status);
    for (const handler of this.statusHandlers) handler(status);
  }

  private handle(message: RealtimeMessage): void {
    if (message.type === 'welcome') {
      const serverSeq = Number(message.serverSeq ?? 0);
      // The server is ahead of what this client last saw, so it missed events
      // while disconnected.
      if (this.lastSeq > 0 && serverSeq > this.lastSeq) {
        this.options.onResync?.('reconnected behind the server');
      }
      return;
    }

    if (message.type !== 'event' || !message.channel || !message.event) return;

    const { seq, type } = message.event;

    // A jump of more than one means events were dropped in between. Local
    // state cannot be patched forward from an incomplete stream.
    if (this.lastSeq > 0 && seq > this.lastSeq + 1) {
      this.options.onResync?.('missed events');
    }
    if (seq > this.lastSeq) this.lastSeq = seq;

    // The server's own signal that a payload was too large to send.
    if (type === 'resync') {
      this.options.onResync?.('server asked for a resync');
      return;
    }

    for (const handler of this.handlers) {
      // One misbehaving screen must not stop the others being told.
      try {
        handler(message.channel, message.event);
      } catch {
        // Swallowed deliberately: realtime is an optimisation, and a render
        // error in one subscriber is not a reason to break the rest.
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.timer) return;

    this.socket = undefined;
    const ceiling = Math.min(MAX_BACKOFF_MS, 500 * 2 ** this.attempts);
    // Half fixed, half random: spreads a thundering herd without making the
    // first retry uselessly slow.
    const delay = ceiling / 2 + Math.random() * (ceiling / 2);
    this.attempts++;

    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.open();
    }, delay);
  }

  subscribe(channel: string): void {
    this.channels.add(channel);
    try {
      this.socket?.send(JSON.stringify({ action: 'subscribe', channel }));
    } catch {
      // Queued for the next open.
    }
  }

  unsubscribe(channel: string): void {
    this.channels.delete(channel);
    try {
      this.socket?.send(JSON.stringify({ action: 'unsubscribe', channel }));
    } catch {
      // Nothing to do; the subscription is gone locally either way.
    }
  }

  /** Swap the whole subscription set, for navigating between screens. */
  setChannels(channels: readonly string[]): void {
    const wanted = new Set(channels);
    for (const existing of [...this.channels]) {
      if (!wanted.has(existing)) this.unsubscribe(existing);
    }
    for (const channel of wanted) {
      if (!this.channels.has(channel)) this.subscribe(channel);
    }
  }

  close(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.channels.clear();
    try {
      this.socket?.close();
    } catch {
      // Already gone.
    }
    this.socket = undefined;
  }

  get subscribedChannels(): string[] {
    return [...this.channels];
  }
}

export const channels = {
  availability: (locationId: string, date: string) =>
    `shop:${locationId}:availability:${date}`,
  queue: (locationId: string) => `shop:${locationId}:queue`,
  client: (clientId: string) => `client:${clientId}`,
};
