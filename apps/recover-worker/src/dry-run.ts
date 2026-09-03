import { smsCostPaise } from "@kairos/domain";
import type { Gateway, Messenger, RetryResult } from "@kairos/razorpay";
import { DEFAULT_RECOVERY_CONFIG, type RecoveryConfig } from "@kairos/recover";

/**
 * Adapters that decide everything and send nothing.
 *
 * Not a stub, and the distinction matters. Every decision upstream is the real one — the same
 * classification, the same expected-value gate, the same Terminus admission, the same composed
 * text, the same segment count and therefore the same cost booked against the same budget. The only
 * thing that does not happen is the final network call.
 *
 * That makes this genuinely useful rather than a placeholder. A merchant can run Kairos against
 * their own traffic for a week and read exactly what it would have sent, what it would have cost,
 * and what it declined to do, before granting it a sender id. It is also what makes the demo
 * honest: what you watch is the real decision path.
 *
 * A live deployment supplies a gateway that can charge a saved token and a DLT-registered sender.
 * Neither exists in this repository, and pretending otherwise would be the one dishonest thing in
 * the system.
 */

export type DryRunSink = (line: string) => void;

export interface DryRunOptions {
  readonly sink: DryRunSink;
  /**
   * The price list to settle against.
   *
   * In this mode Kairos *is* the provider, so the figure the executor treats as authoritative has
   * to come from somewhere, and the only honest somewhere is the same list the decision was priced
   * against. Anything else would make a dry run's spend disagree with the expected-value gate that
   * authorised it.
   */
  readonly prices?: RecoveryConfig;
  /** Price per SMS segment, in paise. Matches the executor's own figure. */
  readonly smsSegmentPaise?: number;
  /**
   * Whether a dry-run charge reports success.
   *
   * Always false. A dry run that reported recoveries would poison the probability model with
   * outcomes that never happened, and the model is what decides how much to spend later.
   */
  readonly reportRecoveries?: false;
}

export function dryRunGateway(options: DryRunOptions): Gateway {
  return {
    name: "dry-run",
    charge(request) {
      options.sink(
        JSON.stringify({
          would: "charge",
          key: request.idempotencyKey,
          order: request.orderId,
          amountPaise: request.amount,
        }),
      );
      const result: RetryResult = {
        outcome: "declined-soft",
        costPaise: 0,
        externalRef: null,
        failure: null,
      };
      return Promise.resolve(result);
    },
  };
}

export function dryRunMessenger(options: DryRunOptions): Messenger {
  return {
    name: "dry-run",
    send(request) {
      options.sink(
        JSON.stringify({
          would: "send",
          key: request.idempotencyKey,
          channel: request.channel,
          segments: request.segments,
          // The real composed text, because reading it is the point of running in this mode.
          text: request.text,
        }),
      );
      // Reported as delivered, and priced, so the cost is booked and the contact cap consumed
      // exactly as they would be in production. This used to return zero, which made the one
      // number somebody runs a dry run to find out — what the campaign would cost — always
      // nothing, and meant the budget ceiling could never be seen to bind.
      //
      // SMS is priced by segment because that is how it is billed and because a message the model
      // writes in Devanagari hits three segments at seventy characters. Everything else is a flat
      // per-message price, taken from the list the decision was already priced against.
      const config = options.prices ?? DEFAULT_RECOVERY_CONFIG;
      const costPaise =
        request.channel === "contact-sms"
          ? smsCostPaise(request.text, options.smsSegmentPaise ?? 20)
          : (config.prices.find((p) => p.kind === request.channel)?.sendPaise ?? 0);

      return Promise.resolve({ delivered: true, costPaise, externalRef: null });
    },
  };
}
