import {
  type Incident,
  type PaymentMethod,
  type Slice,
  slice,
  sliceCovers,
  sliceKey,
  sliceParents,
} from "@kairos/domain";
import { type Addressability, checkoutAddressability } from "./addressability.js";
import type { SteeringConfig } from "./config.js";
import type { RailHealth } from "./health.js";

/**
 * The two things Kairos can do to a checkout.
 *
 * `suppress` removes an instrument through `config.display.hide`. Precise, immediate, and only
 * available for slices Checkout can name — which excludes most UPI volume, because a UPI payment's
 * issuer is the customer's own bank and is not known until after they have chosen.
 *
 * `demote` reorders the method list so healthier rails appear first. It removes nothing, so it can
 * never leave a customer stranded and it carries no abandonment cost, but its effect is bounded by
 * how many people take the top option instead of hunting for their usual one.
 */
export type SteerLever = "suppress" | "demote";

/**
 * What a steer is expected to cost and buy, before it is made.
 *
 * Every field here is reported to the console and written to the ledger, because the interesting
 * question about a steering decision is not whether it fired but what it thought it was buying.
 */
export interface SteerEvaluation {
  readonly slice: Slice;
  readonly lever: SteerLever;
  readonly addressability: Addressability;
  /** Share of *all* traffic that changes rail under this lever. */
  readonly movedShare: number;
  /** Of the total, the share that was on the failing rail and is rescued. */
  readonly rescuedShare: number;
  /** Of the total, the share that was perfectly healthy and is moved anyway. */
  readonly collateralShare: number;
  readonly originRate: number;
  /** Failure rate of the healthy remainder of the same method — what collateral traffic gives up. */
  readonly healthyOriginRate: number;
  readonly destinationRate: number;
  /**
   * Expected change in failure probability per attempt across all traffic. **Negative is good.**
   *
   * The whole decision is this number's sign. Steering has been described as moving customers off a
   * broken rail; arithmetically it is moving customers, some of whom were on a broken rail, onto a
   * rail that may be worse. On Indian traffic the second half is not hypothetical — UPI fails
   * around 2% of the time and cards around 11%, so a method-wide nudge away from UPI can cost more
   * than the outage that prompted it.
   */
  readonly netFailureDelta: number;
  readonly worthDoing: boolean;
  /** Why not, when `worthDoing` is false. Written verbatim into the ledger. */
  readonly declineReason: string | null;
}

/** The remainder of a method once the failing slice is taken out of it. */
function healthyRemainder(health: RailHealth, method: PaymentMethod, failing: Slice) {
  const whole = slice(method);
  let weighted = 0;
  let total = 0;
  for (const o of health.covered(whole)) {
    if (sliceCovers(failing, o.slice)) continue;
    weighted += o.share * o.failureRate;
    total += o.share;
  }
  return { share: total, rate: total === 0 ? 0 : weighted / total };
}

/** Rate a displaced customer lands on, when only one instrument is removed rather than a method. */
function rateExcluding(health: RailHealth, excluded: Slice): number {
  let weighted = 0;
  let total = 0;
  for (const o of health.observations) {
    if (sliceCovers(excluded, o.slice)) continue;
    weighted += o.share * o.failureRate;
    total += o.share;
  }
  return total === 0 ? 0 : weighted / total;
}

/**
 * Price a steer before making it.
 *
 * Suppression and demotion are evaluated with the same arithmetic and differ only in what moves:
 * suppression displaces everyone on the failing instrument and loses some of them entirely;
 * demotion nudges a fraction of the *whole method*, most of whom were perfectly fine.
 */
