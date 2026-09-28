/**
 * Formatting and slot presentation.
 *
 * Pure, and deliberately built on `Intl` rather than a date library: a date
 * library is 20–70KB on a connection where the research budget is under three
 * seconds to interactive on a mid-range Android. `Intl` is already in the
 * browser and handles locale and timezone correctly.
 *
 * Everything renders in the SHOP's timezone, never the device's. A client
 * booking from another country must not be shown times shifted into their own
 * zone (docs/research/02-scheduling-engine.md §2.6).
 */
import type { SlotOption } from './flow.js';

export function formatMoney(
  cents: number,
  currency: string,
  locale?: string,
): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    // Whole prices are the norm for services; show pennies only when present.
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}

/** Time of day in the shop's timezone, e.g. "09:15". */
export function formatTime(
  instant: string,
  timezone: string,
  locale?: string,
): string {
  return new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: timezone,
  }).format(new Date(instant));
}

/**
 * "Thu 1 Oct" from a local date string.
 *
 * `isoDate` is ALREADY the shop's local calendar date, so it must not be
 * converted through a timezone — doing so shifts the day for any zone far
 * enough from UTC (Pacific/Auckland at UTC+13 renders 2026-10-01 as 2 Oct even
 * when anchored at noon). Formatting in UTC keeps the given date intact.
 *
 * The `timezone` parameter is accepted for call-site symmetry with
 * `formatTime`, which does take an instant and does need it.
 */
export function formatDate(
  isoDate: string,
  _timezone?: string,
  locale?: string,
): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  return new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(date);
}

/** ISO date in a given timezone, for "today" in the shop's terms. */
export function isoDateIn(instant: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: timezone,
  }).formatToParts(new Date(instant));

  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Is the shop's timezone different from the device's?
 *
 * When it is, the UI labels the timezone explicitly — a traveller booking from
 * another country must not have to guess which clock the times are on.
 */
export function timezoneDiffers(timezone: string): boolean {
  try {
    const device = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (device === timezone) return false;
    // Same-offset zones (Europe/London vs Europe/Dublin in winter) do not need
    // a warning, so compare the actual offset rather than the name.
    const now = Date.now();
    return formatTime(new Date(now).toISOString(), timezone) !==
      formatTime(new Date(now).toISOString(), device);
  } catch {
    return false;
  }
}

export type Daypart = 'Morning' | 'Afternoon' | 'Evening';

export interface DaypartGroup {
  daypart: Daypart;
  slots: SlotOption[];
}

function hourIn(instant: string, timezone: string): number {
  return Number(
    new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      hour12: false,
      timeZone: timezone,
    }).format(new Date(instant)),
  );
}

/**
 * Group slots into Morning / Afternoon / Evening.
 *
 * A flat list of thirty times is a wall; three labelled groups is scannable.
 * Empty groups are dropped rather than rendered as blank headings.
 */
export function groupByDaypart(
  slots: readonly SlotOption[],
  timezone: string,
): DaypartGroup[] {
  const buckets: Record<Daypart, SlotOption[]> = {
    Morning: [],
    Afternoon: [],
    Evening: [],
  };

  for (const slot of slots) {
    const hour = hourIn(slot.start, timezone);
    const daypart: Daypart = hour < 12 ? 'Morning' : hour < 17 ? 'Afternoon' : 'Evening';
    buckets[daypart].push(slot);
  }

  return (['Morning', 'Afternoon', 'Evening'] as Daypart[])
    .filter((daypart) => buckets[daypart].length > 0)
    .map((daypart) => ({ daypart, slots: buckets[daypart] }));
}

/**
 * Remove start times the server says are gone, and add back released ones.
 *
 * Applied to realtime `availability.changed` deltas so the grid updates under
 * the user's finger rather than only on a refetch.
 */
export function applySlotDelta(
  slots: readonly SlotOption[],
  delta: { taken?: string[]; released?: string[] },
): SlotOption[] {
  const taken = new Set(delta.taken ?? []);
  const remaining = slots.filter((slot) => !taken.has(slot.start));

  // A released slot is only re-added if it is not already present; the server
  // is the authority on whether it is truly bookable, so this is optimistic
  // only in the direction of showing MORE, which a failed hold corrects.
  const present = new Set(remaining.map((s) => s.start));
  const restored = (delta.released ?? [])
    .filter((start) => !present.has(start))
    .map((start) => ({ start, end: start, staffIds: [] as string[] }));

  return [...remaining, ...restored].sort((a, b) => a.start.localeCompare(b.start));
}

/** "in 4 min 30 s", for the hold countdown. */
export function formatCountdown(msRemaining: number): string {
  if (msRemaining <= 0) return 'expired';
  const total = Math.ceil(msRemaining / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}:${String(seconds).padStart(2, '0')}` : `${seconds}s`;
}

/** "~20–30 min", for a queue wait. Always a range, never a point. */
export function formatWaitRange(
  wait: { from: number; to: number } | null,
): string {
  if (!wait) return 'Wait unknown';
  if (wait.to === 0) return "You're next";
  if (wait.from === wait.to) return `~${wait.to} min`;
  return `~${wait.from}–${wait.to} min`;
}
