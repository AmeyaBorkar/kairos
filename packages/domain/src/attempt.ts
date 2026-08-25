import type { AttemptId, CustomerRef, OrderId } from "./identifiers.js";
import type { Paise } from "./money.js";
import type { Slice } from "./slice.js";

/** Terminal-ish states Kairos reacts to. Mirrors Razorpay's payment status. */
export type AttemptStatus = "created" | "authorized" | "captured" | "failed" | "refunded";

/**
 * Razorpay's failure taxonomy, carried through verbatim.
 *
 * `source` and `step` together are what make a failure *classifiable*: a bank-sourced timeout at
 * the authorization step is worth retrying when that bank recovers, while a customer-sourced
 * expired card at the same step will never succeed on retry no matter how long you wait. Nearly
 * every naive dunning system throws this away and retries everything on the same schedule.
 *
 * Field values are not enumerated here on purpose — the rule table that maps them to a
 * recoverability class is built against Razorpay's live error-code documentation, and an enum
 * frozen at design time would quietly misclassify anything they add.
 */
export interface FailureDetail {
  /** e.g. `BAD_REQUEST_ERROR`, `GATEWAY_ERROR`. */
  readonly code: string;
  /** Who caused it: `customer`, `business`, `bank`, `gateway`, … */
  readonly source: string;
  /** Where it broke: `payment_initiation`, `payment_authentication`, `payment_authorization`, … */
  readonly step: string;
  /** The specific cause, e.g. `payment_failed_due_to_insufficient_funds`. */
  readonly reason: string;
  /** Human-readable text from the gateway. Untrusted — never interpolated into a prompt unquoted. */
  readonly description: string;
}

/** One observed payment attempt. The atom the detector consumes. */
export interface Attempt {
  readonly id: AttemptId;
  readonly orderId: OrderId;
  readonly customer: CustomerRef;
  readonly amount: Paise;
  readonly slice: Slice;
  readonly status: AttemptStatus;
  /** Present if and only if `status === "failed"`. */
  readonly failure: FailureDetail | null;
  /** Epoch milliseconds. */
  readonly at: number;
}

/** Whether an attempt counts against the failure rate. */
export function isFailure(a: Attempt): boolean {
  return a.status === "failed";
}

/**
 * Whether an attempt should be counted by the detector at all.
 *
 * `created` is excluded: a payment that was initiated and has not yet resolved is not evidence of
 * either success or failure, and counting it as a success would mask an outage while counting it
 * as a failure would invent one.
 */
export function isResolved(a: Attempt): boolean {
  return a.status !== "created";
}

/**
 * How recoverable a failed payment is. Drives whether Kairos retries, contacts, or stops —
 * and stopping is a first-class outcome, not a fallback.
 */
export type RecoverabilityClass =
  /** Issuer down, gateway timeout, network. Retry when the rail heals. */
  | "transient"
  /** Insufficient funds. Retry when there is likely to be balance. */
  | "timed"
  /** Expired card, invalid VPA, revoked mandate. Retrying is pointless; the customer must act. */
  | "customer-action"
  /** Stolen or blocked card, fraud flag, method not permitted. Stop. Do not chase. */
  | "dead"
  /** Unmapped. One low-cost contact, then stop. */
  | "unknown";

export const RECOVERABILITY_CLASSES: readonly RecoverabilityClass[] = [
  "transient",
  "timed",
  "customer-action",
  "dead",
  "unknown",
];

/** Classes for which a bare retry can ever succeed. */
export function isRetryable(c: RecoverabilityClass): boolean {
  return c === "transient" || c === "timed";
}
