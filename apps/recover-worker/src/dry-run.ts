import type { Gateway, Messenger, RetryResult } from "@kairos/razorpay";

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
      // Reported as delivered so the cost is booked and the contact cap is consumed exactly as it
      // would be in production. A dry run that spent nothing would understate what the campaign
      // costs, which is the number somebody is running it to find out.
      return Promise.resolve({ delivered: true, costPaise: 0, externalRef: null });
    },
  };
}
