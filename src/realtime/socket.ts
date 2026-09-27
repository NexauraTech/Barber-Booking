/**
 * The WebSocket endpoint.
 *
 * Deliberately READ-ONLY. A client may subscribe, unsubscribe and ping;
 * nothing else. There is no way to publish an event or write state over this
 * socket, because a booking is a command with a server-decided outcome, not
 * state a client owns (docs/research/03-realtime.md §3.4). The HTTP API is the
 * only write path.
 *
 * Connecting needs no account: a walk-in watching their queue position and a
 * client browsing a day's availability both subscribe anonymously. A token
 * upgrades what they may subscribe to, it is not a gate on connecting.
 */
import type { FastifyInstance } from 'fastify';
// Pulls in @fastify/websocket's declaration merging, which is what makes
// `{ websocket: true }` and the socket handler signature type-check.
import '@fastify/websocket';
import { resolveToken, loadStaffMemberships } from '../auth/service.js';
import { getPool } from '../db/pool.js';
import type { Viewer } from './channels.js';
import type { Hub } from './hub.js';

/** Client -> server messages. The whole protocol. */
type ClientMessage =
  | { action: 'subscribe'; channel: string }
  | { action: 'unsubscribe'; channel: string }
  | { action: 'ping' };

const MAX_CHANNELS_PER_CONNECTION = 20;
const MAX_MESSAGE_BYTES = 4096;

async function resolveViewer(token: string | undefined): Promise<Viewer | null> {
  if (!token) return null;

  const principal = await resolveToken(token);
  if (!principal) return null;

  const memberships = await loadStaffMemberships(principal.userId);
  const { rows } = await getPool().query(
    `SELECT id FROM clients WHERE user_id = $1`,
    [principal.userId],
  );

  return {
    userId: principal.userId,
    memberships,
    clientIds: rows.map((r) => r.id),
  };
}

export interface SocketOptions {
  hub: Hub;
  /** Seconds between server pings; a socket that misses two is dropped. */
  heartbeatSeconds?: number;
}

export async function registerRealtime(
  app: FastifyInstance,
  options: SocketOptions,
): Promise<void> {
  const { hub } = options;
  const heartbeatMs = (options.heartbeatSeconds ?? 30) * 1000;

  app.get('/realtime', { websocket: true }, async (connection, request) => {
    // The browser WebSocket API cannot set headers, so the token may arrive as
    // a query parameter. That puts it in access logs, so it is accepted but
    // the header is preferred and documented as such.
    const query = request.query as { token?: string };
    const header = request.headers.authorization?.split(' ')[1];

    let viewer: Viewer | null = null;
    try {
      viewer = await resolveViewer(header ?? query.token);
    } catch (err) {
      request.log.error({ err }, 'realtime auth failed');
    }

    const socket = {
      send: (data: string) => connection.send(data),
      close: (code?: number, reason?: string) => connection.close(code, reason),
    };

    const registered = hub.add(socket, viewer);

    socket.send(
      JSON.stringify({
        type: 'welcome',
        connectionId: registered.id,
        authenticated: viewer !== null,
        // Told up front so a reconnecting client can compare against the last
        // seq it saw and refetch if it fell behind.
        serverSeq: registered.lastSeq,
      }),
    );

    let alive = true;
    const heartbeat = setInterval(() => {
      if (!alive) {
        hub.remove(registered.id);
        socket.close(1001, 'heartbeat timeout');
        clearInterval(heartbeat);
        return;
      }
      alive = false;
      try {
        connection.ping();
      } catch {
        clearInterval(heartbeat);
      }
    }, heartbeatMs);
    heartbeat.unref?.();

    connection.on('pong', () => {
      alive = true;
    });

    connection.on('message', (raw: Buffer | string) => {
      const text = typeof raw === 'string' ? raw : raw.toString('utf8');

      if (Buffer.byteLength(text, 'utf8') > MAX_MESSAGE_BYTES) {
        socket.send(JSON.stringify({ type: 'error', error: 'MESSAGE_TOO_LARGE' }));
        return;
      }

      let message: ClientMessage;
      try {
        message = JSON.parse(text) as ClientMessage;
      } catch {
        socket.send(JSON.stringify({ type: 'error', error: 'BAD_JSON' }));
        return;
      }

      switch (message.action) {
        case 'ping':
          alive = true;
          socket.send(JSON.stringify({ type: 'pong' }));
          return;

        case 'subscribe': {
          if (typeof message.channel !== 'string') {
            socket.send(JSON.stringify({ type: 'error', error: 'BAD_REQUEST' }));
            return;
          }
          if (registered.channels.size >= MAX_CHANNELS_PER_CONNECTION) {
            socket.send(
              JSON.stringify({ type: 'error', error: 'TOO_MANY_SUBSCRIPTIONS' }),
            );
            return;
          }

          const result = hub.subscribe(registered.id, message.channel);
          if (result.ok) {
            socket.send(
              JSON.stringify({ type: 'subscribed', channel: message.channel }),
            );
          } else {
            socket.send(
              JSON.stringify({
                type: 'error',
                // An unparseable name and an unauthorised one are reported
                // the same way, so probing reveals nothing about what exists.
                error: result.reason === 'invalid' ? 'INVALID_CHANNEL' : 'FORBIDDEN',
                channel: message.channel,
              }),
            );
          }
          return;
        }

        case 'unsubscribe':
          if (typeof message.channel === 'string') {
            hub.unsubscribe(registered.id, message.channel);
            socket.send(
              JSON.stringify({ type: 'unsubscribed', channel: message.channel }),
            );
          }
          return;

        default:
          socket.send(JSON.stringify({ type: 'error', error: 'UNKNOWN_ACTION' }));
      }
    });

    connection.on('close', () => {
      clearInterval(heartbeat);
      hub.remove(registered.id);
    });

    connection.on('error', () => {
      clearInterval(heartbeat);
      hub.remove(registered.id);
    });
  });
}
