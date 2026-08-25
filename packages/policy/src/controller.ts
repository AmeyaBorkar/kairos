import {
  type CustomerRef,
  customerRef,
  type Incident,
  type IncidentId,
  isActive,
  type PaymentMethod,
  paise,
  ZERO,
} from "@kairos/domain";
import { CLEAN_STATUS, type Clock, type Grant, type Terminus } from "@kairos/terminus";
import type { SteeringConfig } from "./config.js";
import { bestSteer, evaluateSteer, type SteerEvaluation } from "./evaluate.js";
import type { RailHealth } from "./health.js";
import { planFor, type SteerDirective, type SteeringPlan } from "./plan.js";

/**
 * A steer is not about one person, and the customer field on an action is required.
 *
 * Using a fixed synthetic reference is honest here rather than evasive: the audit record targets
 * the incident, contact caps do not apply to steering, and the action key gets its uniqueness from
 * the incident id. Inventing a plausible-looking per-customer value would put something in the
 * ledger that reads like a fact and is not one.
 */
const FLEET = customerRef("fleet_wide_steering");

export interface SteeringControllerOptions {
  readonly terminus: Terminus;
  readonly config: SteeringConfig;
  readonly clock: Clock;
  /** The merchant's own method order, which Kairos perturbs rather than replaces. */
  readonly defaultSequence: readonly PaymentMethod[];
}

export type AffirmStatus =
  | "steering"
  | "renewed"
  | "awaiting-corroboration"
  | "declined"
  | "refused"
  | "revoked";

export interface AffirmOutcome {
  readonly incident: IncidentId;
  readonly status: AffirmStatus;
  readonly evaluation: SteerEvaluation | null;
  readonly detail: string;
}

interface HeldSteer {
  readonly grant: Grant;
  readonly directive: SteerDirective;
  readonly renewals: number;
}

/**
 * Holds the set of steers currently in force.
 *
 * The design point worth naming: **a steer is a Terminus reservation, and letting it lapse is the
 * auto-revert.** The architecture asks for steering that expires unless re-affirmed by continuing
 * evidence, and rather than build a second expiry mechanism next to the kernel's, a steer takes a
 * grant whose TTL is the maximum steer duration. If `sentry` dies, if the evidence stops arriving,
 * if the process is partitioned from the store — the reservation expires on its own and the
 * checkout returns to the merchant's own configuration with nobody having to notice.
 *
 * Blast radius is the kernel's in-flight cap, so "at most N steers at once" is the same arithmetic
 * that bounds concurrent spend, enforced by the same atomic step, rather than a counter in this
 * class that a second `sentry` instance would not share.
 */
export class SteeringController {
  readonly #terminus: Terminus;
  readonly #config: SteeringConfig;
  readonly #clock: Clock;
  readonly #defaultSequence: readonly PaymentMethod[];
  readonly #held = new Map<IncidentId, HeldSteer>();
  readonly #corroboration = new Map<IncidentId, number>();

  constructor(options: SteeringControllerOptions) {
    this.#terminus = options.terminus;
    this.#config = options.config;
    this.#clock = options.clock;
    this.#defaultSequence = options.defaultSequence;
  }

