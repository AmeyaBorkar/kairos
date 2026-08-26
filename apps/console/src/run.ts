/**
 * A scenario, driven through the real components, observable while it runs.
 *
 * The console does not replay a recording and does not mock anything it displays. It builds the
 * same `DetectionEngine`, `SteeringController`, `Terminus` and `MemoryLedger` the production apps
 * build, feeds them simulated traffic, and reads its snapshot off their actual state. What is
 * simulated is the *world* — the attempts — not the system under observation.
 *
 * That distinction is the whole value of the thing. A console driven by a fixture would show
 * whatever its author believed the system does, which is precisely the belief a demo is supposed to
 * test. Here, if the detector is slow the console is slow, and if a bound refuses the console shows
 * the refusal because the refusal happened.
 *
 * ## Time is stepped, not slept
 *
 * The run advances a `ManualClock` in fixed ticks and does each tick's work synchronously, so four
 * hours of traffic takes a few seconds and every observer sees the same sequence. A UI asking for a
 * snapshot gets the state as of the last completed tick. Nothing here waits on a timer, which is
 * also why the whole thing is testable.
 */

import {
  type DetectedIncident,
  DetectionEngine,
  type EngineConfig,
  incidentFrom,
  peakStatistic,
} from "@kairos/detect";
import {
  type Attempt,
  isFailure,
  type Mandate,
  PAYMENT_METHODS,
  type Slice,
  sliceKey,
} from "@kairos/domain";
import { MemoryLedger } from "@kairos/ledger";
import {
  DEFAULT_STEERING_CONFIG,
  RailHealth,
  RailWindow,
  SteeringController,
} from "@kairos/policy";
import { generate } from "@kairos/simulator";
import { ManualClock, Terminus } from "@kairos/terminus";
import { MemoryStore } from "throttlekit";
import {
  type BoundView,
  type ConsoleSnapshot,
  EMPTY_RECOVERY,
  type IncidentView,
  type LedgerView,
  type RailView,
} from "./model.js";
import type { Scenario } from "./scenario.js";

/** How much simulated time one step covers. */
const TICK_MS = 30_000;

export interface RunOptions {
  readonly scenario: Scenario;
  readonly mandate: Mandate;
  readonly secret: string;
  readonly detector: EngineConfig;
  /** Simulated milliseconds per real second, reported to the UI. Presentation only. */
  readonly speed?: number;
}

/** An incident with the fields the engine forgets once it closes one. */
interface Tracked {
  readonly incident: DetectedIncident;
  readonly openedAt: number;
  closedAt: number | null;
  peakRate: number;
}

export class ConsoleRun {
  readonly #options: RunOptions;
  readonly #clock: ManualClock;
  readonly #engine: DetectionEngine;
  readonly #window = new RailWindow();
  readonly #ledger = new MemoryLedger();
  readonly #controller: SteeringController;
  readonly #attempts: readonly Attempt[];
  readonly #tracked = new Map<string, Tracked>();

  #cursor = 0;
  #at: number;
  #health: RailHealth;

