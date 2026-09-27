/**
 * The connection hub.
 *
 * Holds the live sockets, their subscriptions, and routes bus events to them
 * through the per-channel projection. Sits between the bus (one LISTEN per
 * process) and the sockets (many per process).
 */
import {
  type Channel,
  type Viewer,
  canSubscribe,
  channelsForEvent,
  parseChannel,
  projectForChannel,
} from './channels.js';
import type { EventBus } from './bus.js';
import type { RealtimeEvent } from './events.js';

export interface Socket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface Connection {
  id: string;
  socket: Socket;
  viewer: Viewer | null;
  channels: Set<string>;
  /** Highest seq delivered, so a gap can be reported on resubscribe. */
  lastSeq: number;
}

let nextId = 1;

export class Hub {
  private readonly connections = new Map<string, Connection>();
  /** channel name -> connection ids, so fan-out is a lookup not a scan. */
  private readonly byChannel = new Map<string, Set<string>>();
  private unsubscribeBus: (() => void) | undefined;

  attach(bus: EventBus): void {
    this.unsubscribeBus?.();
    this.unsubscribeBus = bus.subscribe((event) => this.dispatch(event));
  }

  detach(): void {
    this.unsubscribeBus?.();
    this.unsubscribeBus = undefined;
  }

  add(socket: Socket, viewer: Viewer | null): Connection {
    const connection: Connection = {
      id: `c${nextId++}`,
      socket,
      viewer,
      channels: new Set(),
      lastSeq: 0,
    };
    this.connections.set(connection.id, connection);
    return connection;
  }

  remove(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;

    for (const channel of connection.channels) {
      const members = this.byChannel.get(channel);
      members?.delete(connectionId);
      if (members?.size === 0) this.byChannel.delete(channel);
    }
    this.connections.delete(connectionId);
  }

  /**
   * Subscribe a connection to a channel.
   *
   * Every subscription is authorised here — the single gate. A channel name
   * that does not parse is rejected rather than treated as a prefix or a
   * wildcard.
   */
  subscribe(
    connectionId: string,
    channelName: string,
  ): { ok: true; channel: Channel } | { ok: false; reason: 'invalid' | 'forbidden' } {
    const connection = this.connections.get(connectionId);
    if (!connection) return { ok: false, reason: 'invalid' };

    const channel = parseChannel(channelName);
    if (!channel) return { ok: false, reason: 'invalid' };

    if (!canSubscribe(channel, connection.viewer)) {
      return { ok: false, reason: 'forbidden' };
    }

    connection.channels.add(channel.name);
    let members = this.byChannel.get(channel.name);
    if (!members) {
      members = new Set();
      this.byChannel.set(channel.name, members);
    }
    members.add(connectionId);

    return { ok: true, channel };
  }

  unsubscribe(connectionId: string, channelName: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;

    connection.channels.delete(channelName);
    const members = this.byChannel.get(channelName);
    members?.delete(connectionId);
    if (members?.size === 0) this.byChannel.delete(channelName);
  }

  /**
   * Route an event to every subscriber of every channel it belongs on.
   *
   * A connection subscribed to two channels that both carry the event gets it
   * once per channel, labelled — the calendar view and the availability view
   * are different consumers even inside one app.
   */
  dispatch(event: RealtimeEvent): void {
    for (const channelName of channelsForEvent(event)) {
      const members = this.byChannel.get(channelName);
      if (!members || members.size === 0) continue;

      const channel = parseChannel(channelName);
      if (!channel) continue;

      const payload = projectForChannel(event, channel.kind);
      // Null means the event says nothing to this audience — an appointment
      // status change that moves no slot should not wake availability watchers.
      if (!payload) continue;

      // Tagged `event` so a client can discriminate on `type` alone.
      // Subscription acks also carry a `channel`, so keying off that would
      // conflate an ack with a delivery.
      const frame = JSON.stringify({
        type: 'event',
        channel: channelName,
        event: payload,
      });

      for (const connectionId of members) {
        const connection = this.connections.get(connectionId);
        if (!connection) continue;
        try {
          connection.socket.send(frame);
          if (event.seq > connection.lastSeq) connection.lastSeq = event.seq;
        } catch {
          // A socket that fails to accept a frame is gone; drop it rather than
          // letting it block delivery to everyone else.
          this.remove(connectionId);
        }
      }
    }
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  channelCount(channelName: string): number {
    return this.byChannel.get(channelName)?.size ?? 0;
  }

  closeAll(): void {
    for (const connection of this.connections.values()) {
      try {
        connection.socket.close(1001, 'server shutting down');
      } catch {
        // Already gone.
      }
    }
    this.connections.clear();
    this.byChannel.clear();
  }
}
