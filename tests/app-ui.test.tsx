// @vitest-environment happy-dom
/**
 * Component tests for the customer app.
 *
 * Driven through the DOM with a fake API, so they exercise what a client
 * actually taps rather than the reducer in isolation.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
// The Preact-native testing library, not @testing-library/react: the app
// ships on Preact via compat, and the React version resolves its own copy of
// react-dom through Node, bypassing the bundler alias and mixing two renderers.
import { cleanup, render, screen, waitFor } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { App } from '../app/customer/src/App.js';
import { parseRoute } from '../app/customer/src/App.js';
import type { BookingApi, Shop } from '../app/customer/src/api/client.js';
import { ApiError } from '../app/customer/src/api/client.js';

const LOCATION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const shop: Shop = {
  locationId: LOCATION_ID,
  name: 'Fade Room Soho',
  address: '1 Example Street',
  timezone: 'Europe/London',
  currency: 'GBP',
  cancellationWindowHours: 24,
  openingHours: [{ weekday: 4, opens: '09:00', closes: '17:00' }],
  services: [
    {
      serviceId: 'cut',
      name: 'Haircut',
      durationMinutes: 35,
      priceCents: 4500,
      isAddon: false,
    },
    {
      serviceId: 'beard',
      name: 'Beard trim',
      durationMinutes: 15,
      priceCents: 2000,
      isAddon: true,
    },
  ],
  staff: [
    { staffId: 'sam', name: 'Sam', tier: 'master' },
    { staffId: 'alex', name: 'Alex', tier: 'apprentice' },
  ],
};

/** Slots for "tomorrow", so they are always in the future. */
function slotsFor(date: string) {
  return {
    date,
    timezone: 'Europe/London',
    options: [
      { start: `${date}T08:00:00.000Z`, end: `${date}T08:35:00.000Z`, staffIds: ['sam'] },
      { start: `${date}T08:15:00.000Z`, end: `${date}T08:50:00.000Z`, staffIds: ['sam'] },
      { start: `${date}T13:00:00.000Z`, end: `${date}T13:35:00.000Z`, staffIds: ['sam'] },
    ],
    staff: [{ staffId: 'sam', durationMinutes: 35 }],
  };
}

