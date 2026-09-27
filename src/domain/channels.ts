/**
 * Channel selection.
 *
 * Channel priority is per-market, not universal: WhatsApp converts far better
 * than SMS across MENA, South Asia, LatAm and much of Africa, while SMS is
 * the default in the US and UK. Push is preferred wherever a device token
 * exists, because SMS is a real per-message cost at scale.
 * See docs/research/03-realtime.md §3.6.
 */

export type NotificationChannel = 'push' | 'sms' | 'whatsapp' | 'email';

export interface ChannelContext {
  /** Device token from a logged-in app install. */
  readonly pushToken?: string | null;
  readonly phone?: string | null;
  readonly email?: string | null;
  /** Client's explicit preference; overrides everything but availability. */
  readonly clientPreferred?: NotificationChannel | null;
  /** The shop's market default. */
  readonly locationPreferred: Exclude<NotificationChannel, 'push'>;
  /** Consent for non-transactional messages. */
  readonly transactionalOptIn?: boolean;
  readonly marketingOptIn?: boolean;
}

export interface ChannelChoice {
  readonly channel: NotificationChannel;
  readonly address: string;
  /** Tried in order if the first send fails. */
  readonly fallbacks: ReadonlyArray<{ channel: NotificationChannel; address: string }>;
}

function addressFor(
  channel: NotificationChannel,
  ctx: ChannelContext,
): string | null {
  switch (channel) {
    case 'push':
      return ctx.pushToken ?? null;
    case 'sms':
    case 'whatsapp':
      return ctx.phone ?? null;
    case 'email':
      return ctx.email ?? null;
  }
}

/**
 * Pick a channel and an ordered fallback chain.
 *
 * Urgent messages skip push-first: a queue call-up that sits in a killed
 * app's notification tray is worse than useless, so they go straight to the
 * messaging channel the client will actually see.
 */
export function chooseChannel(
  ctx: ChannelContext,
  options: { urgent?: boolean; marketing?: boolean } = {},
): ChannelChoice | null {
  if (options.marketing && !ctx.marketingOptIn) return null;
  if (!options.marketing && ctx.transactionalOptIn === false) return null;

  const messaging: NotificationChannel = ctx.clientPreferred ?? ctx.locationPreferred;

  const order: NotificationChannel[] = options.urgent
    ? [messaging, 'push', 'sms', 'whatsapp', 'email']
    : ['push', messaging, 'sms', 'whatsapp', 'email'];

  if (ctx.clientPreferred) {
    // An explicit preference wins outright, not merely as a tie-break.
    order.splice(order.indexOf(ctx.clientPreferred), 1);
    order.unshift(ctx.clientPreferred);
  }

  const resolved: Array<{ channel: NotificationChannel; address: string }> = [];
  const seen = new Set<NotificationChannel>();

  for (const channel of order) {
    if (seen.has(channel)) continue;
    seen.add(channel);
    const address = addressFor(channel, ctx);
    if (address) resolved.push({ channel, address });
  }

  const primary = resolved[0];
  if (!primary) return null;

  return {
    channel: primary.channel,
    address: primary.address,
    fallbacks: resolved.slice(1),
  };
}
