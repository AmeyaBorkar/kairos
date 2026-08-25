import type { CasualtyId, CustomerRef, IncidentId } from "./identifiers.js";
import type { Paise } from "./money.js";

/**
 * Everything Kairos can do that costs money, touches a customer, or changes what a checkout shows.
 *
 * This list is closed on purpose. It is the vocabulary Terminus admits against, and it is the
 * vocabulary a model's output is validated into — a proposal naming anything outside this set is
 * rejected before it reaches the kernel, which is what keeps prompt injection a copy-quality
 * problem rather than a solvency one.
 */
export const ACTION_KINDS = [
  "steer",
  "retry",
  "contact-sms",
  "contact-whatsapp",
  "contact-email",
  "escalate",
] as const;

export type ActionKind = (typeof ACTION_KINDS)[number];

export function isActionKind(value: string): value is ActionKind {
  return (ACTION_KINDS as readonly string[]).includes(value);
}

/** Actions that reach a person and therefore count against a contact cap. */
export function isContact(kind: ActionKind): boolean {
  return kind === "contact-sms" || kind === "contact-whatsapp" || kind === "contact-email";
}

/**
 * A proposed action, before admission.
 *
 * `estimatedCost` is an *estimate* and the type says so. The real cost is only knowable after the
 * fact — an SMS in Devanagari costs three segments where the same sentence in Latin script costs
 * one, and you learn which the model wrote after it has written it. Terminus reserves against this
 * estimate and reconciles against the actual.
 */
export interface ProposedAction {
  readonly kind: ActionKind;
  readonly customer: CustomerRef;
  readonly casualty: CasualtyId | null;
  readonly incident: IncidentId | null;
  readonly estimatedCost: Paise;
  /** Expected recovery if it succeeds — the numerator of the expected-value gate. */
  readonly expectedValue: Paise;
  /** Calibrated probability in [0,1] that this action recovers the money. */
  readonly successProbability: number;
  /** Why this action, in one line. Written to the ledger verbatim. */
  readonly rationale: string;
}

/**
 * The expected-value test: act only when the probability-weighted return beats the cost.
 *
 * This is where the false-positive cost becomes concrete. Every action taken below this line is
 * measurable waste, and the harness reports it in rupees rather than as a rate.
 */
export function isWorthDoing(a: ProposedAction): boolean {
  return a.successProbability * a.expectedValue > a.estimatedCost;
}

/** The margin an action clears its cost by. Negative means it should not be taken. */
export function expectedNetValue(a: ProposedAction): number {
  return a.successProbability * a.expectedValue - a.estimatedCost;
}
