/**
 * Builds a realistic shop in the test database.
 *
 * Sam is a master barber (faster, pricier), Alex is an apprentice (slower).
 * Both work Mon-Sat 09:00-17:00; Sam takes a 13:00-13:30 lunch. The shop has
 * two chairs, so resource capacity is exercised by the fade service.
 */
import { getPool } from '../../src/db/pool.js';

export interface Fixture {
  orgId: string;
  locationId: string;
  samId: string;
  alexId: string;
  clientA: string;
  clientB: string;
  cutId: string;
  beardId: string;
  fadeId: string;
  chairId: string;
  pomadeId: string;
  timezone: string;
}

export async function resetDatabase(): Promise<void> {
  await getPool().query(`
    TRUNCATE auth_sessions, otp_challenges,
             payout_lines, payouts, staff_compensation,
             checkout_tips, checkout_items, checkouts, products, payments,
             notifications, client_contact_preferences,
             appointment_resources, appointment_services, appointments,
             staff_blocks, queue_entries, waitlist_entries,
             client_preferences, clients, staff_services, services,
             service_categories, resource_types, time_off, breaks,
             shift_exceptions, shifts, staff, users, closures,
             opening_hours, locations, organisations
      RESTART IDENTITY CASCADE
  `);
}

export async function createFixture(
  overrides: {
    timezone?: string;
    slotStep?: number;
    pricesIncludeTax?: boolean;
    taxRateBps?: number;
    /** Distinguishes a second shop's people from the first's. */
    phoneSeed?: number;
    /** Open around the clock, for tests that run at the real wall time. */
    alwaysOpen?: boolean;
  } = {},
): Promise<Fixture> {
  const seed = overrides.phoneSeed ?? 0;
  const phone = (n: number) => `+4477009${String(seed).padStart(2, '0')}${String(n).padStart(4, '0')}`;
  const opens = overrides.alwaysOpen ? '00:00' : '09:00';
  const closes = overrides.alwaysOpen ? '24:00' : '17:00';
  const pool = getPool();
  const timezone = overrides.timezone ?? 'Europe/London';

  const org = await pool.query(
    `INSERT INTO organisations (name) VALUES ('Fade Room') RETURNING id`,
  );
  const orgId = org.rows[0].id;

  const location = await pool.query(
    `INSERT INTO locations (org_id, name, timezone, slot_step_minutes,
                            min_lead_minutes, max_horizon_days, hold_ttl_seconds,
                            currency, prices_include_tax, default_tax_rate_bps)
     VALUES ($1, 'Fade Room Soho', $2, $3, 0, 60, 420, 'GBP', $4, $5) RETURNING id`,
    [
      orgId,
      timezone,
      overrides.slotStep ?? 15,
      overrides.pricesIncludeTax ?? false,
      overrides.taxRateBps ?? 0,
    ],
  );
  const locationId = location.rows[0].id;

  // Mon-Sat, or every day when alwaysOpen.
  for (let weekday = 1; weekday <= (overrides.alwaysOpen ? 7 : 6); weekday++) {
    await pool.query(
      `INSERT INTO opening_hours (location_id, weekday, opens_at, closes_at)
       VALUES ($1, $2, $3, $4)`,
      [locationId, weekday, opens, closes],
    );
  }

  const chair = await pool.query(
    `INSERT INTO resource_types (location_id, name, capacity)
     VALUES ($1, 'chair', 2) RETURNING id`,
    [locationId],
  );
  const chairId = chair.rows[0].id;

  const mkStaff = async (phone: string, name: string, tier: string) => {
    const user = await pool.query(
      `INSERT INTO users (phone, name) VALUES ($1, $2) RETURNING id`,
      [phone, name],
    );
    const staff = await pool.query(
      `INSERT INTO staff (user_id, location_id, display_name, tier)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [user.rows[0].id, locationId, name, tier],
    );
    const staffId = staff.rows[0].id;

    for (let weekday = 1; weekday <= (overrides.alwaysOpen ? 7 : 6); weekday++) {
      await pool.query(
        `INSERT INTO shifts (staff_id, weekday, starts_at, ends_at,
                             anchor_date, effective_from)
         VALUES ($1, $2, $3, $4, '2026-01-05', '2026-01-01')`,
        [staffId, weekday, opens, closes],
      );
    }
    return staffId;
  };

  const samId = await mkStaff(phone(1), 'Sam', 'master');
  const alexId = await mkStaff(phone(2), 'Alex', 'apprentice');

  await pool.query(
    `INSERT INTO breaks (staff_id, weekday, starts_at, ends_at)
     SELECT $1, w, '13:00', '13:30' FROM generate_series(1,6) w
      WHERE $2::boolean IS NOT TRUE`,
    [samId, overrides.alwaysOpen ?? false],
  );

  const mkService = async (
    name: string,
    duration: number,
    price: number,
    bufferAfter = 0,
    resourceTypeId: string | null = null,
  ) => {
    const { rows } = await pool.query(
      `INSERT INTO services (location_id, name, duration_minutes, price_cents,
                             buffer_after_minutes, resource_type_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [locationId, name, duration, price, bufferAfter, resourceTypeId],
    );
    return rows[0].id;
  };

  const cutId = await mkService('Haircut', 45, 3500);
  const beardId = await mkService('Beard trim', 20, 1500);
  const fadeId = await mkService('Skin fade', 45, 4000, 10, chairId);

  // Sam is faster and dearer; Alex is slower and cheaper.
  const link = async (staffId: string, serviceId: string, d: number | null, p: number | null) =>
    pool.query(
      `INSERT INTO staff_services (staff_id, service_id, duration_minutes, price_cents)
       VALUES ($1,$2,$3,$4)`,
      [staffId, serviceId, d, p],
    );

  await link(samId, cutId, 35, 4500);
  await link(samId, beardId, 15, 2000);
  await link(samId, fadeId, 35, 5000);
  await link(alexId, cutId, 55, 2500);
  await link(alexId, beardId, 25, 1200);
  await link(alexId, fadeId, 55, 3000);

  const pomade = await pool.query(
    `INSERT INTO products (location_id, name, sku, price_cents, cost_cents,
                           stock_quantity)
     VALUES ($1, 'Matte pomade', 'POM-1', 1500, 600, 10) RETURNING id`,
    [locationId],
  );

  const mkClient = async (name: string, phone: string) => {
    const { rows } = await getPool().query(
      `INSERT INTO clients (org_id, name, phone) VALUES ($1,$2,$3) RETURNING id`,
      [orgId, name, phone],
    );
    return rows[0].id;
  };

  return {
    orgId,
    locationId,
    samId,
    alexId,
    clientA: await mkClient('Client A', phone(100)),
    clientB: await mkClient('Client B', phone(101)),
    cutId,
    beardId,
    fadeId,
    chairId,
    pomadeId: pomade.rows[0].id,
    timezone,
  };
}