  /** The steers currently in force. */
  directives(): readonly SteerDirective[] {
    return [...this.#held.values()].map((h) => h.directive);
  }

  /** One customer's checkout configuration. Pure and cheap — the hot path calls this. */
  planFor(customer: CustomerRef, health: RailHealth): SteeringPlan {
    return planFor(
      customer,
      this.directives(),
      health,
      this.#config,
      this.#defaultSequence,
      this.#clock.now(),
    );
  }

  /**
   * Re-decide, from scratch, what should be steered.
   *
   * Called on every detector tick. Idempotent by construction: an incident already being steered on
   * that still evaluates positively keeps its existing grant untouched, so calling this in a tight
   * loop costs one evaluation per incident and no store traffic.
   */
  async affirm(incidents: readonly Incident[], health: RailHealth): Promise<AffirmOutcome[]> {
    const now = this.#clock.now();
    const outcomes: AffirmOutcome[] = [];
    const seen = new Set<IncidentId>();

    for (const incident of incidents) {
      if (!isActive(incident)) continue;
      seen.add(incident.id);
      outcomes.push(await this.#affirmOne(incident, health, now));
    }

    // Anything held for an incident the detector no longer reports is given back immediately rather
    // than left to expire. Steering a rail that has recovered is a self-inflicted outage, and the
    // TTL is a backstop for the case where nobody is left to notice — not the normal path.
    for (const [id, held] of [...this.#held.entries()]) {
      if (seen.has(id)) continue;
      await this.#revoke(id, held, "the incident is no longer reported");
      outcomes.push({
        incident: id,
        status: "revoked",
        evaluation: null,
        detail: "the incident is no longer reported",
      });
    }

    return outcomes;
  }

  /** Give every steer back. For shutdown, and for the kill switch. */
  async revokeAll(reason: string): Promise<void> {
    for (const [id, held] of [...this.#held.entries()]) {
      await this.#revoke(id, held, reason);
    }
    this.#corroboration.clear();
  }

  async #affirmOne(incident: Incident, health: RailHealth, now: number): Promise<AffirmOutcome> {
    const held = this.#held.get(incident.id);

    // Hysteresis on the target, not only on acquisition. A steer changes the traffic it is
    // measured by: suppress a rail and it goes quiet, and once the control arm is too thin to
    // supply an unbiased rate the blended estimate says the rail has recovered. Re-deriving the
    // best target from scratch every tick then swings between levers on evidence the steer itself
    // created, and a checkout that rearranges itself every few seconds is worse for a merchant
    // than one that never steered. So an incumbent that still justifies itself is kept, and the
    // search only re-runs once it stops.
    const incumbent =
      held === undefined
        ? null
        : evaluateSteer(incident, health, this.#config, held.directive.slice);
    const evaluation = incumbent?.worthDoing
      ? incumbent
      : bestSteer(incident, health, this.#config);

    if (!evaluation.worthDoing) {
      this.#corroboration.set(incident.id, 0);
      const detail = evaluation.declineReason ?? "not worth doing";
      if (held !== undefined) {
        await this.#revoke(incident.id, held, detail);
        return { incident: incident.id, status: "revoked", evaluation, detail };
      }
      return { incident: incident.id, status: "declined", evaluation, detail };
    }

    const corroboration = (this.#corroboration.get(incident.id) ?? 0) + 1;
    this.#corroboration.set(incident.id, corroboration);

    if (held === undefined && corroboration < this.#config.minEvidenceWindows) {
      return {
        incident: incident.id,
        status: "awaiting-corroboration",
        evaluation,
        detail: `${corroboration} of ${this.#config.minEvidenceWindows} corroborating windows`,
      };
    }

    if (held !== undefined && now < held.grant.expiresAt - this.#renewBeforeMs()) {
      return {
        incident: incident.id,
        status: "steering",
        evaluation,
        detail: `in force until ${held.grant.expiresAt}`,
      };
    }

    const renewals = held === undefined ? 0 : held.renewals + 1;
    if (held !== undefined) {
      // Hand the old authority back before asking for new authority, so a renewal cannot consume
      // two of the concurrency slots it is bounded by.
      await this.#revoke(incident.id, held, "renewing on continuing evidence");
    }

    return this.#request(incident, evaluation, renewals, now);
  }

  async #request(
    incident: Incident,
    evaluation: SteerEvaluation,
    renewals: number,
    now: number,
  ): Promise<AffirmOutcome> {
    const reason =
      `${evaluation.lever} ${evaluation.slice.method}` +
      `${evaluation.slice.issuer === null ? "" : `/${evaluation.slice.issuer}`}: ` +
      `expected ${(evaluation.netFailureDelta * -10_000).toFixed(1)} fewer failures per 10,000 attempts`;

    const admission = await this.#terminus.admit({
      action: {
        kind: "steer",
        customer: FLEET,
        casualty: null,
        incident: incident.id,
        // A steer moves no money. The kernel still bounds it: blast radius through the in-flight
        // cap, duration through the reservation TTL, and the kill switch through both. The
        // expected-value gate is deliberately not the binding constraint here — whether a steer is
        // worth making was decided by `evaluateSteer`, which is the only thing that can see that
        // the destination rail may be worse than the failing one.
        estimatedCost: ZERO,
        expectedValue: paise(1),
        successProbability: 1,
        rationale: reason,
      },
      status: CLEAN_STATUS,
      attemptNo: renewals + 1,
    });

    if (!admission.allowed) {
      return {
        incident: incident.id,
        status: "refused",
        evaluation,
        detail: `${admission.axis}: ${admission.reason}`,
      };
    }

    this.#held.set(incident.id, {
      grant: admission.grant,
      directive: {
        incident: incident.id,
        slice: evaluation.slice,
        lever: evaluation.lever,
        reason,
        expiresAt: admission.grant.expiresAt,
      },
      renewals,
    });

    return {
      incident: incident.id,
      status: renewals === 0 ? "steering" : "renewed",
      evaluation,
      detail: `in force until ${admission.grant.expiresAt} (${now})`,
    };
  }

  async #revoke(id: IncidentId, held: HeldSteer, reason: string): Promise<void> {
    this.#held.delete(id);
    // Abandoned, never settled: a steer costs no money, so booking a spend of zero would record an
    // expense that did not happen.
    await this.#terminus.abandon(held.grant, reason);
  }

  /** Renew a steer once it is inside the last third of its authority. */
  #renewBeforeMs(): number {
    return Math.max(1, Math.floor(this.#config.maxIncidentDurationMs / 3));
  }
}
