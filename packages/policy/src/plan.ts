import {
  type CustomerRef,
  type IncidentId,
  type PaymentMethod,
  type Slice,
  sliceCovers,
  sliceKey,
} from "@kairos/domain";
import type { SteeringConfig } from "./config.js";
import type { SteerLever } from "./evaluate.js";
import type { RailHealth } from "./health.js";
import { isHeldOut } from "./holdout.js";

/** One admitted steer, held open by Terminus and expiring unless re-affirmed. */
export interface SteerDirective {
  readonly incident: IncidentId;
  readonly slice: Slice;
  readonly lever: SteerLever;
  /** One line of why, written verbatim into the ledger and shown in the console. */
  readonly reason: string;
  /** When the authority lapses. A steer that is not re-affirmed simply stops. */
  readonly expiresAt: number;
}

/**
 * What one customer's checkout should look like right now.
 *
 * Computed per customer because the holdout is per customer: two people hitting the same checkout
 * during the same outage will see different things, and that difference is the entire measurement.
 */
export interface SteeringPlan {
  readonly issuedAt: number;
  readonly customer: CustomerRef;
  /** Instruments to remove from the checkout entirely. */
  readonly suppress: readonly Slice[];
  /** Methods to push down the list. Nothing is removed. */
  readonly demote: readonly PaymentMethod[];
  /** The method order to render, most preferred first. */
  readonly sequence: readonly PaymentMethod[];
  /** Incidents whose directives were applied to this customer. */
  readonly applied: readonly IncidentId[];
  /**
   * Incidents this customer is a control for.
   *
   * Recorded on the plan, at decision time, before the outcome exists. That ordering is what stops
   * the analysis being retrofitted — the arm is a fact about the request, not a label applied to the
   * result afterwards.
   */
  readonly heldOutOf: readonly IncidentId[];
}

/** The plan that changes nothing — what every failure path resolves to. */
export function neutralPlan(
  customer: CustomerRef,
  sequence: readonly PaymentMethod[],
  now: number,
): SteeringPlan {
  return {
    issuedAt: now,
    customer,
    suppress: [],
    demote: [],
    sequence,
    applied: [],
    heldOutOf: [],
  };
}

/**
 * Turn the currently admitted steers into one customer's plan.
 *
 * Pure, and deliberately cheap: this runs on the checkout hot path under a 50 ms budget, so it
 * reads already-admitted directives rather than deciding anything. All the judgement happened when
 * the steer was admitted; this only asks which of those apply to this person.
 *
 * **Minimal intervention.** A demoted method is moved to the back of the list and nothing else
 * changes. Re-sorting the whole checkout by current health would look cleverer and would be much
 * harder to explain to a merchant whose default ordering exists for reasons Kairos cannot see —
 * settlement terms, an issuer relationship, a co-branded card.
 */
export function planFor(
  customer: CustomerRef,
  directives: readonly SteerDirective[],
  health: RailHealth,
  config: SteeringConfig,
  defaultSequence: readonly PaymentMethod[],
  now: number,
): SteeringPlan {
  const suppress: Slice[] = [];
  const demote: PaymentMethod[] = [];
  const applied: IncidentId[] = [];
  const heldOutOf: IncidentId[] = [];

  for (const directive of directives) {
    if (directive.expiresAt <= now) continue;

    if (isHeldOut(customer, directive.incident, config.holdoutFraction)) {
      heldOutOf.push(directive.incident);
      continue;
    }

    applied.push(directive.incident);
    if (directive.lever === "suppress") suppress.push(directive.slice);
    else if (!demote.includes(directive.slice.method)) demote.push(directive.slice.method);
  }

  const guarded = enforceMethodFloor(suppress, health, config);
  const sequence = reorder(defaultSequence, demote);

  return {
    issuedAt: now,
    customer,
    suppress: guarded,
    demote,
    sequence,
    applied,
    heldOutOf,
  };
}

/**
 * Drop suppressions rather than leave a customer with too few ways to pay.
 *
 * Defence in depth: `evaluateSteer` already refuses a steer that would breach the floor, so this
 * should never fire. It exists because the two checks fail differently — that one reasons about one
 * incident at a time, and this one sees the whole set at once, which is the only place a
 * combination of individually-safe steers can add up to an empty checkout.
 *
 * Suppressions are dropped newest-first, so the longest-standing steer survives.
 */
function enforceMethodFloor(
  suppress: readonly Slice[],
  health: RailHealth,
  config: SteeringConfig,
): readonly Slice[] {
  const kept: Slice[] = [];

  for (const candidate of suppress) {
    const trial = [...kept, candidate];
    if (methodsSurviving(health, trial) >= config.methodFloor) kept.push(candidate);
  }

  return kept;
}

/** How many methods still have at least one instrument once these slices are removed. */
function methodsSurviving(health: RailHealth, suppressed: readonly Slice[]): number {
  const alive = new Set<PaymentMethod>();
  for (const observation of health.observations) {
    const removed = suppressed.some((s) => sliceCovers(s, observation.slice));
    if (!removed) alive.add(observation.slice.method);
  }
  return alive.size;
}

/** Move demoted methods to the back, preserving the merchant's order everywhere else. */
function reorder(
  defaultSequence: readonly PaymentMethod[],
  demote: readonly PaymentMethod[],
): readonly PaymentMethod[] {
  if (demote.length === 0) return defaultSequence;
  const demoted = new Set(demote);
  return [
    ...defaultSequence.filter((m) => !demoted.has(m)),
    ...defaultSequence.filter((m) => demoted.has(m)),
  ];
}

/** Whether a plan changes anything at all. */
export function isNeutral(plan: SteeringPlan): boolean {
  return plan.suppress.length === 0 && plan.demote.length === 0;
}

/** Stable identity for a plan's effect, for cache keys and for asserting two plans agree. */
export function planFingerprint(plan: SteeringPlan): string {
  return [
    plan.suppress.map(sliceKey).sort().join(","),
    [...plan.demote].sort().join(","),
    plan.sequence.join(","),
  ].join("|");
}
