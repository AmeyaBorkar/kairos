import {
  type ActionKind,
  type Casualty,
  inHoldout,
  isContact,
  isRetryable,
  mulPaise,
  type Paise,
  type ProposedAction,
  paise,
  stableDraw,
} from "@kairos/domain";
import type { Classification } from "./classify.js";
import type { RecoveryFeatures, RecoveryModel } from "./probability.js";
import { needsCustomer } from "./schedule.js";

/**
 * What one kind of action costs, and what it destroys.
 *
 * The second half is the interesting one. `sendPaise` is what appears on an invoice; `optOutRate`
 * and `optOutCostPaise` are what a message costs a merchant when it lands on somebody who did not
 * want it. Both are needed because an expected-value gate priced only on marginal send cost
 * approves chasing essentially everyone — see {@link RecoveryConfig}.
 */
export interface ActionPrice {
  readonly kind: ActionKind;
  /** Expected money out of the door, in paise. What Terminus reserves against. */
  readonly sendPaise: number;
  /** The most one of these can cost. Must not exceed the mandate's per-action ceiling. */
  readonly worstPaise: number;
  /** Probability that one contact of this kind makes the customer opt out of all future contact. */
  readonly optOutRate: number;
}

export interface RecoveryConfig {
  /** Gross margin on recovered revenue, in `[0, 1]`. What a recovered rupee is actually worth. */
  readonly margin: number;
  /**
   * What losing a customer's consent to be contacted costs, in paise.
   *
   * The lifetime value of every future recovery that will now never happen, and the term that makes
   * the gate a gate. Derived rather than picked: a customer with two failed payments a year at a
   * typical Indian order value, a 30% margin, and a recovery rate around a fifth is worth roughly a
   * hundred and fifty rupees a year in recoveries, so a few years of consent is a couple of hundred
   * rupees. A merchant selling once a decade loses almost nothing; a subscription business loses a
   * great deal, which is why this is a merchant-level number rather than a constant.
   */
  readonly optOutCostPaise: number;
  /**
   * How much more likely each prior contact makes the next one produce an opt-out.
   *
   * The third message annoys more than the first, so the ladder becomes self-limiting through its
   * own economics rather than only through a hard count. At 0.6, a customer who has had two
   * messages carries a little over twice the opt-out risk of one who has had none.
   */
  readonly optOutEscalation: number;
  readonly prices: readonly ActionPrice[];
  /**
   * Fraction of casualties left entirely alone, as a recovery control arm.
   *
   * This costs real recovered revenue and is run anyway, because without it "we recovered 18%" is a
   * number with no denominator. Some of those customers would have come back unprompted, and the
   * only way to know how many is to have a population nobody touched. It answers open question 11.
   */
  readonly controlFraction: number;
  /**
   * How often to try a channel the model does not currently favour, in `[0, 1)`.
   *
   * Without it the cheapest channel wins every cold-start comparison, collects all the evidence, and
   * the others are never observed — a model that is right about the one thing it ever does. The draw
   * is a hash of the casualty rather than a random number, so exploration is reproducible from the
   * ledger and a replayed decision is the same decision (P4). Thompson sampling over the model's own
   * Beta posteriors would be better and is not used for exactly that reason.
   */
  readonly explorationRate: number;
  /** Expected net below which an action is not worth the bookkeeping, in paise. */
  readonly minExpectedNetPaise: number;
}

/** Indian message economics, stated so they can be argued with, and swept in the harness. */
export const DEFAULT_RECOVERY_CONFIG: RecoveryConfig = {
  margin: 0.3,
  optOutCostPaise: 200_00,
  optOutEscalation: 0.6,
  prices: [
    // A failed charge against a token costs no gateway fee — Razorpay bills on capture. One paise
    // rather than zero because a reservation of nothing is not authority, and because a retry is
    // not truly free: repeated declines are visible to an issuer's risk systems.
    { kind: "retry", sendPaise: 1, worstPaise: 1, optOutRate: 0 },
    // Three GSM-7 segments is the worst case, and a message the model writes in Devanagari hits it
    // at 70 characters rather than 160. That asymmetry is why Terminus reserves the worst case.
    { kind: "contact-sms", sendPaise: 20, worstPaise: 60, optOutRate: 0.012 },
    { kind: "contact-whatsapp", sendPaise: 12, worstPaise: 12, optOutRate: 0.009 },
    { kind: "contact-email", sendPaise: 2, worstPaise: 2, optOutRate: 0.003 },
  ],
  controlFraction: 0.1,
  explorationRate: 0.08,
  minExpectedNetPaise: 50,
};