  constructor(options: RunOptions) {
    this.#options = options;
    this.#at = options.scenario.simulator.startAt;
    this.#clock = new ManualClock(this.#at);
    this.#engine = new DetectionEngine(options.detector);
    this.#health = new RailHealth([]);

    const terminus = new Terminus({
      mandate: options.mandate,
      secret: options.secret,
      store: new MemoryStore(),
      audit: this.#ledger,
      actor: "console",
      clock: this.#clock,
    });

    this.#controller = new SteeringController({
      terminus,
      clock: this.#clock,
      config: DEFAULT_STEERING_CONFIG,
      // The merchant's own order. Kairos perturbs it; it never replaces it, and a console that
      // invented its own ordering would be showing a checkout no merchant configured.
      defaultSequence: PAYMENT_METHODS,
    });

    // Generated up front rather than lazily: the whole point of a pinned seed is that the traffic
    // is a fact about the scenario, not about when somebody pressed play.
    this.#attempts = [...generate(options.scenario.simulator)];
  }

  get at(): number {
    return this.#at;
  }

  get finished(): boolean {
    return this.#cursor >= this.#attempts.length;
  }

  get ledger(): MemoryLedger {
    return this.#ledger;
  }

  /**
   * Advance one tick: feed the traffic that arrived, then let the system react to it.
   *
   * Ordering matters and is the same as production's. Observations reach the detector and the rail
   * window before steering is re-affirmed, because a controller acting on a window the detector has
   * not seen would be steering on staler evidence than the system actually has.
   */
  async step(): Promise<void> {
    const until = this.#at + TICK_MS;

    while (this.#cursor < this.#attempts.length) {
      const attempt = this.#attempts[this.#cursor];
      if (attempt === undefined || attempt.at >= until) break;
      this.#cursor++;
      this.#observe(attempt);
    }

    this.#at = until;
    this.#clock.set(this.#at);
    this.#health = this.#window.snapshot(this.#at);

    // Every steer is authority that lapses. Re-affirming is what keeps one alive, and *not*
    // re-affirming is how a steer ends — there is no revoke path on the happy route, which is the
    // property that makes a crashed controller safe rather than sticky.
    await this.#controller.affirm(this.#engine.openIncidents().map(incidentFrom), this.#health);

    this.#reconcileIncidents();
  }

  /** Run to the end. Returns the number of ticks, which is a fact a test can assert on. */
  async runToEnd(limit = 10_000): Promise<number> {
    let ticks = 0;
    while (!this.finished && ticks < limit) {
      await this.step();
      ticks++;
    }
    return ticks;
  }

  snapshot(): ConsoleSnapshot {
    return {
      provenance: {
        kind: "simulated",
        scenario: this.#options.scenario.name,
        seed: this.#options.scenario.simulator.seed,
        at: this.#at,
        speed: this.#options.speed ?? TICK_MS,
      },
      rails: this.#rails(),
      incidents: this.#incidents(),
      bounds: this.#bounds(),
      ledger: this.#ledgerView(),
      // The recovery arm is not driven by this run yet. Reported as zeroes rather than omitted,
      // because a UI that renders a section only when data arrives will silently lose it the day
      // the numbers stop, and a visible row of zeroes is a question somebody asks.
      recovery: EMPTY_RECOVERY,
    };
  }

  #observe(attempt: Attempt): void {
    this.#engine.observe(attempt);
    // Nothing is held out here: a holdout exists to measure lift, and this is a display rather than
    // a measurement. `bench` is where lift is measured, with a control arm.
    this.#window.observe(attempt.slice, isFailure(attempt), attempt.at, "treated");
  }

  /**
   * Keep a record of incidents the engine has already closed.
   *
   * `openIncidents()` is the live set, and an incident that resolves simply leaves it. A console
   * that rendered only the live set would erase the outage a viewer is currently being told about
   * the moment it healed, which is the opposite of what an operator needs.
   */
  #reconcileIncidents(): void {
    const live = new Set<string>();
    for (const incident of this.#engine.openIncidents()) {
      const key = sliceKey(incident.slice);
      live.add(key);
      const existing = this.#tracked.get(key);
      if (existing === undefined) {
        this.#tracked.set(key, {
          incident,
          openedAt: incident.detectedAt,
          closedAt: null,
          peakRate: incident.peakRate,
        });
      } else {
        existing.peakRate = Math.max(existing.peakRate, incident.peakRate);
      }
    }

    for (const [key, tracked] of this.#tracked) {
      if (!live.has(key) && tracked.closedAt === null) tracked.closedAt = this.#at;
    }
  }

  #rails(): readonly RailView[] {
    const open = new Set(this.#engine.openIncidents().map((incident) => sliceKey(incident.slice)));
    const directives = this.#controller.directives();

    return this.#health.observations.map((observation) => {
      const key = sliceKey(observation.slice);
      const directive = directives.find((d) => sliceKey(d.slice) === key);
      const state = this.#engine.stateOf(observation.slice);

      return {
        key,
        method: observation.slice.method,
        issuer: observation.slice.issuer ?? null,
        // `share` is relative volume in whatever unit the window uses, and the console reports it
        // as such rather than dressing it up as a count it is not.
        attempts: Math.round(observation.share),
        failureRate: observation.failureRate,
        state: open.has(key) ? "degraded" : state?.phase === "alarmed" ? "watching" : "healthy",
        // Whichever shift hypothesis leads. A detector running several and reporting their mean
        // would understate its own evidence for the one that is about to fire.
        statistic: state === undefined ? 0 : peakStatistic(state.cusum),
        threshold: this.#options.detector.cusum.threshold,
        steer:
          directive === undefined
            ? "none"
            : directive.lever === "suppress"
              ? "suppressed"
              : "demoted",
      };
    });
  }

  #incidents(): readonly IncidentView[] {
    return [...this.#tracked.values()].map((tracked) => ({
      id: `${sliceKey(tracked.incident.slice)}@${tracked.openedAt}`,
      slice: sliceKey(tracked.incident.slice),
      openedAt: tracked.openedAt,
      closedAt: tracked.closedAt,
      // From the *estimated changepoint*, not from the moment the console noticed. Measuring
      // latency from detection would make every detector instantaneous.
      detectionLatencyMs: tracked.openedAt - tracked.incident.onsetAt,
      peakFailureRate: tracked.peakRate,
      casualties: 0,
    }));
  }

  #onsetOf(target: Slice): number | null {
    const key = sliceKey(target);
    for (const degradation of this.#options.scenario.simulator.degradations) {
      if (sliceKey(degradation.slice) === key) return degradation.onsetAt;
    }
    return null;
  }

  /**
   * Every bound, and how close it is to binding.
   *
   * Read off the mandate and the ledger rather than tracked separately, so a bound displayed here
   * cannot drift from the bound Terminus is enforcing — the two would be the same number written
   * twice, and the second copy would eventually be wrong.
   */
  #bounds(): readonly BoundView[] {
    const mandate = this.#options.mandate;
    const refusals = this.#ledger.countByBinding();
    const steers = this.#controller.directives().length;

    return [
      {
        axis: "max-concurrent-steers",
        limit: String(mandate.maxInFlight),
        current: String(steers),
        utilisation: mandate.maxInFlight === 0 ? 0 : steers / mandate.maxInFlight,
        refusals: refusals["in-flight"] ?? 0,
      },
      {
        axis: "campaign-budget",
        limit: rupees(mandate.budgetPaise),
        current: "—",
        utilisation: 0,
        refusals: refusals["campaign-budget"] ?? 0,
      },
      {
        axis: "contact-cap",
        limit: `${mandate.contactCap.limit} per ${Math.round(mandate.contactCap.windowMs / 86_400_000)}d`,
        current: "—",
        utilisation: 0,
        refusals: refusals["contact-cap"] ?? 0,
      },
      {
        axis: "kill-switch",
        limit: "off",
        current: mandate.killSwitch ? "ON" : "off",
        utilisation: mandate.killSwitch ? 1 : 0,
        refusals: refusals["kill-switch"] ?? 0,
      },
    ];
  }

  #ledgerView(): LedgerView {
    const recent = [...this.#ledger.records]
      .slice(-40)
      .reverse()
      .map((record) => ({
        at: new Date(record.at).toISOString(),
        actor: record.actor,
        action: record.action,
        allowed: record.allowed,
        reason: record.reason,
        binding: record.binding,
      }));

    return {
      // Recomputed on every read rather than cached. A chain nobody re-verifies is a log, and
      // hashing a few thousand records costs nothing next to displaying a stale `true`.
      verified: this.#ledger.verify().valid,
      records: this.#ledger.length,
      recent,
    };
  }

  /** True onset of a scenario's degradation, for a test that wants to check detection latency. */
  onsetFor(target: Slice): number | null {
    return this.#onsetOf(target);
  }

  static get tickMs(): number {
    return TICK_MS;
  }
}

function rupees(amount: number): string {
  return `₹${(amount / 100).toFixed(2)}`;
}
