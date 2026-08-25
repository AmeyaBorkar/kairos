import type { RecoverabilityClass } from "./attempt.js";

/**
 * The axes Terminus can refuse on, in the order it evaluates them.
 *
 * Naming the binding axis is what makes a bound explainable rather than merely enforced. "The
 * system declined to message this customer" is an incident report; "declined: contact-cap, this
 * customer had 3 contacts in the last 7 days, cap 3" is an answer. Every admission — allowed or
 * refused — records one of these, so the ledger can be queried for *why* the system did nothing.
 *
 * The order is deliberate and is the order the kernel checks in:
 *
 * 1. `mandate-signature` comes first so that every field read afterwards is trusted data. It is
 *    also free, which means a forged mandate is refused without a single network round trip.
 * 2. `kill-switch` … `action-not-allowed` are absolute and near-free.
 * 3. `stop-rule` and `expected-value` are about this specific casualty being worth chasing.
 * 4. `quiet-hours` is a timing refusal — the same request may succeed later.
 * 5. `budget`, `concurrency` and `contact-cap` are the consuming checks, evaluated last so a
 *    refusal on a cheaper axis never burns a scarce resource.
 * 6. `audit` is the refusal of last resort: if the decision cannot be recorded, it is not taken.
 */
export const BINDING_AXES = [
  "mandate-signature",
  "kill-switch",
  "mandate-validity",
  "action-not-allowed",
  "stop-rule",
  "expected-value",
  "quiet-hours",
  "budget",
  "concurrency",
  "contact-cap",
  "audit",
] as const;

export type BindingAxis = (typeof BINDING_AXES)[number];

export function isBindingAxis(value: string): value is BindingAxis {
  return (BINDING_AXES as readonly string[]).includes(value);
}

/**
 * Why the system stopped chasing a particular casualty, permanently.
 *
 * These are terminal in a way the other axes are not: a `budget` refusal is about this moment, but
 * an `opted-out` refusal is about every moment from now on. Keeping them in one enum means the
 * console can show a casualty's final state without inferring it from an absence of activity.
 */
export const STOP_REASONS = [
  "recovered",
  "opted-out",
  "disputed",
  "hard-declines",
  "dead-class",
] as const;

export type StopReason = (typeof STOP_REASONS)[number];

export function isStopReason(value: string): value is StopReason {
  return (STOP_REASONS as readonly string[]).includes(value);
}

/**
 * Everything the stopping rules need to know about a casualty.
 *
 * Deliberately a plain snapshot rather than a reference to a store: the rules are pure, so a
 * decision can be replayed from the ledger years later by rebuilding this struct, and the answer
 * will be the same one the system gave at the time (P4).
 */
export interface CasualtyStatus {
  /** The money came in. Nothing further is owed and nothing further should be attempted. */
  readonly recovered: boolean;
  /** The customer asked not to be contacted. Overrides every commercial consideration. */
  readonly optedOut: boolean;
  /** A dispute or chargeback is open. Chasing during a dispute is how a complaint becomes a fine. */
  readonly disputed: boolean;
  /** Consecutive hard declines. Past a threshold, further attempts are cost without information. */
  readonly consecutiveHardDeclines: number;
  /** The classification of the failure that created this casualty. */
  readonly recoverability: RecoverabilityClass;
}
