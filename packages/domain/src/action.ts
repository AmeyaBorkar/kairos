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
  /**
   * Asking a language model something.
   *
   * An inference call spends money, so it is an action, so it is admitted against a mandate and
   * reconciled against what the provider says it consumed — exactly like a message. A system whose
   * whole thesis is that no rupee leaves without signed authority cannot have one channel of spend
   * that nobody counts, and "it is only a few cents" is where every unbounded cost begins.
   *
   * Two consequences, and both are the point rather than a side effect. A merchant can switch model
   * use off through `allowedActions` without a deploy, because that is the same lever that governs
   * SMS. And when the model runs on a provider's free tier the call is still priced at the model's
   * published rate: a free tier is a development convenience, and an accounting of zero would be a
   * true statement about this month and a false one about the first month anybody deployed.
   */
  "reason",
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
 * Whether an action is the thing that recovers the money, or an input to deciding how.
 *
 * Every kind but one is the former: a message, a retry, a steer and an escalation are all attempts
 * at a recovery, and each can be weighed against the recovery it is attempting. `reason` is the
 * latter. Asking a model what a failure was does not recover a rupee under any outcome — it changes
 * which message gets sent, and *that* message is weighed on its own merits a moment later.
 *
 * So there is no expected return to put in the numerator, and the honest thing is to say so rather
 * than to invent a plausible one. A caller that had to satisfy the gate would end up attributing a
 * share of a campaign's recovery to one classification call, which is a number nobody could derive
 * and everybody would round upward until it passed.
 */
export function hasExpectedReturn(kind: ActionKind): boolean {
  return kind !== "reason";
}

/**
 * The expected-value test: act only when the probability-weighted return beats the cost.
 *
 * This is where the false-positive cost becomes concrete. Every action taken below this line is
 * measurable waste, and the harness reports it in rupees rather than as a rate.
 *
 * ## What exempting `reason` does and does not remove
 *
 * It removes nothing that bounds money. A model call is still admitted against `allowedActions`,
 * still reserved at `maxActionCostPaise`, still limited by `maxInFlight`, still drawn from the
 * campaign budget, and still stopped by either kill switch. The expected-value gate is not what
 * makes spend finite — the budget is — and Kairos's overspend bound is stated in terms of the
 * budget and the per-action ceiling, neither of which this touches.
 *
 * What it does remove is one check on *waste*, and the gap is worth naming rather than glossing:
 * nothing here stops a caller asking a model about a casualty too small to be worth chasing. That
 * responsibility sits with the caller, because only the caller knows the casualty's value —
 * `refineResidual` consults a model only for failures no rule could name, and the message it
 * informs faces the full gate afterwards. A cheap classification followed by a refused message is
 * the money that can be lost this way, and it is bounded by the same budget as everything else.
 */
export function isWorthDoing(a: ProposedAction): boolean {
  if (!hasExpectedReturn(a.kind)) return true;
  return a.successProbability * a.expectedValue > a.estimatedCost;
}

/** The margin an action clears its cost by. Negative means it should not be taken. */
export function expectedNetValue(a: ProposedAction): number {
  return a.successProbability * a.expectedValue - a.estimatedCost;
}