export type Decision =
  | {
      readonly act: true;
      readonly action: ProposedAction;
      readonly probability: number;
      /** Expected value after send cost *and* opt-out cost. The number that decided this. */
      readonly expectedNetPaise: number;
      /** True when this action was chosen to learn about it rather than because it scored best. */
      readonly exploring: boolean;
    }
  | { readonly act: false; readonly reason: string };

interface Priced {
  readonly price: ActionPrice;
  readonly probability: number;
  readonly netPaise: number;
}

/**
 * Choose the action worth taking, or decline and say why.
 *
 * ## Two gates, and why they are not the same gate
 *
 * Terminus also applies an expected-value test, and it is deliberately the weaker of the two. It
 * compares `p x expectedValue` against money that will actually leave the account, because that is
 * what a budget can be reconciled against — a reservation held for a cost nobody ever pays is a
 * campaign that runs out of authority with money still in it.
 *
 * The real economics live here, because the dominant cost of a recovery message is not the twenty
 * paise it costs to send. On Indian message prices and Indian order values, an SMS pays for its own
 * postage on any order above about five rupees, so a gate priced on postage alone approves chasing
 * everybody and is not a gate at all. What actually stops it is the chance of losing the customer's
 * consent — a cost that appears on no invoice, cannot be reserved against, and must not be booked
 * as spend. It is priced here and subtracted here, and Terminus remains the floor that catches a
 * caller which has malfunctioned rather than the arbiter of whether a message is a good idea.
 *
 * ## Retry excludes contact
 *
 * Where the payment can be charged again without the customer, that is the whole decision: nobody
 * is messaged about a payment the system can simply re-run. It costs a paise, disturbs no one, and
 * needs no consent. Where it cannot, no amount of knowing the rail has healed changes anything, and
 * the only lever left is a message.
 */
export function decide(
  casualty: Casualty,
  classification: Classification,
  model: RecoveryModel,
  railHealthy: boolean,
  customerContactsRecent: number,
  config: RecoveryConfig = DEFAULT_RECOVERY_CONFIG,
): Decision {
  if (casualty.status.recovered) return { act: false, reason: "the payment already succeeded" };
  if (classification.recoverability === "dead") {
    return { act: false, reason: `${classification.rule} is not recoverable` };
  }

  if (inHoldout(config.controlFraction, "recovery", casualty.id)) {
    return {
      act: false,
      reason: "held out as a recovery control, so the lift has a denominator",
    };
  }

  const kinds = availableActions(casualty, classification);
  if (kinds.length === 0) {
    return { act: false, reason: "no action available for this casualty" };
  }

  const expectedValue = mulPaise(casualty.amount, config.margin, "expectedValue");
  const priced: Priced[] = [];

  for (const kind of kinds) {
    const price = config.prices.find((p) => p.kind === kind);
    if (price === undefined) continue;

    const probability = model.probability(featuresFor(casualty, classification, kind, railHealthy));
    const nuisance = opportunityCost(price, customerContactsRecent, config);
    const netPaise = probability * expectedValue - price.sendPaise - nuisance;
    priced.push({ price, probability, netPaise });
  }

  const first = priced[0];
  if (first === undefined) {
    return { act: false, reason: "no price is configured for any available action" };
  }

  const viable = priced.filter((p) => p.netPaise > config.minExpectedNetPaise);
  if (viable.length === 0) {
    const best = priced.reduce((a, b) => (b.netPaise > a.netPaise ? b : a), first);
    return {
      act: false,
      reason: `the best available action nets ${Math.round(best.netPaise)} paise, below the ${config.minExpectedNetPaise} paise floor`,
    };
  }

  const chosen = choose(viable, casualty, config);

  return {
    act: true,
    probability: chosen.pick.probability,
    expectedNetPaise: chosen.pick.netPaise,
    exploring: chosen.exploring,
    action: {
      kind: chosen.pick.price.kind,
      customer: casualty.customer,
      casualty: casualty.id,
      incident: null,
      estimatedCost: paise(chosen.pick.price.sendPaise, "estimatedCost"),
      expectedValue,
      successProbability: chosen.pick.probability,
      rationale: rationale(classification, chosen.pick, chosen.exploring),
    },
  };
}

