import {
  type Attempt,
  isFailure,
  isResolved,
  parseSliceKey,
  type Slice,
  sliceCovers,
  sliceKey,
  sliceParents,
} from "@kairos/domain";
import type { BaselineState } from "./baseline.js";
import { baselineRate, EMPTY_BASELINE, observeBaseline } from "./baseline.js";
import { emptyCusum } from "./cusum.js";
import { type DetectorConfig, type DetectorState, emptyDetector, observe } from "./detector.js";

export interface EngineConfig extends DetectorConfig {
  /**
   * Report a degradation at the coarsest slice that explains it.
   *
   * An issuer-wide UPI outage degrades every app slice under that issuer at once. Without rollup
   * that is one alarm per app — a dozen incidents describing one event, each of which an operator
   * has to read and dismiss. With it, the issuer-level incident is reported and its descendants are
   * folded in.
   */
  readonly rollup: boolean;
}

export interface DetectedIncident {
  readonly slice: Slice;
  /** Estimated changepoint, from the CUSUM excursion. Latency is measured from here. */
  readonly onsetAt: number;
  /** When the statistic crossed the threshold. */
  readonly detectedAt: number;
  readonly baselineRate: number;
  readonly observedRate: number;
  /**
   * Worst rate seen since the incident opened.
   *
   * Tracked separately from {@link DetectedIncident.observedRate} because steering needs to know
   * how bad it has been, not only how bad it is this instant. A rail whose rate has already begun
   * falling is still an incident, and the decision to act on it should not oscillate with the last
   * few samples.
   */
  readonly peakRate: number;
  readonly statistic: number;
  /** How much of the baseline was the slice's own evidence rather than inherited, in [0,1). */
  readonly confidence: number;
}

export type EngineEvent =
  | { readonly kind: "opened"; readonly incident: DetectedIncident }
  | {
      readonly kind: "resolved";
      readonly slice: Slice;
      readonly at: number;
      readonly onsetAt: number;
    }
  /** A coarser slice took over: one event explained by one incident, at the right altitude. */
  | { readonly kind: "superseded"; readonly slice: Slice; readonly by: Slice; readonly at: number };

/**
 * Runs a detector per slice across the whole slice tree, resolves the baseline hierarchy, and
 * turns transitions into incidents.
 *
 * The only stateful object in the detection path. Everything it calls is pure, so a run is exactly
 * reproducible from its inputs.
 */
export class DetectionEngine {
  readonly #config: EngineConfig;
  readonly #states = new Map<string, DetectorState>();
  readonly #open = new Map<string, DetectedIncident>();
  #global: BaselineState = EMPTY_BASELINE;

  constructor(config: EngineConfig) {
    this.#config = config;
  }

  /**
   * Fold one attempt into every slice it belongs to, coarsest first.
   *
   * Coarsest first matters: a child shrinks toward its parent, so the parent's estimate has to be
   * current before the child reads it.
   */
  observe(attempt: Attempt): EngineEvent[] {
    // An attempt still in flight is evidence of neither outcome. Counting it as a success would
    // mask an outage; counting it as a failure would invent one.
    if (!isResolved(attempt)) return [];

    const failed = isFailure(attempt);
    const at = attempt.at;
    const events: EngineEvent[] = [];

    const chain = [...sliceParents(attempt.slice)].reverse();
    chain.push(attempt.slice);

    let parentRate = this.#globalRate();
    this.#global = observeBaseline(this.#global, failed, this.#config.baseline);

    for (const slice of chain) {
      const key = sliceKey(slice);
      const previous = this.#states.get(key) ?? emptyDetector(this.#config);
      const { state, verdict } = observe(
        previous,
        { isFailure: failed, at, parentRate },
        this.#config,
      );
      this.#states.set(key, state);

      if (verdict.transition === "opened") {
        const incident: DetectedIncident = {
          slice,
          onsetAt: verdict.onsetAt ?? at,
          detectedAt: at,
          baselineRate: verdict.baselineRate,
          observedRate: verdict.observedRate,
          peakRate: verdict.observedRate,
          statistic: verdict.statistic,
          confidence: verdict.confidence,
        };

        const covering = this.#config.rollup ? this.#alarmedAncestor(slice) : null;
        if (covering === null) {
          this.#open.set(key, incident);
          events.push({ kind: "opened", incident });
          if (this.#config.rollup) {
            events.push(...this.#supersedeDescendants(slice, at));
          }
        }
        // Otherwise an ancestor already explains it, and the child alarm is not news.
      } else if (verdict.transition === "none" || verdict.transition === "clearing") {
        const open = this.#open.get(key);
        if (open !== undefined) {
          this.#open.set(key, {
            ...open,
            observedRate: verdict.observedRate,
            peakRate: Math.max(open.peakRate, verdict.observedRate),
            statistic: verdict.statistic,
          });
        }
      } else if (verdict.transition === "resolved") {
        const incident = this.#open.get(key);
        if (incident !== undefined) {
          this.#open.delete(key);
          this.#retireCovered(slice);
          events.push({ kind: "resolved", slice, at, onsetAt: incident.onsetAt });
        }
      }

      parentRate = baselineRate(state.baseline, parentRate, this.#config.baseline);
    }

    return events;
  }

