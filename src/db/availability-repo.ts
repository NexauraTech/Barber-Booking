/**
 * Loads the facts the availability engine needs, and resolves recurring
 * wall-clock rules into instants.
 *
 * This is the only place that knows both SQL and timezones. The engine in
 * src/domain/availability.ts stays pure and database-free, which is what makes
 * the scheduling rules testable without a running Postgres.
 */
import type { PoolClient } from 'pg';
import { getPool } from './pool.js';
import type { Interval } from '../domain/interval.js';
import { intersect, merge, subtract } from '../domain/interval.js';
import {
  type LocalDate,
  addDays,
  isRotationActive,
  isoWeekday,
  localRangeToInterval,
  resolveInstant,
} from '../domain/localtime.js';
import type {
  AvailabilityQuery,
  ResourceConstraint,
  StaffAvailabilityInput,
} from '../domain/availability.js';

export interface LocationPolicy {
  id: string;
  orgId: string;
  timezone: string;
  slotStepMinutes: number;
  minLeadMinutes: number;
  maxHorizonDays: number;
  holdTtlSeconds: number;
}

export interface ResolvedServices {
  /** Total duration per staff id, after per-barber overrides. */
  durationByStaff: Map<string, number>;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  resourceTypeId: string | null;
  /** Staff able to perform every requested service. */
  eligibleStaffIds: string[];
  serviceNames: Map<string, string>;
}

type Db = Pick<PoolClient, 'query'>;

function db(client?: Db): Db {
  return client ?? getPool();
}

export async function loadLocationPolicy(
  locationId: string,
  client?: Db,
): Promise<LocationPolicy> {
  const { rows } = await db(client).query(
    `SELECT id, org_id, timezone, slot_step_minutes, min_lead_minutes,
            max_horizon_days, hold_ttl_seconds
       FROM locations WHERE id = $1`,
    [locationId],
  );
  const row = rows[0];
  if (!row) throw new Error(`Unknown location: ${locationId}`);

  return {
    id: row.id,
    orgId: row.org_id,
    timezone: row.timezone,
    slotStepMinutes: row.slot_step_minutes,
    minLeadMinutes: row.min_lead_minutes,
    maxHorizonDays: row.max_horizon_days,
    holdTtlSeconds: row.hold_ttl_seconds,
  };
}

/**
 * Shop-level open windows for a date: recurring opening hours, overridden by
 * a dated closure row. A closure with NULL times closes the whole day.
 */
export async function loadOpenWindows(
  location: LocationPolicy,
  date: LocalDate,
  client?: Db,
): Promise<Interval[]> {
  const closure = await db(client).query(
    `SELECT opens_at, closes_at FROM closures
      WHERE location_id = $1 AND on_date = $2`,
    [location.id, date],
  );

  if (closure.rows.length > 0) {
    const row = closure.rows[0];
    if (!row.opens_at || !row.closes_at) return []; // closed all day
    return [localRangeToInterval(date, row.opens_at, row.closes_at, location.timezone)];
  }

  const { rows } = await db(client).query(
    `SELECT opens_at, closes_at FROM opening_hours
      WHERE location_id = $1 AND weekday = $2
      ORDER BY opens_at`,
    [location.id, isoWeekday(date, location.timezone)],
  );

  return merge(
    rows.map((r) => localRangeToInterval(date, r.opens_at, r.closes_at, location.timezone)),
  );
}

/**
 * Resolve requested services against the staff who can perform them,
 * applying per-barber duration overrides.
 *
 * Buffers take the maximum across the requested services: a multi-service
 * booking needs the longest cleanup either service requires, not their sum.
 */
export async function resolveServices(
  locationId: string,
  serviceIds: readonly string[],
  client?: Db,
): Promise<ResolvedServices> {
  if (serviceIds.length === 0) throw new Error('At least one service is required');

  const { rows: services } = await db(client).query(
    `SELECT id, name, duration_minutes, buffer_before_minutes,
            buffer_after_minutes, resource_type_id, online_bookable
       FROM services
      WHERE location_id = $1 AND id = ANY($2::uuid[]) AND active`,
    [locationId, serviceIds],
  );

  if (services.length !== serviceIds.length) {
    throw new Error('One or more services are unknown or inactive');
  }

  const { rows: links } = await db(client).query(
    `SELECT ss.staff_id, ss.service_id, ss.duration_minutes
       FROM staff_services ss
       JOIN staff s ON s.id = ss.staff_id
      WHERE ss.service_id = ANY($1::uuid[]) AND s.active`,
    [serviceIds],
  );

  const defaultDuration = new Map<string, number>(
    services.map((s) => [s.id, s.duration_minutes]),
  );

  // A barber is eligible only if they can perform EVERY requested service.
  const perStaff = new Map<string, Map<string, number>>();
  for (const link of links) {
    const forStaff = perStaff.get(link.staff_id) ?? new Map<string, number>();
    forStaff.set(
      link.service_id,
      link.duration_minutes ?? defaultDuration.get(link.service_id)!,
    );
    perStaff.set(link.staff_id, forStaff);
  }

  const durationByStaff = new Map<string, number>();
  const eligibleStaffIds: string[] = [];

  for (const [staffId, byService] of perStaff) {
    if (byService.size !== serviceIds.length) continue;
    let total = 0;
    for (const id of serviceIds) total += byService.get(id)!;
    durationByStaff.set(staffId, total);
    eligibleStaffIds.push(staffId);
  }

  return {
    durationByStaff,
    bufferBeforeMinutes: Math.max(...services.map((s) => s.buffer_before_minutes)),
    bufferAfterMinutes: Math.max(...services.map((s) => s.buffer_after_minutes)),
    resourceTypeId: services.find((s) => s.resource_type_id)?.resource_type_id ?? null,
    eligibleStaffIds,
    serviceNames: new Map(services.map((s) => [s.id, s.name])),
  };
}

