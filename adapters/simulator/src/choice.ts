import type { PaymentMethod, Slice } from "@kairos/domain";
import type { SliceProfile } from "./profiles.js";
import type { Rng } from "./rng.js";

/**
 * The part of a steering plan a customer can actually perceive.
 *
 * Structurally compatible with `SteeringPlan` without importing it, so the simulator does not take
 * a dependency on the policy it is used to evaluate. A model that shares types with the thing it is
 * testing is one refactor away from sharing assumptions with it too.
 */
export interface AppliedPlan {
  readonly suppress: readonly Slice[];
  readonly demote: readonly PaymentMethod[];
}

/**
 * What customers do when a checkout is rearranged.
 *
 * **This is the weakest link in the prevention measurement, and it is a model, not an observation.**
 * Nothing in the simulator can tell you how many people abandon a purchase when their usual payment
 * button disappears — that is a fact about human beings, obtainable only from a live merchant's
 * funnel. Both numbers are therefore inputs to be swept, not constants to be trusted, and the
 * headline lift is reported across their range rather than at one flattering point.
 */
export interface ChoiceModel {
  /** Fraction who take the newly-promoted method instead of hunting for their usual one. */
  readonly switchElasticity: number;
  /** Fraction who leave entirely when their chosen instrument has been removed. */
  readonly abandonmentOnSuppress: number;
}

export interface Choice {
  /** What they actually paid with, or `null` if they gave up. */
  readonly slice: Slice | null;
  readonly preferred: Slice;
  readonly switched: boolean;
  readonly abandoned: boolean;
}

function covers(outer: Slice, inner: Slice): boolean {
  if (outer.method !== inner.method) return false;
  if (outer.issuer !== null && outer.issuer !== inner.issuer) return false;
  if (outer.instrument !== null && outer.instrument !== inner.instrument) return false;
  return true;
}

function isSuppressed(plan: AppliedPlan, slice: Slice): boolean {
  return plan.suppress.some((s) => covers(s, slice));
}

/** Alternatives still on the page, excluding anything suppressed and optionally a whole method. */
function alternatives(
  profiles: readonly SliceProfile[],
  plan: AppliedPlan,
  avoidMethod: PaymentMethod | null,
): readonly SliceProfile[] {
  return profiles.filter(
    (p) => !isSuppressed(plan, p.slice) && (avoidMethod === null || p.slice.method !== avoidMethod),
  );
}

/**
 * Decide what one customer ends up paying with, given the checkout they were shown.
 *
 * The two levers act differently and that asymmetry is the point of modelling this at all.
 * Suppression *removes* the option, so everyone on it is displaced and some fraction leaves.
 * Demotion only *reorders*, so nobody is displaced and nobody leaves — but only the share who take
 * the top option move at all, and they include everyone on the healthy part of the method.
 */
export function chooseUnderPlan(
  rng: Rng,
  preferred: SliceProfile,
  profiles: readonly SliceProfile[],
  plan: AppliedPlan,
  model: ChoiceModel,
): Choice {
  const base = { preferred: preferred.slice };

  if (isSuppressed(plan, preferred.slice)) {
    if (rng.bool(model.abandonmentOnSuppress)) {
      return { ...base, slice: null, switched: false, abandoned: true };
    }
    const options = alternatives(profiles, plan, null);
    if (options.length === 0) {
      // Nothing left to pay with. The method floor exists precisely so this cannot happen; if it
      // ever does, the honest outcome is a lost sale, not a silent fallback to the removed rail.
      return { ...base, slice: null, switched: false, abandoned: true };
    }
    const chosen = rng.pick(options, (p) => p.share);
    return { ...base, slice: chosen.slice, switched: true, abandoned: false };
  }

  if (plan.demote.includes(preferred.slice.method) && rng.bool(model.switchElasticity)) {
    const options = alternatives(profiles, plan, preferred.slice.method);
    if (options.length > 0) {
      const chosen = rng.pick(options, (p) => p.share);
      return { ...base, slice: chosen.slice, switched: true, abandoned: false };
    }
  }

  return { ...base, slice: preferred.slice, switched: false, abandoned: false };
}