  /** Currently open incidents, coarsest first. */
  openIncidents(): DetectedIncident[] {
    return [...this.#open.values()];
  }

  /** Whether this exact slice currently has an open incident. */
  isOpen(slice: Slice): boolean {
    return this.#open.has(sliceKey(slice));
  }

  /** Inspect a slice's detector. For tests and the operator console. */
  stateOf(slice: Slice): DetectorState | undefined {
    return this.#states.get(sliceKey(slice));
  }

  #globalRate(): number {
    const { fails, total } = this.#global;
    if (total <= 0) return this.#config.baseline.floor;
    const rate = fails / total;
    return Math.min(this.#config.baseline.ceiling, Math.max(this.#config.baseline.floor, rate));
  }

  #alarmedAncestor(slice: Slice): Slice | null {
    for (const parent of sliceParents(slice)) {
      const state = this.#states.get(sliceKey(parent));
      if (state !== undefined && state.phase !== "quiet") return parent;
    }
    return null;
  }

  /**
   * Retire the evidence held by the slices this incident was standing in for.
   *
   * Rollup reports one event at the coarsest slice that explains it, and every slice underneath is
   * left holding its own account of the same outage. A descendant that raised its own alarm has its
   * own way out — the recovery statistic, running against its own frozen claim. A descendant that
   * never alarmed has none, and its bank simply keeps whatever it accumulated until noise walks it
   * down.
   *
   * That is not hypothetical. On the console's `issuer-outage` the HDFC netbanking slice sits below
   * the alarm gate for the whole outage, banks a statistic well past `threshold`, crosses
   * `minObservations` twelve minutes after the rail is healthy and opens an incident on it — an
   * outage reported for the first time after it ended. The evidence is real; it is simply spent,
   * because the incident that reported it has already been opened, watched and closed one level up.
   *
   * Only quiet descendants are touched, and only their statistic: a descendant mid-incident is
   * making its own claim and is entitled to finish making it.
   *
   * Costs one pass over the slice table per resolved incident. Incidents are rare by construction;
   * if that ever stops being true, this wants an index rather than a scan.
   */
  #retireCovered(slice: Slice): void {
    const parent = sliceKey(slice);
    for (const [key, state] of this.#states) {
      if (key === parent || state.phase !== "quiet") continue;
      if (!sliceCovers(slice, parseSliceKey(key))) continue;
      this.#states.set(key, { ...state, cusum: emptyCusum(this.#config.cusum) });
    }
  }

  #supersedeDescendants(slice: Slice, at: number): EngineEvent[] {
    const events: EngineEvent[] = [];
    for (const [key, incident] of [...this.#open]) {
      if (key === sliceKey(slice)) continue;
      const isDescendant = sliceParents(incident.slice).some(
        (p) => sliceKey(p) === sliceKey(slice),
      );
      if (isDescendant) {
        this.#open.delete(key);
        events.push({ kind: "superseded", slice: incident.slice, by: slice, at });
      }
    }
    return events;
  }
}