/**
 * A barber's workable windows on a date: the active shift, minus breaks,
 * approved time off and the shop being shut.
 */
async function loadStaffWindows(
  location: LocationPolicy,
  staffId: string,
  date: LocalDate,
  openWindows: readonly Interval[],
  client?: Db,
): Promise<Interval[]> {
  const tz = location.timezone;
  const weekday = isoWeekday(date, tz);

  // A dated exception replaces the recurring pattern entirely.
  const { rows: exceptions } = await db(client).query(
    `SELECT kind, starts_at, ends_at FROM shift_exceptions
      WHERE staff_id = $1 AND on_date = $2`,
    [staffId, date],
  );

  let shiftWindows: Interval[];
  const exception = exceptions[0];

  if (exception) {
    if (exception.kind === 'off') return [];
    shiftWindows = [
      localRangeToInterval(date, exception.starts_at, exception.ends_at, tz),
    ];
  } else {
    const { rows: shifts } = await db(client).query(
      `SELECT starts_at, ends_at, repeat_interval_weeks, anchor_date
         FROM shifts
        WHERE staff_id = $1
          AND weekday = $2
          AND effective_from <= $3
          AND (effective_to IS NULL OR effective_to >= $3)`,
      [staffId, weekday, date],
    );

    shiftWindows = shifts
      .filter((s) =>
        isRotationActive(date, s.anchor_date, s.repeat_interval_weeks, tz),
      )
      .map((s) => localRangeToInterval(date, s.starts_at, s.ends_at, tz));
  }

  if (shiftWindows.length === 0) return [];

  const { rows: breaks } = await db(client).query(
    `SELECT starts_at, ends_at FROM breaks
      WHERE staff_id = $1 AND (weekday = $2 OR on_date = $3)`,
    [staffId, weekday, date],
  );

  const dayStart = resolveInstant(date, '00:00', tz);
  const dayEnd = resolveInstant(addDays(date, 1, tz), '00:00', tz);

  const { rows: timeOff } = await db(client).query(
    `SELECT starts_at, ends_at FROM time_off
      WHERE staff_id = $1 AND status = 'approved'
        AND starts_at < $3 AND ends_at > $2`,
    [staffId, new Date(dayStart), new Date(dayEnd)],
  );

  const unavailable: Interval[] = [
    ...breaks.map((b) => localRangeToInterval(date, b.starts_at, b.ends_at, tz)),
    ...timeOff.map((o) => ({
      start: new Date(o.starts_at).getTime(),
      end: new Date(o.ends_at).getTime(),
    })),
  ];

  return subtract(intersect(shiftWindows, openWindows), unavailable);
}

/**
 * Appointments and manual blocks occupying a barber on a date, already
 * expanded by their own buffers.
 *
 * Reads the `span` column directly — the same buffered interval the database
 * uses for the no-overlap constraint — so the engine and the constraint can
 * never disagree about what is busy.
 *
 * Hold expiry is compared against the CALLER'S clock, not SQL now(). The
 * injected instant is the single source of truth for the whole request;
 * mixing the two makes availability disagree with itself whenever the clock
 * is simulated, which is exactly what a test does.
 */
async function loadStaffBusy(
  staffId: string,
  windows: readonly Interval[],
  now: number,
  client?: Db,
): Promise<{ busy: Interval[]; bookingCount: number }> {
  if (windows.length === 0) return { busy: [], bookingCount: 0 };

  const from = new Date(Math.min(...windows.map((w) => w.start)));
  const to = new Date(Math.max(...windows.map((w) => w.end)));

  const { rows: appts } = await db(client).query(
    `SELECT lower(span) AS starts_at, upper(span) AS ends_at
       FROM appointments
      WHERE staff_id = $1
        AND status IN ('pending','confirmed','in_progress','completed')
        AND (status <> 'pending' OR hold_expires_at > $4)
        AND span && tstzrange($2, $3, '[)')`,
    [staffId, from, to, new Date(now)],
  );

  const { rows: blocks } = await db(client).query(
    `SELECT starts_at, ends_at FROM staff_blocks
      WHERE staff_id = $1 AND starts_at < $3 AND ends_at > $2`,
    [staffId, from, to],
  );

  const toInterval = (r: { starts_at: string; ends_at: string }): Interval => ({
    start: new Date(r.starts_at).getTime(),
    end: new Date(r.ends_at).getTime(),
  });

  return {
    busy: [...appts.map(toInterval), ...blocks.map(toInterval)],
    bookingCount: appts.length,
  };
}

