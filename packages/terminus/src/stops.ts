import type { CasualtyStatus, StopReason } from "@kairos/domain";

export interface StopConfig {
  /**
   * Consecutive hard declines after which chasing stops.
   *
   * Hard declines carry information the first time and cost without information after that. Three
   * is a starting value, not a measured one, and it is stated here rather than buried so the number
   * can be argued with.
   */
  readonly maxConsecutiveHardDeclines: number;
}

export const DEFAULT_STOP_CONFIG: StopConfig = { maxConsecutiveHardDeclines: 3 };

/**
 * Whether this casualty should be chased at all, and if not, why not.
 *
 * These are evaluated *inside* admission rather than as a pre-check by each caller. The difference
 * matters: a pre-check is a convention that every future code path has to remember, and the one
 * that forgets is the one that messages a customer who opted out. Putting the rules behind the same
 * gate as the budget means there is one door and it is always locked.
 *
 * Order encodes precedence. `recovered` outranks everything because there is nothing left to chase;
 * `opted-out` and `disputed` outrank the commercial rules because no expected value justifies them.
 */
export function stopReasonFor(status: CasualtyStatus, config: StopConfig): StopReason | null {
  if (status.recovered) return "recovered";
  if (status.optedOut) return "opted-out";
  if (status.disputed) return "disputed";
  if (status.recoverability === "dead") return "dead-class";
  if (status.consecutiveHardDeclines >= config.maxConsecutiveHardDeclines) return "hard-declines";
  return null;
}

/** A casualty with nothing against it — the shape a fresh failure starts in. */
export const CLEAN_STATUS: CasualtyStatus = {
  recovered: false,
  optedOut: false,
  disputed: false,
  consecutiveHardDeclines: 0,
  recoverability: "transient",
};

/** Plain-language rendering, written verbatim into the ledger's reason field. */
export function describeStop(reason: StopReason, config: StopConfig): string {
  switch (reason) {
    case "recovered":
      return "the payment already succeeded";
    case "opted-out":
      return "the customer opted out of contact";
    case "disputed":
      return "a dispute or chargeback is open";
    case "dead-class":
      return "the failure is classified dead and cannot be recovered by retrying";
    case "hard-declines":
      return `${config.maxConsecutiveHardDeclines} consecutive hard declines`;
  }
}
