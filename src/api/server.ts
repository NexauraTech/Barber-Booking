/**
 * HTTP API.
 *
 * The API is the enforcement point for the rule that keeps bookings correct:
 * a booking is a COMMAND with a server-decided outcome, never a row a client
 * writes. Clients read availability freely and write nothing directly
 * (docs/research/03-realtime.md §3.4).
 *
 * Built as a factory rather than a module-level app so tests can drive it
 * with `inject()` — no ports, no sockets, no cleanup races.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { attachPrincipal } from './context.js';
import { registerErrorHandler } from './errors.js';
import { authRoutes } from './routes/auth.js';
import { bookingRoutes } from './routes/booking.js';
import { queueRoutes } from './routes/queue.js';
import { shopRoutes } from './routes/shop.js';
import { getPool } from '../db/pool.js';
import { EventBus } from '../realtime/bus.js';
import { Hub } from '../realtime/hub.js';
import { registerRealtime } from '../realtime/socket.js';

export interface ServerOptions {
  logger?: boolean;
  /** Global rate-limit ceiling; per-route limits are tighter. */
  rateLimitMax?: number;
  trustProxy?: boolean;
  /** Off for tests that only exercise HTTP, so no LISTEN connection is held. */
  realtime?: boolean;
}

declare module 'fastify' {
  interface FastifyInstance {
    realtimeHub?: Hub;
    realtimeBus?: EventBus;
  }
}

export async function buildServer(
  options: ServerOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    // Behind a load balancer this is what makes rate limiting see the real
    // client rather than limiting the proxy. Off by default: trusting
    // X-Forwarded-For when nothing sets it lets anyone spoof their address.
    trustProxy: options.trustProxy ?? false,
    bodyLimit: 256 * 1024,
    ajv: { customOptions: { removeAdditional: 'all', coerceTypes: true } },
  });

  await app.register(rateLimit, {
    max: options.rateLimitMax ?? 300,
    timeWindow: '1 minute',
    // Rate limit per authenticated user where we know one, otherwise per IP,
    // so everyone behind one office NAT is not throttled as a single caller.
    keyGenerator: (request) => {
      const auth = request.headers.authorization;
      return auth ? `token:${auth.slice(-32)}` : (request.ip ?? 'unknown');
    },
  });

  registerErrorHandler(app);

  // Identity is attached to every request but required by none: browsing the
  // menu and checking a queue position must work with no account at all.
  app.addHook('onRequest', attachPrincipal);

  app.get('/health', { config: { rateLimit: false } }, async () => {
    await getPool().query('SELECT 1');
    return { status: 'ok' };
  });

  if (options.realtime ?? true) {
    await app.register(websocket, {
      options: { maxPayload: 8 * 1024 },
    });

    const hub = new Hub();
    const bus = new EventBus(undefined, (err) =>
      app.log.error({ err }, 'realtime bus error'),
    );
    hub.attach(bus);
    await bus.start();

    app.realtimeHub = hub;
    app.realtimeBus = bus;

    await registerRealtime(app, { hub });

    // The bus holds a dedicated connection outside the pool, so it has to be
    // closed explicitly or the process will not exit.
    app.addHook('onClose', async () => {
      hub.closeAll();
      hub.detach();
      await bus.stop();
    });
  }

  await app.register(authRoutes);
  await app.register(bookingRoutes);
  await app.register(queueRoutes);
  await app.register(shopRoutes);

  return app;
}

/** Entry point for running the API as a process. */
export async function start(): Promise<void> {
  const app = await buildServer({
    logger: true,
    trustProxy: process.env.TRUST_PROXY === 'true',
  });

  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '0.0.0.0';

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    // Close the server first so in-flight requests finish before the pool
    // goes; the reverse order fails those requests on the way out.
    await app.close();
    const { closePool } = await import('../db/pool.js');
    await closePool();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port, host });
}