async function loadResourceConstraint(
  resourceTypeId: string | null,
  windows: readonly Interval[],
  now: number,
  client?: Db,
): Promise<ResourceConstraint | null> {
  if (!resourceTypeId || windows.length === 0) return null;

  const { rows: types } = await db(client).query(
    `SELECT capacity FROM resource_types WHERE id = $1`,
    [resourceTypeId],
  );
  const capacity = types[0]?.capacity;
  if (capacity == null) return null;

  const from = new Date(Math.min(...windows.map((w) => w.start)));
  const to = new Date(Math.max(...windows.map((w) => w.end)));

  const { rows } = await db(client).query(
    `SELECT lower(a.span) AS starts_at, upper(a.span) AS ends_at
       FROM appointments a
       JOIN appointment_resources ar ON ar.appointment_id = a.id
      WHERE ar.resource_type_id = $1
        AND a.status IN ('pending','confirmed','in_progress','completed')
        AND (a.status <> 'pending' OR a.hold_expires_at > $4)
        AND a.span && tstzrange($2, $3, '[)')`,
    [resourceTypeId, from, to, new Date(now)],
  );

  return {
    resourceTypeId,
    capacity,
    busy: rows.map((r) => ({
      start: new Date(r.starts_at).getTime(),
      end: new Date(r.ends_at).getTime(),
    })),
  };
}

export interface AvailabilityRequest {
  locationId: string;
  serviceIds: string[];
  date: LocalDate;
  /** Restrict to one barber; omit for "any barber". */
  staffId?: string | null;
  now?: number;
  /** Include barbers with online booking disabled (barber app / front desk). */
  includeOfflineOnly?: boolean;
}

export interface LoadedAvailability {
  location: LocationPolicy;
  services: ResolvedServices;
  query: AvailabilityQuery;
}

/** Assemble everything the engine needs for one (location, date, services). */
export async function loadAvailability(
  request: AvailabilityRequest,
  client?: Db,
): Promise<LoadedAvailability> {
  const location = await loadLocationPolicy(request.locationId, client);
  const services = await resolveServices(request.locationId, request.serviceIds, client);
  const now = request.now ?? Date.now();

  const openWindows = await loadOpenWindows(location, request.date, client);

  let candidateIds = services.eligibleStaffIds;
  if (request.staffId) {
    candidateIds = candidateIds.filter((id) => id === request.staffId);
  }

  const staffInputs: StaffAvailabilityInput[] = [];
  let resource: ResourceConstraint | null = null;
  const allWindows: Interval[] = [];

  if (candidateIds.length > 0 && openWindows.length > 0) {
    const { rows: staffRows } = await db(client).query(
      `SELECT id, accepts_online, accepts_any_barber, max_daily_bookings
         FROM staff
        WHERE id = ANY($1::uuid[]) AND location_id = $2 AND active`,
      [candidateIds, request.locationId],
    );

    for (const row of staffRows) {
      if (!request.includeOfflineOnly && !row.accepts_online) continue;
      // "Any barber" routing is opt-out per barber; naming them explicitly
      // always works.
      if (!request.staffId && !row.accepts_any_barber) continue;

      const windows = await loadStaffWindows(
        location,
        row.id,
        request.date,
        openWindows,
        client,
      );
      if (windows.length === 0) continue;

      const { busy, bookingCount } = await loadStaffBusy(row.id, windows, now, client);
      allWindows.push(...windows);

      staffInputs.push({
        staffId: row.id,
        windows,
        busy,
        durationMinutes: services.durationByStaff.get(row.id)!,
        bufferBeforeMinutes: services.bufferBeforeMinutes,
        bufferAfterMinutes: services.bufferAfterMinutes,
        bookingsToday: bookingCount,
        maxDailyBookings: row.max_daily_bookings,
      });
    }

    resource = await loadResourceConstraint(services.resourceTypeId, allWindows, now, client);
  }

  const horizonEnd = resolveInstant(
    addDays(request.date, 0, location.timezone),
    '00:00',
    location.timezone,
  );

  return {
    location,
    services,
    query: {
      staff: staffInputs,
      slotStepMinutes: location.slotStepMinutes,
      now,
      minLeadMinutes: location.minLeadMinutes,
      horizonEnd:
        horizonEnd > now + location.maxHorizonDays * 86_400_000
          ? now + location.maxHorizonDays * 86_400_000
          : undefined,
      resource,
    },
  };
}
