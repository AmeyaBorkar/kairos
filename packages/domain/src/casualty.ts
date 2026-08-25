import { type ActionKind, isContact } from "./action.js";
import type { CasualtyStatus } from "./admission.js";
import type { FailureDetail, RecoverabilityClass } from "./attempt.js";
import { DomainError } from "./brand.js";
import type { AttemptId, CasualtyId, CustomerRef, OrderId } from "./identifiers.js";
import type { Paise } from "./money.js";
import type { Slice } from "./slice.js";

/**
 * How the money came to be missing.
 *
 * Three doors into the same queue. They differ in exactly one respect that matters downstream: a
 * failed payment carries a {@link FailureDetail} the classifier can read, and the other two do not.
 * Keeping them in one enum rather than one queue each is what lets a single budget, a single
 * contact cap, and a single stopping rule govern all of them — a merchant does not want three
 * systems each independently certain it is allowed to send one more message.
 *
 * Only `payment-failed` is wired to an intake in this phase. The other two are here because the
 * classifier has to answer for them and would otherwise crash on a casualty with no failure to
 * classify, which is a real branch rather than a speculative one.
 */
export const CASUALTY_KINDS = ["payment-failed", "checkout-abandoned", "invoice-overdue"] as const;

export type CasualtyKind = (typeof CASUALTY_KINDS)[number];

/**
 * Whether this payment can be retried without the customer being present.
 *
 * The distinction the recovery arm turns on, and the one most dunning literature quietly assumes
 * away. A card token with standing consent, a UPI Autopay mandate, or an e-mandate can be charged
 * again by a server with nobody watching. A one-off checkout payment cannot: UPI needs a PIN, a
 * card needs an OTP, netbanking needs a login. "Retrying" those means asking the customer to come
 * back, which means sending them something, which costs money, burns a contact allowance, and can
 * annoy a person who was going to return on their own.
 *
 * So `requires-customer` does not merely make a retry more expensive. It removes the retry action
 * entirely and replaces it with a contact, and no amount of knowing that the rail has healed
 * changes that. See
 * {@link https://github.com/AmeyaBorkar/kairos/blob/main/docs/decisions/0004-a-retry-is-only-free-when-the-customer-is-not-needed.md | ADR 0004}.
 */
export type RetryCapability = "autonomous" | "requires-customer";

/** What a single recovery attempt did. */
export const RECOVERY_OUTCOMES = [
  /** The money came in. Terminal, and the only outcome anyone wanted. */
  "recovered",
  /** Charged again and declined for a reason that could differ next time. */
  "declined-soft",
  /** Charged again and declined for a reason that will not differ next time. */
  "declined-hard",
  /** A message reached the customer. Says nothing about whether they will pay. */
  "delivered",
  /** A message could not be sent: dead number, bounced address, opted out at the carrier. */
  "undeliverable",
] as const;

export type RecoveryOutcome = (typeof RECOVERY_OUTCOMES)[number];

/**
 * One thing Kairos did about one casualty.
 *
 * Recorded on the casualty rather than derived from the ledger because the decision path needs it
 * synchronously — the ladder position, the consecutive-decline count, and whether this exact action
 * has already been tried all come from here. The ledger remains the authority for *what happened*;
 * this is the working copy the next decision reads.
 */
export interface RecoveryAttempt {
  readonly kind: ActionKind;
  readonly at: number;
  readonly outcome: RecoveryOutcome;
  /** What it actually cost, once known. Reserved cost lives in Terminus, not here. */
  readonly costPaise: Paise;
  /** The gateway or provider's own id, so a record can be reconciled against their books. */
  readonly externalRef: string | null;
}

/**
 * A payment that did not happen, queued for recovery.
 *
 * Immutable. Every transition produces a new casualty through {@link applyOutcome}, so the sequence
 * of states a casualty passed through is reconstructible and a decision made at any point in it can
 * be replayed exactly (P4).
 */
