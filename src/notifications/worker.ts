/**
 * Outbox worker.
 *
 * Claims due messages, hands them to a transport, records the outcome.
 * Several workers can run at once: `claimDue` uses FOR UPDATE SKIP LOCKED, so
 * no message is handed to two of them.
 *
 * The transport is deliberately injected. Wiring Twilio, the WhatsApp
 * Business API and FCM/APNs is a Phase 3 concern; what matters now is that
 * the delivery contract and the retry semantics are settled.
 */
import { type QueuedNotification, claimDue, markFailed, markSent } from './outbox.js';

export interface Transport {
  send(message: QueuedNotification): Promise<void>;
}

export interface WorkerOptions {
  batchSize?: number;
  maxAttempts?: number;
  now?: () => Date;
}

export interface DrainResult {
  claimed: number;
  sent: number;
  retrying: number;
  failed: number;
}

/**
 * Process one batch. Returns counts so a caller can loop until `claimed` is
 * zero, or run it on a timer.
 */
export async function drainOnce(
  transport: Transport,
  options: WorkerOptions = {},
): Promise<DrainResult> {
  const now = options.now ?? (() => new Date());
  const messages = await claimDue(now(), options.batchSize ?? 100);

  const result: DrainResult = {
    claimed: messages.length,
    sent: 0,
    retrying: 0,
    failed: 0,
  };

  for (const message of messages) {
    try {
      await transport.send(message);
      await markSent(message.id, now());
      result.sent++;
    } catch (err) {
      // One bad message must not stop the batch: a failed reminder for one
      // client should never delay everyone else's.
      const outcome = await markFailed(
        message.id,
        err instanceof Error ? err.message : String(err),
        options.maxAttempts ?? 5,
        now(),
      );
      if (outcome === 'failed') result.failed++;
      else result.retrying++;
    }
  }

  return result;
}

/**
 * A transport that records instead of sending, for development and tests.
 * Swap for the real one without touching any calling code.
 */
export class RecordingTransport implements Transport {
  readonly sent: QueuedNotification[] = [];

  async send(message: QueuedNotification): Promise<void> {
    this.sent.push(message);
  }
}

/** A transport that always fails, for exercising the retry path. */
export class FailingTransport implements Transport {
  constructor(private readonly reason = 'transport unavailable') {}

  async send(): Promise<void> {
    throw new Error(this.reason);
  }
}
