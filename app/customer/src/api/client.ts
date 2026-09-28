/**
 * Typed client for the booking API.
 *
 * Two things this layer is responsible for:
 *
 *   **Idempotency.** Every confirm carries a stable key, generated once per
 *   attempt and REUSED across retries. That is what makes a retry on a flaky
 *   mobile network produce one booking instead of two.
 *
 *   **Turning 409 into something the UI can act on.** Losing a race for a slot
 *   is an expected outcome, not an exception — the caller gets a typed result
 *   and shows "that time just went" in place, with alternatives loaded.
 */
import type { Barber, Service, SlotOption } from '../state/flow.js';

export interface ApiErrorBody {
  error: string;
  message: string;
  details?: Record<string, unknown>;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Someone else got the slot, or the hold lapsed. Recoverable in-flow. */
  get isSlotGone(): boolean {
    return this.code === 'SLOT_TAKEN' || this.code === 'HOLD_EXPIRED';
  }
}

export interface Shop {
  locationId: string;
  name: string;
  address: string | null;
  timezone: string;
  currency: string;
  cancellationWindowHours: number;
  openingHours: Array<{ weekday: number; opens: string; closes: string }>;
  services: Service[];
  staff: Barber[];
}

export interface Availability {
  date: string;
  timezone: string;
  options: SlotOption[];
  staff: Array<{ staffId: string; durationMinutes: number }>;
}

export interface Booking {
  appointmentId: string;
  locationId: string;
  locationName: string;
  address: string | null;
  timezone: string;
  staffId: string;
  staffName: string;
  startsAt: string;
  endsAt: string;
  status: string;
}

export interface QueueStatus {
  status: string;
  position: number | null;
  waitMinutes: { from: number; to: number } | null;
}

const TOKEN_KEY = 'barber.token';

export class BookingApi {
  private token: string | null = null;

  constructor(private readonly baseUrl = '') {
    // localStorage throws in private mode in some browsers, and the app has to
    // work without it — a signed-out session is a degradation, not a crash.
    try {
      this.token = localStorage.getItem(TOKEN_KEY);
    } catch {
      this.token = null;
    }
  }

  get authenticated(): boolean {
    return this.token !== null;
  }

  private setToken(token: string | null): void {
    this.token = token;
    try {
      if (token) localStorage.setItem(TOKEN_KEY, token);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {
      // In-memory only for this session.
    }
  }

  get bearer(): string | null {
    return this.token;
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...extraHeaders,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    if (response.status === 204) return undefined as T;

    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }

    if (!response.ok) {
      const error = (parsed ?? {}) as ApiErrorBody;

      // An expired or revoked token should drop the session rather than
      // leaving the app in a state where every call fails.
      if (response.status === 401 && this.token) this.setToken(null);

      throw new ApiError(
        response.status,
        error.error ?? 'UNKNOWN',
        error.message ?? `Request failed (${response.status})`,
        error.details,
      );
    }

    return parsed as T;
  }

  // ---- Browsing: no account needed ----

  shop(locationId: string): Promise<Shop> {
    return this.request('GET', `/locations/${locationId}`);
  }

  availability(
    locationId: string,
    serviceIds: readonly string[],
    date: string,
    staffId?: string | null,
  ): Promise<Availability> {
    const params = new URLSearchParams({ serviceIds: serviceIds.join(','), date });
    if (staffId) params.set('staffId', staffId);
    return this.request('GET', `/locations/${locationId}/availability?${params}`);
  }

  // ---- Identity ----

  requestCode(phone: string, locationId?: string): Promise<{ challengeId: string }> {
    return this.request('POST', '/auth/otp', { phone, locationId });
  }

  async verifyCode(
    challengeId: string,
    code: string,
    name?: string,
  ): Promise<{ isNewUser: boolean }> {
    const result = await this.request<{ token: string; isNewUser: boolean }>(
      'POST',
      '/auth/verify',
      { challengeId, code, name },
    );
    this.setToken(result.token);
    return { isNewUser: result.isNewUser };
  }

  signOut(): void {
    this.setToken(null);
  }

  // ---- Booking ----

  hold(params: {
    locationId: string;
    serviceIds: readonly string[];
    start: string;
    staffId?: string | null;
  }): Promise<{
    appointmentId: string;
    staffId: string;
    startsAt: string;
    endsAt: string;
    holdExpiresAt: string | null;
  }> {
    return this.request('POST', '/appointments/hold', {
      locationId: params.locationId,
      serviceIds: params.serviceIds,
      start: params.start,
      staffId: params.staffId ?? undefined,
    });
  }

  /**
   * Confirm a held slot.
   *
   * `idempotencyKey` must be generated once per booking ATTEMPT and reused on
   * every retry of that attempt. Generating a fresh one per call would defeat
   * the protection entirely.
   */
  confirm(
    appointmentId: string,
    idempotencyKey: string,
    notes?: string,
  ): Promise<{
    appointmentId: string;
    status: string;
    startsAt: string;
    policy: { summary?: string; depositCents?: number } | null;
  }> {
    return this.request(
      'POST',
      `/appointments/${appointmentId}/confirm`,
      { notes },
      { 'idempotency-key': idempotencyKey },
    );
  }

  myBookings(upcomingOnly = false): Promise<{ appointments: Booking[] }> {
    return this.request(
      'GET',
      `/appointments${upcomingOnly ? '?upcoming=true' : ''}`,
    );
  }

  cancel(
    appointmentId: string,
    reason?: string,
  ): Promise<{ feeCents: number; refilled: boolean }> {
    return this.request('POST', `/appointments/${appointmentId}/cancel`, { reason });
  }

  // ---- Walk-in queue: no account needed ----

  joinQueue(
    locationId: string,
    params: {
      serviceIds: readonly string[];
      name?: string;
      phone?: string;
      preferredStaffId?: string | null;
    },
  ): Promise<{ queueEntryId: string; publicToken: string }> {
    return this.request('POST', `/locations/${locationId}/queue`, {
      serviceIds: params.serviceIds,
      name: params.name,
      phone: params.phone,
      preferredStaffId: params.preferredStaffId ?? undefined,
    });
  }

  queueStatus(publicToken: string): Promise<QueueStatus> {
    return this.request('GET', `/queue/${publicToken}`);
  }

  leaveQueue(publicToken: string): Promise<void> {
    return this.request('DELETE', `/queue/${publicToken}`);
  }
}

/** A key for one booking attempt, stable across retries of that attempt. */
export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `k-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
