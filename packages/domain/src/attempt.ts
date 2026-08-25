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
  /**
   * Nothing is broken and nothing needs fixing — the customer simply has to try again.
   *
   * Not in the original design's five classes, and added because building the rule table showed
   * that none of them fit a bucket this large. A cancelled collect request, an abandoned bank page,
   * a mistyped UPI PIN and a wrong OTP are together the majority of failures on a *healthy* rail —
   * 38% of netbanking failures and 34% of UPI failures in the modelled mix — and every existing
   * class describes them wrongly. `transient` and `timed` invite a retry that cannot work, because
   * nothing was broken and nothing will change on its own. `customer-action` sends a message
   * telling someone to fix a card that is fine. `dead` refuses to chase them at all, which
   * contradicts treating an abandoned checkout as a casualty in the first place.
   *
   * `unknown` happens to prescribe the right treatment and the wrong reason, and that is not a
   * naming quibble: the two would share a calibration cell, pooling a customer who nearly paid with
   * a residual nobody could classify.
   *
   * The pairing with `customer-action` is the point. Both need the customer; they differ in whether
   * the customer has anything to *change* first, and that difference sets the ladder. Someone who
   * must fetch a new card can reasonably be reminded more than once. Someone who decided not to pay
   * should be asked exactly once. See
   * {@link https://github.com/AmeyaBorkar/kairos/blob/main/docs/decisions/0003-a-sixth-recoverability-class-for-the-customer-who-must-simply-try-again.md | ADR 0003}.
   */
  | "customer-retry"
  /** Stolen or blocked card, fraud flag, method not permitted. Stop. Do not chase. */
  | "dead"
  /** Unmapped. One low-cost contact, then stop. */
  | "unknown";

export const RECOVERABILITY_CLASSES: readonly RecoverabilityClass[] = [
  "transient",
  "timed",
  "customer-action",
  "customer-retry",
  "dead",
  "unknown",
];

export function isRecoverabilityClass(value: string): value is RecoverabilityClass {
  return (RECOVERABILITY_CLASSES as readonly string[]).includes(value);
}

/**
 * Classes for which charging the same instrument again can ever succeed.
 *
 * Necessary and not sufficient: a class that permits a retry says only that the *failure* could
 * come out differently. Whether Kairos can actually perform one depends on whether the customer has
 * to be present, which is a property of the payment rather than of the error, and is carried by a
 * casualty's `retry` capability instead.
 */
export function isRetryable(c: RecoverabilityClass): boolean {
  return c === "transient" || c === "timed";
}
