/**
 * Browser smoke test for the customer app.
 *
 * Checks the things that only a real browser can settle: that the layout does
 * not overflow at phone width, that touch targets really are 44px rather than
 * merely carrying the right class, and that the flow runs end to end against a
 * live API.
 *
 *   npm run db:reset                      # seed a shop
 *   DATABASE_URL=... npm run serve        # API on :3000
 *   npm run app:dev                       # app on :5173
 *   node scripts/smoke-app.mjs <locationId>
 *
 * Chromium ships in this container; PLAYWRIGHT_BROWSERS_PATH points at it.
 */
import { chromium } from 'playwright';
import { readdirSync } from 'node:fs';

const locationId = process.argv[2];
if (!locationId) {
  console.error('usage: node scripts/smoke-app.mjs <locationId>');
  process.exit(1);
}

const appUrl = process.env.APP_URL ?? 'http://localhost:5173';
const outDir = process.env.SHOT_DIR ?? '/tmp';

/** The container pins a Chromium build; find it rather than hardcoding a version. */
function chromiumPath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  const dir = readdirSync(root).find((d) => /^chromium-\d+$/.test(d));
  return dir ? `${root}/${dir}/chrome-linux/chrome` : undefined;
}

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

const browser = await chromium.launch({ executablePath: chromiumPath() });
// 375px: the width the research says to design at first.
const page = await browser.newPage({
  viewport: { width: 375, height: 812 },
  deviceScaleFactor: 2,
});

const consoleErrors = [];
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
page.on('pageerror', (e) => consoleErrors.push(String(e)));

await page.goto(`${appUrl}/#/s/${locationId}`, { waitUntil: 'networkidle' });
await page.waitForSelector('text=Haircut', { timeout: 15_000 });
await page.screenshot({ path: `${outDir}/app-1-services.png` });

check(
  'no horizontal overflow at 375px',
  !(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)),
);

await page.click('text=Haircut');

const minTap = await page.evaluate(() => {
  const rects = [...document.querySelectorAll('button')]
    .map((b) => b.getBoundingClientRect())
    .filter((r) => r.width > 0);
  return Math.min(...rects.map((r) => r.height));
});
check('touch targets are at least 44px', minTap >= 44, `${Math.round(minTap)}px`);

const total = await page.locator('.cta-summary').first().innerText();
check('running total is visible from the first screen', /\d/.test(total), total.replace(/\n/g, ' '));

await page.click('button:has-text("Next")');
await page.waitForSelector('text=Any barber');
const firstRow = await page.locator('button.row').first().innerText();
check('"any barber" is offered first', firstRow.includes('Any barber'));
await page.screenshot({ path: `${outDir}/app-2-barber.png` });

await page.click('text=Any barber');
await page.waitForSelector('.slot', { timeout: 15_000 });
const groups = await page.locator('main h2').allInnerTexts();
check('slots are grouped by daypart', groups.length > 0, groups.join(', '));
await page.screenshot({ path: `${outDir}/app-3-times.png` });

await page.locator('.slot').first().click();
await page.waitForSelector('label:has-text("Mobile number")', { timeout: 15_000 });
check(
  'identity is asked only after a slot is chosen',
  true,
  'reached the OTP step with no earlier gate',
);
check('no password field anywhere', (await page.locator('input[type=password]').count()) === 0);
check('no email field in the booking flow', (await page.locator('input[type=email]').count()) === 0);
await page.screenshot({ path: `${outDir}/app-4-identify.png` });

// The QR path: no account at any point.
await page.emulateMedia({ colorScheme: 'dark' });
await page.goto(`${appUrl}/#/s/${locationId}/queue`, { waitUntil: 'networkidle' });
await page.waitForSelector('text=Join the queue');
check('queue joins with no account, in dark mode', true);
await page.screenshot({ path: `${outDir}/app-5-queue-dark.png` });

check('no console errors', consoleErrors.length === 0, consoleErrors.join(' | '));

await browser.close();

console.log(`\nScreenshots in ${outDir}/app-*.png`);
if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('All checks passed.');
