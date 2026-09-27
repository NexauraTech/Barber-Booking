/**
 * API test harness.
 *
 * Drives the real Fastify app with `inject()` — no ports, no sockets, so
 * tests stay fast and cannot collide on a port.
 */
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/api/server.js';
import { getPool } from '../../src/db/pool.js';

export interface ApiClient {
  app: FastifyInstance;
  get(url: string, token?: string): Promise<Response>;
  post(url: string, body?: unknown, token?: string, headers?: Record<string, string>): Promise<Response>;
  del(url: string, token?: string): Promise<Response>;
  /** Sign in as a phone number, creating the user if needed. */
  login(phone: string, name?: string): Promise<string>;
}

export interface Response {
  status: number;
  body: any;
}

export async function makeApi(): Promise<ApiClient> {
  // Generous ceiling so ordinary tests do not trip the limiter; the tests
  // that exercise rate limiting build their own server.
  // Realtime off by default: an HTTP-only test has no use for a dedicated
  // LISTEN connection, and leaving one open slows teardown.
  const app = await buildServer({ rateLimitMax: 10_000, realtime: false });
  await app.ready();

  const call = async (
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    body?: unknown,
    token?: string,
    extra?: Record<string, string>,
  ): Promise<Response> => {
    const response = await app.inject({
      method,
      url,
      ...(body === undefined ? {} : { payload: body as object }),
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...extra,
      },
    });

    let parsed: any = null;
    try {
      parsed = response.body ? JSON.parse(response.body) : null;
    } catch {
      parsed = response.body;
    }
    return { status: response.statusCode, body: parsed };
  };

  return {
    app,
    get: (url, token) => call('GET', url, undefined, token),
    post: (url, body, token, headers) => call('POST', url, body ?? {}, token, headers),
    del: (url, token) => call('DELETE', url, undefined, token),

    async login(phone: string, name?: string): Promise<string> {
      const challenge = await call('POST', '/auth/otp', { phone });
      // The code is never returned by the API unless EXPOSE_OTP is set, so
      // read it out of the database the way a real SMS would deliver it.
      const { rows } = await getPool().query(
        `SELECT payload FROM notifications
          WHERE dedupe_key = $1`,
        [`otp:${challenge.body.challengeId}`],
      );

      const code = rows[0]?.payload?.code ?? (await revealCode(challenge.body.challengeId));
      const verified = await call('POST', '/auth/verify', {
        challengeId: challenge.body.challengeId,
        code,
        name,
      });

      if (verified.status !== 201) {
        throw new Error(`Login failed: ${JSON.stringify(verified.body)}`);
      }
      return verified.body.token;
    },
  };
}

/**
 * Brute-force the six-digit code in tests where no location was supplied and
 * so no notification carried it. Cheap enough at six digits, and it keeps the
 * production path free of a test-only escape hatch.
 */
async function revealCode(challengeId: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  const { rows } = await getPool().query(
    `SELECT code_hash FROM otp_challenges WHERE id = $1`,
    [challengeId],
  );
  const target = rows[0].code_hash;

  for (let i = 0; i < 1_000_000; i++) {
    const candidate = String(i).padStart(6, '0');
    if (createHash('sha256').update(candidate + challengeId).digest('hex') === target) {
      return candidate;
    }
  }
  throw new Error('Could not recover the test OTP');
}

/** Give a user a staff role at a location, for staff-side tests. */
export async function makeStaff(
  userPhone: string,
  locationId: string,
  role: 'owner' | 'manager' | 'front_desk' | 'barber' | 'apprentice',
  displayName = 'Test Staff',
): Promise<string> {
  const pool = getPool();
  const { rows: users } = await pool.query(`SELECT id FROM users WHERE phone = $1`, [
    userPhone,
  ]);
  const userId = users[0].id;

  const { rows } = await pool.query(
    `INSERT INTO staff (user_id, location_id, display_name, role)
     VALUES ($1,$2,$3,$4::staff_role)
     ON CONFLICT (user_id, location_id)
       DO UPDATE SET role = EXCLUDED.role, active = true
     RETURNING id`,
    [userId, locationId, displayName, role],
  );
  return rows[0].id;
}

/** Point an existing staff record at a signed-in user. */
export async function linkStaffToUser(
  staffId: string,
  userPhone: string,
): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query(`SELECT id FROM users WHERE phone = $1`, [userPhone]);
  await pool.query(`UPDATE staff SET user_id = $2 WHERE id = $1`, [staffId, rows[0].id]);
}