export function evaluateSteer(
  incident: Incident,
  health: RailHealth,
  config: SteeringConfig,
  target: Slice = incident.slice,
): SteerEvaluation {
  const failing = target;
  const method = failing.method;
  const addressability = checkoutAddressability(failing);
  const lever: SteerLever = addressability === "precise" ? "suppress" : "demote";

  const total = health.totalShare();
  const failingShare = health.shareOf(failing);
  const originRate = health.rateOf(failing);
  const remainder = healthyRemainder(health, method, failing);

  if (total === 0 || failingShare === 0) {
    return {
      slice: failing,
      lever,
      addressability,
      movedShare: 0,
      rescuedShare: 0,
      collateralShare: 0,
      originRate,
      healthyOriginRate: remainder.rate,
      destinationRate: 0,
      netFailureDelta: 0,
      worthDoing: false,
      declineReason: "no observed volume on the failing rail",
    };
  }

  let movedShare: number;
  let rescuedShare: number;
  let collateralShare: number;
  let destinationRate: number;
  let netFailureDelta: number;

  if (lever === "suppress") {
    // Everyone on the instrument is displaced. Some of them leave instead of switching, and a
    // customer who leaves is a total loss where a failed payment is at least retryable — so
    // abandonment enters the arithmetic as a failure with probability one.
    destinationRate = rateExcluding(health, failing);
    const effective =
      config.abandonmentOnSuppress + (1 - config.abandonmentOnSuppress) * destinationRate;

    movedShare = failingShare / total;
    rescuedShare = movedShare;
    collateralShare = 0;
    netFailureDelta = movedShare * (effective - originRate);
  } else {
    // Nothing is removed, so nobody is stranded and nobody abandons. Only the share who take the
    // top option move, and most of them were never in trouble.
    destinationRate = health.destinationRate([method]);
    const methodShare = failingShare + remainder.share;

    movedShare = (config.switchElasticity * methodShare) / total;
    rescuedShare = (config.switchElasticity * failingShare) / total;
    collateralShare = (config.switchElasticity * remainder.share) / total;
    netFailureDelta =
      rescuedShare * (destinationRate - originRate) +
      collateralShare * (destinationRate - remainder.rate);
  }

  const rescueDelta = rescuedShare * (destinationRate - originRate);
  const declineReason = declineFor({
    incident,
    health,
    config,
    lever,
    netFailureDelta,
    failing,
    rescueDelta,
  });

  return {
    slice: failing,
    lever,
    addressability,
    movedShare,
    rescuedShare,
    collateralShare,
    originRate,
    healthyOriginRate: remainder.rate,
    destinationRate,
    netFailureDelta,
    worthDoing: declineReason === null,
    declineReason,
  };
}

interface DeclineInput {
  readonly incident: Incident;
  readonly health: RailHealth;
  readonly config: SteeringConfig;
  readonly lever: SteerLever;
  readonly netFailureDelta: number;
  /** The slice being steered, which may be finer than the incident's own. */
  readonly failing: Slice;
  /** The benefit attributable to customers who were actually on the failing rail. */
  readonly rescueDelta: number;
}

/**
 * The first reason not to steer, or `null`.
 *
 * Ordered so the answer a human gets is the most fundamental one. "The destination rails are no
 * better than the failing one" is a more useful thing to be told than "this would leave one payment
 * method", even when both are true.
 */
function declineFor(input: DeclineInput): string | null {
  const { incident, health, config, lever, netFailureDelta, failing, rescueDelta } = input;

  if (incident.state === "resolved") return "the incident is already resolved";

  if (incident.peakFailureRate <= incident.baselineFailureRate) {
    return "the observed rate never exceeded the baseline";
  }

  // The floor only comes into play when suppressing an instrument would take its whole method with
  // it — removing HDFC netbanking leaves netbanking standing, but removing the only wallet does not.
  if (lever === "suppress" && emptiesTheMethod(health, failing)) {
    const remaining = health.methodsRemaining([failing.method]);
    if (remaining < config.methodFloor) {
      return `suppressing would leave ${remaining} payment methods, floor ${config.methodFloor}`;
    }
  }

  // A steer must be justified by the people it was called for. The collateral term can be positive
  // — a chronically poor method's healthy users may well be better off elsewhere — and letting that
  // alone carry a decision would mean steering on a pretext: demoting a merchant's netbanking for
  // half an hour because one bank had a blip, while the benefit claimed comes almost entirely from
  // the two banks that were working. If the failing rail is not itself worse than the destination,
  // there is nothing here to respond to.
  if (rescueDelta >= 0) {
    return "the failing rail is no worse than where its customers would be moved to";
  }

  if (netFailureDelta > -config.minBenefitPerAttempt) {
    return netFailureDelta >= 0
      ? "the destination rails are no better than the failing one"
      : "the expected improvement is too small to be worth moving customers for";
  }

  return null;
}