function fakeApi(overrides: Partial<BookingApi> = {}): BookingApi {
  const api = {
    authenticated: false,
    bearer: null,
    shop: vi.fn().mockResolvedValue(shop),
    availability: vi.fn((_loc: string, _ids: string[], date: string) =>
      Promise.resolve(slotsFor(date)),
    ),
    requestCode: vi.fn().mockResolvedValue({ challengeId: 'chal-1' }),
    verifyCode: vi.fn().mockResolvedValue({ isNewUser: true }),
    signOut: vi.fn(),
    hold: vi.fn((params: { start: string }) =>
      Promise.resolve({
        appointmentId: 'appt-1',
        staffId: 'sam',
        startsAt: params.start,
        endsAt: params.start,
        holdExpiresAt: new Date(Date.now() + 420_000).toISOString(),
      }),
    ),
    confirm: vi.fn().mockResolvedValue({
      appointmentId: 'appt-1',
      status: 'confirmed',
      startsAt: '2026-10-01T08:00:00.000Z',
      policy: { summary: 'Free cancellation up to 24 hours before.' },
    }),
    myBookings: vi.fn().mockResolvedValue({ appointments: [] }),
    cancel: vi.fn().mockResolvedValue({ feeCents: 0, refilled: false }),
    joinQueue: vi
      .fn()
      .mockResolvedValue({ queueEntryId: 'q1', publicToken: 'a'.repeat(32) }),
    queueStatus: vi.fn().mockResolvedValue({
      status: 'waiting',
      position: 2,
      waitMinutes: { from: 15, to: 25 },
    }),
    leaveQueue: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return api as unknown as BookingApi;
}

function mount(api: BookingApi, hash = `#/s/${LOCATION_ID}`) {
  location.hash = hash;
  return render(<App api={api} realtime={null} />);
}

afterEach(() => {
  cleanup();
  location.hash = '';
  try {
    localStorage.clear();
  } catch {
    // Not available in every environment.
  }
});

describe('routing', () => {
  it('parses the shop, queue and bookings links', () => {
    expect(parseRoute(`#/s/${LOCATION_ID}`)).toEqual({
      view: 'shop',
      locationId: LOCATION_ID,
    });
    expect(parseRoute(`#/s/${LOCATION_ID}/queue`)).toEqual({
      view: 'queue',
      locationId: LOCATION_ID,
    });
    expect(parseRoute('#/bookings')).toEqual({ view: 'bookings' });
  });

  it('treats anything else as missing', () => {
    expect(parseRoute('#/nonsense').view).toBe('missing');
    expect(parseRoute('').view).toBe('missing');
  });

  it('tolerates a query string on a deep link', () => {
    // Links arrive with utm tags from Instagram and the like.
    expect(parseRoute(`#/s/${LOCATION_ID}?utm_source=instagram`)).toEqual({
      view: 'shop',
      locationId: LOCATION_ID,
    });
  });
});

describe('browsing without an account', () => {
  it('shows the menu with prices and durations', async () => {
    mount(fakeApi());

    expect(await screen.findByText('Haircut')).toBeTruthy();
    // Prices are visible from the first screen: surprise at checkout is the
    // top complaint in this category.
    expect(screen.getByText('£45')).toBeTruthy();
    expect(screen.getByText('35 min')).toBeTruthy();
  });

  it('separates add-ons from main services', async () => {
    mount(fakeApi());
    expect(await screen.findByText('Add-ons')).toBeTruthy();
    expect(screen.getByText('Beard trim')).toBeTruthy();
  });

  it('never asks for an account before a slot is chosen', async () => {
    const user = userEvent.setup();
    mount(fakeApi());

    await user.click(await screen.findByText('Haircut'));
    await user.click(screen.getByRole('button', { name: /next/i }));

    // Barber screen, not a login wall.
    expect(await screen.findByText('Any barber')).toBeTruthy();
    expect(screen.queryByLabelText(/mobile number/i)).toBeNull();
  });

  it('offers "any barber" first as the fastest path', async () => {
    const user = userEvent.setup();
    mount(fakeApi());

    await user.click(await screen.findByText('Haircut'));
    await user.click(screen.getByRole('button', { name: /next/i }));

    await screen.findByText('Any barber');
    // The first selectable row on the barber screen, in DOM order.
    const rows = Array.from(document.querySelectorAll('button.row'));
    expect(rows[0]?.textContent).toContain('Any barber');
  });
});

describe('the running total', () => {
  it('updates as services are added', async () => {
    const user = userEvent.setup();
    mount(fakeApi());

    // Scoped to the sticky bar: the same price also appears on the service row.
    const total = () => document.querySelector('.cta-summary strong')?.textContent;

    await user.click(await screen.findByText('Haircut'));
    await waitFor(() => expect(total()).toBe('£45'));

    await user.click(screen.getByText('Beard trim'));
    // 4500 + 2000, and the durations sum too.
    await waitFor(() => expect(total()).toBe('£65'));
    expect(document.querySelector('.cta-summary')?.textContent).toContain('50 min');
  });

  it('cannot advance with nothing selected', async () => {
    mount(fakeApi());
    const next = await screen.findByRole('button', { name: /next/i });
    expect((next as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('picking a time', () => {
  const toTimeScreen = async (api: BookingApi) => {
    const user = userEvent.setup();
    mount(api);
    await user.click(await screen.findByText('Haircut'));
    await user.click(screen.getByRole('button', { name: /next/i }));
    await user.click(await screen.findByText('Any barber'));
    return user;
  };

  it('groups slots by daypart', async () => {
    await toTimeScreen(fakeApi());

    expect(await screen.findByText('Morning')).toBeTruthy();
    expect(screen.getByText('Afternoon')).toBeTruthy();
    // No evening slots in the fixture, so no empty heading.
    expect(screen.queryByText('Evening')).toBeNull();
  });

  it('renders times in the shop timezone', async () => {
    await toTimeScreen(fakeApi());
    // 08:00Z is 09:00 in London.
    expect(await screen.findByText('09:00')).toBeTruthy();
    expect(screen.getByText('14:00')).toBeTruthy();
  });

  it('offers other days when a day is empty', async () => {
    const api = fakeApi({
      availability: vi.fn((_l: string, _s: string[], date: string) =>
        Promise.resolve({ ...slotsFor(date), options: [] }),
      ) as never,
    });
    await toTimeScreen(api);

    // Never a dead end: the next days are offered inline.
    expect(await screen.findByText(/Nothing free/)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /^Try / }).length).toBeGreaterThan(0);
  });

  it('shows an error when availability cannot load', async () => {
    const api = fakeApi({
      availability: vi.fn().mockRejectedValue(
        new ApiError(500, 'INTERNAL', 'Something went wrong'),
      ) as never,
    });
    await toTimeScreen(api);
    expect(await screen.findByText(/Something went wrong/)).toBeTruthy();
  });
});

describe('losing a slot to someone else', () => {
  it('returns to the grid naming the lost time, keeping the selection', async () => {
    const api = fakeApi({
      authenticated: true,
      hold: vi
        .fn()
        .mockRejectedValue(
          new ApiError(409, 'SLOT_TAKEN', 'That time was just taken'),
        ) as never,
    });

    const user = userEvent.setup();
    mount(api);
    await user.click(await screen.findByText('Haircut'));
    await user.click(screen.getByRole('button', { name: /next/i }));
    await user.click(await screen.findByText('Any barber'));
    await user.click(await screen.findByText('09:00'));

    // Not an error dialog and not a restart: the notice names the slot and the
    // grid is still there with the services and barber intact.
    expect(await screen.findByText(/was just booked by someone else/)).toBeTruthy();
    // The grid refetches, so wait for it rather than asserting mid-load.
    expect(await screen.findByText('Morning')).toBeTruthy();
    expect(screen.getByText('09:15')).toBeTruthy();
  });
});

describe('the full booking', () => {
  it('holds, confirms and shows the booking', async () => {
    const api = fakeApi({ authenticated: true });
    const user = userEvent.setup();

    mount(api);
    await user.click(await screen.findByText('Haircut'));
    await user.click(screen.getByRole('button', { name: /next/i }));
    await user.click(await screen.findByText('Any barber'));
    await user.click(await screen.findByText('09:00'));

    // The slot is held while the client reads the terms.
    expect(await screen.findByText(/This time is held for you/)).toBeTruthy();
    expect(screen.getByText(/Free cancellation up to 24 hours/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /book it/i }));
    expect(await screen.findByText(/Booked\./)).toBeTruthy();
  });

  it('reuses one idempotency key across retries of an attempt', async () => {
    const confirm = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(500, 'INTERNAL', 'Network hiccup'))
      .mockResolvedValue({
        appointmentId: 'appt-1',
        status: 'confirmed',
        startsAt: '2026-10-01T08:00:00.000Z',
        policy: null,
      });

    const api = fakeApi({ authenticated: true, confirm: confirm as never });
    const user = userEvent.setup();

    mount(api);
    await user.click(await screen.findByText('Haircut'));
    await user.click(screen.getByRole('button', { name: /next/i }));
    await user.click(await screen.findByText('Any barber'));
    await user.click(await screen.findByText('09:00'));

    const book = await screen.findByRole('button', { name: /book it/i });
    await user.click(book);
    await screen.findByText(/Network hiccup/);
    await user.click(screen.getByRole('button', { name: /book it/i }));

    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(2));
    // The same key both times — a fresh one per call would defeat idempotency
    // and could produce two bookings.
    expect(confirm.mock.calls[0]![1]).toBe(confirm.mock.calls[1]![1]);
  });

  it('asks for identity only at the end, for a new client', async () => {
    const api = fakeApi({ authenticated: false });
    const user = userEvent.setup();

    mount(api);
    await user.click(await screen.findByText('Haircut'));
    await user.click(screen.getByRole('button', { name: /next/i }));
    await user.click(await screen.findByText('Any barber'));
    await user.click(await screen.findByText('09:00'));

    expect(await screen.findByLabelText(/mobile number/i)).toBeTruthy();
    // Phone and name only — no email, no password.
    expect(screen.queryByLabelText(/password/i)).toBeNull();
    expect(screen.queryByLabelText(/email/i)).toBeNull();
  });

  it('sends a code and verifies it', async () => {
    const api = fakeApi({ authenticated: false });
    const user = userEvent.setup();

    mount(api);
    await user.click(await screen.findByText('Haircut'));
    await user.click(screen.getByRole('button', { name: /next/i }));
    await user.click(await screen.findByText('Any barber'));
    await user.click(await screen.findByText('09:00'));

    await user.type(await screen.findByLabelText(/mobile number/i), '+447700900300');
    await user.type(screen.getByLabelText(/^name$/i), 'Dave');
    await user.click(screen.getByRole('button', { name: /send code/i }));

    await user.type(await screen.findByLabelText(/six-digit code/i), '123456');
    await user.click(screen.getByRole('button', { name: /^confirm$/i }));

    await waitFor(() => expect(api.verifyCode).toHaveBeenCalled());
  });
});

describe('the walk-in queue', () => {
  it('joins with name and number only', async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    mount(api, `#/s/${LOCATION_ID}/queue`);

    expect(await screen.findByText(/Join the queue at Fade Room Soho/)).toBeTruthy();
    // No account is involved anywhere in this flow.
    expect(screen.queryByLabelText(/six-digit code/i)).toBeNull();

    await user.click(screen.getByText('Haircut'));
    await user.type(screen.getByLabelText(/^name$/i), 'Dave');
    await user.type(screen.getByLabelText(/mobile number/i), '+447700900500');
    await user.click(screen.getByRole('button', { name: /join the queue/i }));

    await waitFor(() => expect(api.joinQueue).toHaveBeenCalled());
  });

  it('shows position and a wait range, never a false precision', async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    mount(api, `#/s/${LOCATION_ID}/queue`);

    await user.click(await screen.findByText('Haircut'));
    await user.type(screen.getByLabelText(/^name$/i), 'Dave');
    await user.type(screen.getByLabelText(/mobile number/i), '+447700900500');
    await user.click(screen.getByRole('button', { name: /join the queue/i }));

    expect(await screen.findByText('2')).toBeTruthy();
    expect(screen.getByText('~15–25 min')).toBeTruthy();
  });

  it('tells a notified client to head back', async () => {
    const api = fakeApi({
      queueStatus: vi.fn().mockResolvedValue({
        status: 'notified',
        position: 1,
        waitMinutes: { from: 0, to: 0 },
      }) as never,
    });

    // A token already stored, as if they had joined earlier and come back.
    localStorage.setItem('barber.queueToken', 'b'.repeat(32));
    mount(api, `#/s/${LOCATION_ID}/queue`);

    expect(await screen.findByText(/nearly up/)).toBeTruthy();
  });
});

