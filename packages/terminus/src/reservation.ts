import type { ProposedAction } from "@kairos/domain";
import { criticalFractile, learnedReservation, predictiveReservation } from "throttlekit";

/**
 * How much authority to take for an action whose price is not yet known.
 *
 * Every sizer is safe. None of them can breach the budget, because the ledger admits against
 * whatever number the sizer produces and the bound in `budget.ts` holds for any reservation
 * whatsoever. What a sizer trades is *utilisation against overspend risk*:
 *
 * - reserve the worst case and the overspend bound is exactly zero, but a campaign that mostly
 *   sends one-segment messages sterilises two thirds of its budget on the possibility of three;
 * - reserve the estimate and utilisation is near perfect, but every underestimate is an overrun.
 *
 * The interface exists so the choice is one line in a config and one column in the scorecard,
 * rather than an argument.
 */
export interface Sizer {
  readonly name: string;
  /** Paise to reserve. Callers clamp; see {@link clampReservation}. */
  size(action: ProposedAction): number;
  /** Feed back what the action actually cost, once known. */
  observe(actualPaise: number): void;
}

/**
 * Keep a reservation inside `[1, maxActionCost]`.
 *
 * The floor matters more than it looks: a zero reservation would let actions in flight without
 * consuming any budget, so the only thing standing between the campaign and its worst case would be
 * the in-flight cap. One paise is not much authority, but it is authority, and the ledger's
 * arithmetic needs it to be positive for the bound to mean anything.
 *
 * A value that is not a number at all clamps to the *ceiling*, not the floor. The two directions
 * are not symmetric: over-reserving costs utilisation, under-reserving costs money, so a sizer that
 * has gone wrong must fail toward reserving more (P2). Rounding is upward for the same reason.
 */
export function clampReservation(value: number, maxActionCostPaise: number): number {
  if (Number.isNaN(value)) return maxActionCostPaise;
  const rounded = Math.ceil(value);
  if (rounded < 1) return 1;
  return Math.min(rounded, maxActionCostPaise);
}

/**
 * Reserve the mandate's worst-case action cost, every time.
 *
 * The conservative baseline, and the one to beat. Its overspend bound is provably zero, which makes
 * it the right default for a merchant who would rather under-recover than explain an overspend.
 */
export function worstCaseSizer(maxActionCostPaise: number): Sizer {
  return {
    name: "worst-case",
    size: () => maxActionCostPaise,
    observe: () => {},
  };
}

/**
 * Reserve whatever the action itself estimated.
 *
 * The naive baseline. Included because it is what most systems do implicitly, and because the
 * scorecard needs a row showing what happens when the estimate is trusted: an SMS the model decides
 * to write in Devanagari costs three segments where the estimate assumed one, and the difference is
 * an overrun on every single message.
 */
export function estimateSizer(): Sizer {
  return {
    name: "estimate",
    size: (action) => action.estimatedCost,
    observe: () => {},
  };
}

export interface LearnedSizerOptions {
  /** Penalty per paise reserved and not spent — the cost of a recoverable payment not chased. */
  readonly holdCost: number;
  /** Penalty per paise spent beyond the reservation — the cost of an overrun. */
  readonly overrunCost: number;
  readonly maxActionCostPaise: number;
}

export const DEFAULT_LEARNED_OPTIONS = { holdCost: 1, overrunCost: 4 } as const;

/**
 * Learn the reservation online, from realised costs.
 *
 * ThrottleKit's `learnedReservation` descends onto the critical fractile of the cost distribution —
 * the quantile that minimises the asymmetric newsvendor loss `h·(r−c)₊ + p·(c−r)₊`. With the
 * defaults, an overrun is priced at four times a needless hold, which puts the target at the 80th
 * percentile of observed cost.
 *
 * This is the component §8 flagged as most at risk of being machinery for its own sake, and the
 * measurement harness runs it against {@link worstCaseSizer} on the same batch precisely so that
 * claim can be settled with a number instead of an argument.
 */
export function learnedSizer(options: LearnedSizerOptions): Sizer {
  const policy = learnedReservation({
    holdCost: options.holdCost,
    overrunCost: options.overrunCost,
    maxReservation: options.maxActionCostPaise,
    minReservation: 1,
  });
  return {
    name: "learned",
    size: () => policy.reserve(),
    observe: (actualPaise) => policy.observe(actualPaise),
  };
}

/**
 * Blend the action's own estimate against the learned quantile, weighting by which has been right.
 *
 * The per-action estimate is a genuine signal — a Latin-script template really does cost less than
 * a Devanagari one — but it is a signal that can be adversarially wrong, because a model chooses
 * the script after the estimate is made. ThrottleKit's `predictiveReservation` runs both as experts
 * under Hedge: when estimates track reality the weight moves to the estimate and utilisation
 * approaches the clairvoyant optimum, and when they stop tracking it moves to the robust learner.
 *
 * Safety is unaffected either way. The reservation is a number the ledger admits against, so no
 * prediction, however wrong, can breach the budget — it can only cost utilisation.
 */
export function predictiveSizer(options: LearnedSizerOptions): Sizer {
  const policy = predictiveReservation({
    holdCost: options.holdCost,
    overrunCost: options.overrunCost,
    maxReservation: options.maxActionCostPaise,
    minReservation: 1,
  });
  return {
    name: "predictive",
    size: (action) => policy.reserve(action.estimatedCost),
    observe: (actualPaise) => policy.observe(actualPaise),
  };
}

/** The quantile a given hold/overrun pricing targets. Reported alongside the sizer's results. */
export function targetQuantile(holdCost: number, overrunCost: number): number {
  return criticalFractile(holdCost, overrunCost);
}
