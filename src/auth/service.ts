/**
 * Phone-OTP authentication.
 *
 * Codes and tokens are hashed at rest. A leaked database should not hand an
 * attacker live sessions or usable login codes.
 *
 * The OTP is delivered through the notification outbox, so it inherits the
 * same per-market channel selection as everything else — WhatsApp where that
 * is what people read, SMS where it isn't.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../db/pool.js';
import { enqueue } from '../notifications/outbox.js';

type Db = Pick<PoolClient, 'query'>;
const db = (client?: Db): Db => client ?? getPool();

export const OTP_TTL_SECONDS = 300;
export const SESSION_TTL_DAYS = 90;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Constant-time comparison, so a wrong code leaks nothing by timing. */
function safeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Normalise a phone number for lookup.
 *
 * Deliberately conservative: strips spaces, dashes and brackets but does not
 * attempt country-code inference, which needs a real libphonenumber and gets
 * it wrong often enough to merge two people's accounts.
 */
export function normalisePhone(phone: string): string {
  const trimmed = phone.trim().replace(/[\s()\-.]/g, '');
  return trimmed.startsWith('00') ? `+${trimmed.slice(2)}` : trimmed;
}

export interface OtpChallenge {
  challengeId: string;
  expiresAt: Date;
  /** Returned only when the caller is allowed to see it (tests, dev). */
  code?: string;
}

export interface RequestOtpOptions {
  locationId?: string | null;
  /** Expose the code in the response. Never enable outside dev/test. */
  revealCode?: boolean;
  now?: number;
}

/**
 * Issue a login code.
 *
 * Always succeeds for a well-formed number, whether or not an account exists:
 * a different response for a known number turns this into an account-
 * enumeration oracle.
 */
export async function requestOtp(
  phone: string,
  options: RequestOtpOptions = {},
): Promise<OtpChallenge> {
  const now = options.now ?? Date.now();
  const normalised = normalisePhone(phone);
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const expiresAt = new Date(now + OTP_TTL_SECONDS * 1000);

  return withTransaction(async (client) => {
    // Supersede any outstanding code, so only the newest one works.
    await client.query(
      `UPDATE otp_challenges SET consumed_at = $2
        WHERE phone = $1 AND consumed_at IS NULL`,
      [normalised, new Date(now)],
    );

    const { rows } = await client.query(
      `INSERT INTO otp_challenges (phone, code_hash, expires_at)
       VALUES ($1, 'pending', $2) RETURNING id`,
      [normalised, expiresAt],
    );
    const challengeId = rows[0].id;

    // Salt with the challenge id so identical codes hash differently.
    await client.query(`UPDATE otp_challenges SET code_hash = $2 WHERE id = $1`, [
      challengeId,
      sha256(code + challengeId),
    ]);

    if (options.locationId) {
      await enqueue(
        {
          locationId: options.locationId,
          address: normalised,
          channel: 'sms',
          template: 'login_code',
          payload: { code, expiresInSeconds: OTP_TTL_SECONDS },
          scheduledFor: now,
          dedupeKey: `otp:${challengeId}`,
        },
        client,
      );
    }

    return {
      challengeId,
      expiresAt,
      ...(options.revealCode ? { code } : {}),
    };
  });
}

export interface VerifiedSession {
  token: string;
  userId: string;
  expiresAt: Date;
  /** True when this verification created the account. */
  isNewUser: boolean;
}