/**
 * The best-scoring action, or a deliberate detour to learn about another one.
 *
 * Exploration only ever chooses among actions that already clear the gate, so learning never costs
 * more than the merchant had already agreed was worth spending.
 */
function choose(
  viable: readonly Priced[],
  casualty: Casualty,
  config: RecoveryConfig,
): { readonly pick: Priced; readonly exploring: boolean } {
  const ranked = [...viable].sort((a, b) => b.netPaise - a.netPaise);
  const best = ranked[0];
  if (best === undefined) throw new Error("unreachable: viable actions cannot be empty");

  if (ranked.length < 2 || config.explorationRate <= 0) return { pick: best, exploring: false };

  const draw = stableDraw("explore", casualty.id);
  if (draw >= config.explorationRate) return { pick: best, exploring: false };

  // Spread the exploration budget evenly across the alternatives rather than always taking the
  // runner-up, which would leave a third channel as unobserved as before.
  const alternatives = ranked.slice(1);
  const index = Math.floor((draw / config.explorationRate) * alternatives.length);
  const pick = alternatives[Math.min(index, alternatives.length - 1)];
  return pick === undefined ? { pick: best, exploring: false } : { pick, exploring: true };
}

/**
 * Which actions are even on the table for this casualty.
 *
 * A silent retry excludes every message, because messaging somebody about a payment the system can
 * re-run itself is spending money and goodwill to accomplish nothing.
 */
function availableActions(
  casualty: Casualty,
  classification: Classification,
): readonly ActionKind[] {
  if (!needsCustomer(casualty, classification) && isRetryable(classification.recoverability)) {
    return ["retry"];
  }
  return ["contact-whatsapp", "contact-sms", "contact-email"];
}

function featuresFor(
  casualty: Casualty,
  classification: Classification,
  action: ActionKind,
  railHealthy: boolean,
): RecoveryFeatures {
  return {
    action,
    recoverability: classification.recoverability,
    confidence: classification.confidence,
    railHealthy,
    attemptOrdinal: casualty.attempts.length,
  };
}

/**
 * The expected value destroyed by sending this message, in paise.
 *
 * `P(opt-out) x what an opt-out costs`, with the probability rising for each message this customer
 * has already had. It is zero for anything that does not reach a person.
 */
function opportunityCost(
  price: ActionPrice,
  contactsRecent: number,
  config: RecoveryConfig,
): number {
  if (!isContact(price.kind)) return 0;
  const escalated = price.optOutRate * (1 + config.optOutEscalation * Math.max(0, contactsRecent));
  return Math.min(1, escalated) * config.optOutCostPaise;
}

function rationale(classification: Classification, pick: Priced, exploring: boolean): string {
  const base = `${classification.rule} (${classification.recoverability}), p=${pick.probability.toFixed(3)}, net ${Math.round(pick.netPaise)} paise`;
  return exploring ? `${base}, exploring this channel` : base;
}

/** The largest a single action can cost, for checking a mandate's ceiling covers the price list. */
export function worstActionCostPaise(config: RecoveryConfig): Paise {
  return paise(Math.max(...config.prices.map((p) => p.worstPaise)), "worstActionCost");
}