export interface Casualty {
  readonly id: CasualtyId;
  readonly kind: CasualtyKind;
  readonly customer: CustomerRef;
  readonly orderId: OrderId;
  /** The failed attempt this came from, when there was one. */
  readonly attemptId: AttemptId | null;
  /** Which rail it died on. Ties the casualty to the incident that may explain it. */
  readonly slice: Slice;
  readonly amount: Paise;
  /** Razorpay's error triple, or `null` for kinds that have no failure to describe. */
  readonly failure: FailureDetail | null;
  readonly retry: RetryCapability;
  /** When the money went missing. Every schedule is computed forward from here. */
  readonly occurredAt: number;
  /** What the stopping rules see. Kept current by {@link applyOutcome}. */
  readonly status: CasualtyStatus;
  readonly attempts: readonly RecoveryAttempt[];
}

/**
 * Open a casualty in its initial state.
 *
 * The recoverability class is supplied rather than inferred, because classification is a decision
 * with its own rule table, its own residual path, and its own audit record — burying it in a
 * constructor would put a money decision somewhere nobody thinks to look.
 */
export function openCasualty(
  fields: Omit<Casualty, "status" | "attempts">,
  recoverability: RecoverabilityClass,
): Casualty {
  if (fields.amount <= 0) {
    throw new DomainError(
      "casualty.amount",
      `expected a positive amount, received ${fields.amount}`,
    );
  }
  if (fields.kind === "payment-failed" && fields.failure === null) {
    throw new DomainError(
      "casualty.failure",
      "a failed payment must carry the failure that ended it",
    );
  }
  return {
    ...fields,
    status: {
      recovered: false,
      optedOut: false,
      disputed: false,
      consecutiveHardDeclines: 0,
      recoverability,
    },
    attempts: [],
  };
}

/**
 * Fold one attempt's outcome into the casualty.
 *
 * The consecutive-decline counter resets on anything that is not a hard decline, including a
 * delivered message. That is deliberate and it is a real loosening: three hard declines followed by
 * an SMS followed by three more hard declines is six declines and only ever three in a row, so the
 * stopping rule sees a counter that never reaches its limit. The alternative — counting declines
 * across intervening contacts — stops chasing a customer whose card failed three times in an outage
 * and who would have paid the moment it ended.
 *
 * Neither is obviously right. The bound that makes the choice safe is elsewhere: the contact cap
 * limits messages per customer regardless of how the counter moves, and the budget limits spend
 * regardless of both. This counter decides when to give up on a *reason*, not when to stop
 * spending.
 */
export function applyOutcome(casualty: Casualty, attempt: RecoveryAttempt): Casualty {
  const hard = attempt.outcome === "declined-hard";
  return {
    ...casualty,
    status: {
      ...casualty.status,
      recovered: casualty.status.recovered || attempt.outcome === "recovered",
      consecutiveHardDeclines: hard ? casualty.status.consecutiveHardDeclines + 1 : 0,
    },
    attempts: [...casualty.attempts, attempt],
  };
}

/** Mark a casualty recovered by something Kairos did not do — the customer simply came back. */
export function markRecovered(casualty: Casualty): Casualty {
  return { ...casualty, status: { ...casualty.status, recovered: true } };
}

/** Record that this customer has asked not to be contacted. Terminal for every contact action. */
export function markOptedOut(casualty: Casualty): Casualty {
  return { ...casualty, status: { ...casualty.status, optedOut: true } };
}

/** Record that a dispute or chargeback is open. Chasing during one is how a complaint becomes a fine. */
export function markDisputed(casualty: Casualty): Casualty {
  return { ...casualty, status: { ...casualty.status, disputed: true } };
}

/** How many contacts of any kind this casualty has already generated. */
export function contactsSent(casualty: Casualty): number {
  return casualty.attempts.filter((a) => a.outcome !== "undeliverable" && isContact(a.kind)).length;
}

/** How many times this casualty has been charged again. */
export function retriesMade(casualty: Casualty): number {
  return casualty.attempts.filter((a) => a.kind === "retry").length;
}

/** Whether this exact action has already been tried, successfully dispatched or not. */
export function hasTried(casualty: Casualty, kind: ActionKind): boolean {
  return casualty.attempts.some((a) => a.kind === kind);
}

/** When Kairos last did anything about this casualty, or `null` if it has never acted. */
export function lastActedAt(casualty: Casualty): number | null {
  const last = casualty.attempts.at(-1);
  return last?.at ?? null;
}