export class AuthError extends Error {
  constructor(
    readonly code: 'INVALID_CODE' | 'EXPIRED' | 'TOO_MANY_ATTEMPTS',
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

/**
 * Verify a code and issue a session token.
 *
 * Creates the user on first successful verification — there is no separate
 * signup step, because a signup step is where bookings go to die.
 */
export async function verifyOtp(
  challengeId: string,
  code: string,
  options: { name?: string | null; userAgent?: string | null; now?: number } = {},
): Promise<VerifiedSession> {
  const now = options.now ?? Date.now();

  // The attempt is counted in its OWN transaction, which commits before the
  // code is checked. Doing this inside the transaction that later throws on a
  // wrong code would roll the counter back with it — leaving the code
  // brute-forceable for its whole lifetime, since no guess would ever cost
  // anything. The increment must survive the rejection.
  const claim = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM otp_challenges WHERE id = $1 FOR UPDATE`,
      [challengeId],
    );
    const found = rows[0];
    if (!found) return null;

    // Don't spend an attempt on a challenge that is already dead — and say
    // so with a flag rather than a count, because the attempt budget being
    // exhausted and the final allowed attempt both leave attempts == max.
    if (found.consumed_at || new Date(found.expires_at).getTime() <= now) {
      return { challenge: found, lockedOut: false };
    }
    if (found.attempts >= found.max_attempts) {
      return { challenge: found, lockedOut: true };
    }

    await client.query(
      `UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = $1`,
      [challengeId],
    );
    return { challenge: found, lockedOut: false };
  });

  if (!claim) throw new AuthError('INVALID_CODE', 'That code is not valid');
  const { challenge, lockedOut } = claim;

  if (challenge.consumed_at) {
    throw new AuthError('INVALID_CODE', 'That code has already been used');
  }
  if (new Date(challenge.expires_at).getTime() <= now) {
    throw new AuthError('EXPIRED', 'That code has expired');
  }
  if (lockedOut) {
    throw new AuthError('TOO_MANY_ATTEMPTS', 'Too many attempts; request a new code');
  }

  if (!safeEquals(challenge.code_hash, sha256(code + challengeId))) {
    throw new AuthError('INVALID_CODE', 'That code is not valid');
  }

  return withTransaction(async (client) => {
    // Consume it conditionally: if another request got here first, this
    // returns no row and the code is spent, not reusable.
    const { rowCount } = await client.query(
      `UPDATE otp_challenges SET consumed_at = $2
        WHERE id = $1 AND consumed_at IS NULL`,
      [challengeId, new Date(now)],
    );
    if (rowCount === 0) {
      throw new AuthError('INVALID_CODE', 'That code has already been used');
    }

    const existing = await client.query(`SELECT id FROM users WHERE phone = $1`, [
      challenge.phone,
    ]);

    let userId: string;
    let isNewUser = false;

    if (existing.rows[0]) {
      userId = existing.rows[0].id;
    } else {
      const created = await client.query(
        `INSERT INTO users (phone, name) VALUES ($1, $2) RETURNING id`,
        [challenge.phone, options.name?.trim() || 'Guest'],
      );
      userId = created.rows[0].id;
      isNewUser = true;
    }

    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now + SESSION_TTL_DAYS * 86_400_000);

    await client.query(
      `INSERT INTO auth_sessions (user_id, token_hash, expires_at, user_agent)
       VALUES ($1,$2,$3,$4)`,
      [userId, sha256(token), expiresAt, options.userAgent ?? null],
    );

    return { token, userId, expiresAt, isNewUser };
  });
}

export interface Principal {
  userId: string;
  phone: string;
  name: string;
}

/** Resolve a bearer token to a user, or null if it is invalid or expired. */
export async function resolveToken(
  token: string,
  now: number = Date.now(),
): Promise<Principal | null> {
  const { rows } = await getPool().query(
    `UPDATE auth_sessions
        SET last_used_at = $2
      WHERE token_hash = $1
        AND revoked_at IS NULL
        AND expires_at > $2
    RETURNING user_id`,
    [sha256(token), new Date(now)],
  );

  if (!rows[0]) return null;

  const { rows: users } = await getPool().query(
    `SELECT id, phone, name FROM users WHERE id = $1`,
    [rows[0].user_id],
  );
  const user = users[0];
  if (!user) return null;

  return { userId: user.id, phone: user.phone, name: user.name };
}

export async function revokeToken(token: string, now = new Date()): Promise<void> {
  await getPool().query(
    `UPDATE auth_sessions SET revoked_at = $2
      WHERE token_hash = $1 AND revoked_at IS NULL`,
    [sha256(token), now],
  );
}

export interface StaffMembership {
  staffId: string;
  locationId: string;
  role: 'owner' | 'manager' | 'front_desk' | 'barber' | 'apprentice';
}

/** A user's staff roles, used to authorise shop-side endpoints. */
export async function loadStaffMemberships(
  userId: string,
): Promise<StaffMembership[]> {
  const { rows } = await getPool().query(
    `SELECT id, location_id, role FROM staff WHERE user_id = $1 AND active`,
    [userId],
  );
  return rows.map((r) => ({
    staffId: r.id,
    locationId: r.location_id,
    role: r.role,
  }));
}

/**
 * The client record for a user at an organisation, created on demand.
 *
 * A user booking at two different shops is two client records, because the
 * client list belongs to the organisation
 * (docs/research/05-reference-architecture.md §5.5).
 */
export async function ensureClientForUser(
  userId: string,
  orgId: string,
  client?: Db,
): Promise<string> {
  const { rows: users } = await db(client).query(
    `SELECT phone, name, email FROM users WHERE id = $1`,
    [userId],
  );
  const user = users[0];
  if (!user) throw new Error(`Unknown user: ${userId}`);

  const { rows } = await db(client).query(
    `INSERT INTO clients (org_id, user_id, name, phone, email)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (org_id, phone)
       DO UPDATE SET user_id = COALESCE(clients.user_id, EXCLUDED.user_id)
     RETURNING id`,
    [orgId, userId, user.name, user.phone, user.email],
  );
  return rows[0].id;
}

/** Housekeeping for expired codes and sessions. */
export async function purgeExpiredAuth(now = new Date()): Promise<number> {
  const { rowCount } = await getPool().query(
    `DELETE FROM otp_challenges WHERE expires_at < $1 - interval '1 day'`,
    [now],
  );
  await getPool().query(
    `DELETE FROM auth_sessions WHERE expires_at < $1 - interval '30 days'`,
    [now],
  );
  return rowCount ?? 0;
}
