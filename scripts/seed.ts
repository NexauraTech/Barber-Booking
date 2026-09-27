/**
 * Development seed: one shop, two barbers, three services, two chairs.
 *
 * Reuses the test fixture so the seeded shop and the tested shop are the same
 * shape, and prints a few bookable slots as a smoke test of the engine.
 */
import { DateTime } from 'luxon';
import { closePool } from '../src/db/pool.js';
import { createFixture, resetDatabase } from '../tests/helpers/fixture.js';
import { getAvailability } from '../src/booking/commands.js';

async function main(): Promise<void> {
  await resetDatabase();
  const fx = await createFixture();

  console.log('Seeded:');
  console.log(`  location  ${fx.locationId}  (${fx.timezone})`);
  console.log(`  barbers   Sam ${fx.samId}`);
  console.log(`            Alex ${fx.alexId}`);
  console.log(`  services  Haircut ${fx.cutId}`);
  console.log(`            Beard trim ${fx.beardId}`);
  console.log(`            Skin fade ${fx.fadeId}`);

  // Next Thursday, so the shop is open.
  const date = DateTime.now()
    .setZone(fx.timezone)
    .plus({ days: 1 })
    .toISODate()!;

  const { slots } = await getAvailability({
    locationId: fx.locationId,
    serviceIds: [fx.cutId],
    date,
  });

  console.log(`\nFirst bookable slots for a haircut on ${date}:`);
  for (const slot of slots.slice(0, 6)) {
    const who = slot.staffId === fx.samId ? 'Sam' : 'Alex';
    console.log(
      `  ${DateTime.fromMillis(slot.start, { zone: fx.timezone }).toFormat('HH:mm')}` +
        `  ${who} (${slot.durationMinutes}m)`,
    );
  }
  if (slots.length === 0) console.log('  (shop closed that day)');
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