/** Whether removing this slice would leave its method with nothing on it. */
function emptiesTheMethod(health: RailHealth, failing: Slice): boolean {
  const whole = health.covered(slice(failing.method));
  return whole.length > 0 && whole.every((o) => sliceCovers(failing, o.slice));
}

/**
 * Every slice inside an incident that could be steered on instead of the incident itself.
 *
 * Includes the incident's own slice, every observed slice it covers, and the intermediate levels
 * between them — so an incident reported on `netbanking` yields `netbanking`, `netbanking/hdfc`,
 * `netbanking/sbi` and so on.
 */
function candidateTargets(incident: Incident, health: RailHealth): readonly Slice[] {
  const seen = new Map<string, Slice>();
  const add = (s: Slice): void => {
    if (sliceCovers(incident.slice, s)) seen.set(sliceKey(s), s);
  };

  add(incident.slice);
  for (const observation of health.covered(incident.slice)) {
    add(observation.slice);
    for (const parent of sliceParents(observation.slice)) add(parent);
  }

  return [...seen.values()];
}

/**
 * Pick the slice actually worth steering, which is not always the one the incident names.
 *
 * The detector deliberately rolls an incident up to the coarsest slice that explains it, because
 * one alarm for an issuer-wide outage is worth more than four hundred correlated ones. That is the
 * right altitude for *telling somebody*, and the wrong one for *acting*: an incident reported on
 * `netbanking` cannot be suppressed precisely, while the `netbanking/hdfc` inside it can, and
 * demoting the whole method to deal with one bank moves several times more traffic than necessary.
 *
 * Rather than guess at attribution, every candidate inside the incident is priced with the same
 * arithmetic and the best one wins. A candidate that is too coarse is penalised automatically,
 * because its collateral term is larger; one that is too fine is penalised because it rescues less.
 * Ties go to the coarser slice, which is the one a human would have named.
 */
export function bestSteer(
  incident: Incident,
  health: RailHealth,
  config: SteeringConfig,
): SteerEvaluation {
  const incidentRate = health.rateOf(incident.slice);
  let best = evaluateSteer(incident, health, config, incident.slice);

  for (const candidate of candidateTargets(incident, health)) {
    if (sliceKey(candidate) === sliceKey(incident.slice)) continue;

    // A refinement has to be at least as bad as the incident it refines. Without this the search
    // will happily nominate a small healthy slice as the target, because doing so sweeps the
    // genuinely broken traffic into the *collateral* term — where it looks like a benefit, since
    // moving customers off a broken rail is exactly what the collateral term prices. The
    // arithmetic comes out right and the reported target is nonsense, which is worse than being
    // wrong: the console would name a rail that is working perfectly as the cause of the incident.
    if (health.rateOf(candidate) < incidentRate) continue;

    const evaluation = evaluateSteer(incident, health, config, candidate);
    if (!evaluation.worthDoing) continue;
    // Materially better, not merely different in the last bits of a float. When a whole method
    // degrades uniformly every candidate inside it scores identically, and without a tolerance the
    // winner is decided by rounding — so the console would name one arbitrary app as the cause of a
    // network-wide event. Ties keep the incident's own slice, which is the one a human would name.
    const better = evaluation.netFailureDelta < best.netFailureDelta - 1e-6;
    if (!best.worthDoing || better) {
      best = evaluation;
    }
  }

  return best;
}
