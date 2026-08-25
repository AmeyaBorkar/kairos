import { type Slice, sliceKey } from "@kairos/domain";
import { RailHealth, type RailObservation } from "./health.js";

/**
 * A decaying view of what each rail is doing *right now*.
 *
 * Deliberately not the detector's baseline. The detector freezes a slice's baseline the moment an
 * incident opens, so that an outage cannot teach the estimator that 35% failure is normal and
 * declare itself over. Steering needs the opposite quantity: what the rail is doing *including* the
 * outage, because that is the number a customer is exposed to and the number the decision to move
 * them turns on. The two estimates disagree during exactly the window that matters, and conflating
 * them would make steering impossible — a frozen baseline never looks bad enough to act on.
 *
 * Exponential decay rather than a fixed window: no ring buffer, no per-slice memory growth, and a
 * rail that stops receiving traffic ages out rather than freezing at its last value.
 */
export interface RailWindowConfig {
  /** Time for an observation's weight to halve. */
  readonly halfLifeMs: number;
  /**
   * Weight below which a rail is dropped.
   *
   * Without this, every slice ever observed stays in the snapshot forever at a vanishing weight,
   * and `destinationRate` slowly fills with rails nobody uses any more.
   */
  readonly minWeight: number;
  /**
   * Control-arm weight below which the blended estimate is used instead.
   *
   * Low enough that a thin rail still gets an unbiased rate during an incident, high enough that
   * the rate is not being read off three attempts.
   */
  readonly minControlWeight: number;
}

/**
 * Two minutes, which is a compromise and should be read as one.
 *
 * The half-life adds directly to time-to-steer: after an outage begins, the estimate needs roughly
 * two half-lives before it reflects what customers are actually experiencing, because it is still
 * carrying the weight of everything that went well beforehand. Detection already costs about ninety
 * seconds at the chosen operating point, so a five-minute half-life would put the first steer more
 * than ten minutes into an incident — long enough that the recovery arm would have been the better
 * investment.
 *
 * Shortening it is not free. The effective sample size falls with the half-life, so a thin rail's
 * rate estimate gets noisy, and a noisy origin rate can push a marginal steer over the line on
 * nothing. `minBenefitPerAttempt` is the margin that absorbs that.
 */
export const DEFAULT_WINDOW_CONFIG: RailWindowConfig = {
  halfLifeMs: 2 * 60_000,
  minWeight: 0.5,
  minControlWeight: 6,
};

interface Series {
  weight: number;
  failures: number;
  at: number;
}

interface Cell {
  slice: Slice;
  /** Everything observed, which is what volume should be read from. */
  all: Series;
  /**
   * Only the customers whose checkout was left alone.
   *
   * This is the fix for a control loop that eats its own signal. The moment a steer takes effect,
   * traffic leaves the failing rail — so the evidence that justified the steer starts to vanish,
   * the rail looks healthy again, the steer is withdrawn, and the traffic comes back to a rail that
   * is still broken. The blended estimate cannot see through its own intervention.
   *
   * The holdout can. Control-arm customers go on using the failing rail throughout, so their
   * outcomes are an unbiased measurement of the world in which nothing was done — which is exactly
   * the quantity the decision needs. The control group turns out to be load-bearing for stability,
   * not only for measurement.
   */
  control: Series;
}

/** Which arm an observation came from. `control` means the customer's checkout was unmodified. */
export type ObservedArm = "treated" | "control";

const emptySeries = (at: number): Series => ({ weight: 0, failures: 0, at });

export class RailWindow {
  readonly #cells = new Map<string, Cell>();
  readonly #config: RailWindowConfig;

  constructor(config: RailWindowConfig = DEFAULT_WINDOW_CONFIG) {
    this.#config = config;
  }

  /** Fold one outcome in. */
  observe(slice: Slice, failed: boolean, at: number, arm: ObservedArm = "treated"): void {
    const key = sliceKey(slice);
    let cell = this.#cells.get(key);

    if (cell === undefined) {
      cell = { slice, all: emptySeries(at), control: emptySeries(at) };
      this.#cells.set(key, cell);
    }

    this.#fold(cell.all, failed, at);
    if (arm === "control") this.#fold(cell.control, failed, at);
  }

  #fold(series: Series, failed: boolean, at: number): void {
    const decay = this.#decayFrom(series.at, at);
    series.weight = series.weight * decay + 1;
    series.failures = series.failures * decay + (failed ? 1 : 0);
    series.at = at;
  }

  /** Rail health as of `now`, with stale rails dropped. */
  snapshot(now: number): RailHealth {
    const observations: RailObservation[] = [];

    for (const [key, cell] of [...this.#cells.entries()]) {
      const weight = cell.all.weight * this.#decayFrom(cell.all.at, now);
      if (weight < this.#config.minWeight) {
        this.#cells.delete(key);
        continue;
      }

      const controlWeight = cell.control.weight * this.#decayFrom(cell.control.at, now);
      const useControl = controlWeight >= this.#config.minControlWeight;
      const series = useControl ? cell.control : cell.all;
      const denominator = useControl ? controlWeight : weight;
      const failures = series.failures * this.#decayFrom(series.at, now);

      observations.push({
        slice: cell.slice,
        // Volume always comes from everything observed; only the *rate* comes from the control arm.
        // Reading volume off a tenth of the traffic would make every steered rail look negligible.
        share: weight,
        failureRate: Math.min(1, Math.max(0, failures / denominator)),
      });
    }

    return new RailHealth(observations);
  }

  get size(): number {
    return this.#cells.size;
  }

  #decayFrom(from: number, to: number): number {
    const elapsed = Math.max(0, to - from);
    return 2 ** (-elapsed / this.#config.halfLifeMs);
  }
}