describe('mobile-first rules', () => {
  it('gives every tappable control a large enough target', async () => {
    mount(fakeApi());
    await screen.findByText('Haircut');

    // happy-dom does not lay out, so assert the classes that carry the 44px
    // minimum rather than measured geometry.
    const buttons = screen.getAllByRole('button');
    for (const button of buttons) {
      const classes = button.className;
      expect(
        /\b(row|btn|slot|date|back)\b/.test(classes),
        `untargeted button: ${button.textContent}`,
      ).toBe(true);
    }
  });

  it('keeps the primary action reachable in a fixed bar', async () => {
    const { container } = mount(fakeApi());
    await screen.findByText('Haircut');
    expect(container.querySelector('.cta-bar')).toBeTruthy();
  });

  it('shows a skeleton rather than an empty screen while loading', () => {
    const api = fakeApi({ shop: vi.fn(() => new Promise(() => {})) as never });
    const { container } = mount(api);
    expect(container.querySelectorAll('.skeleton').length).toBeGreaterThan(0);
  });

  it('explains a missing deep link rather than showing a blank page', async () => {
    mount(fakeApi(), '#/nonsense');
    expect(await screen.findByText(/Nothing here/)).toBeTruthy();
  });

  it('explains an unknown shop', async () => {
    const api = fakeApi({
      shop: vi.fn().mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'nope')) as never,
    });
    mount(api);
    expect(await screen.findByText(/could not find that shop/i)).toBeTruthy();
  });
});
