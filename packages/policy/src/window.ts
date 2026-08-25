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
};

interface Cell {
  slice: Slice;
  weight: number;
  failures: number;
  at: number;
}

export class RailWindow {
  readonly #cells = new Map<string, Cell>();
  readonly #config: RailWindowConfig;

  constructor(config: RailWindowConfig = DEFAULT_WINDOW_CONFIG) {
    this.#config = config;
  }

  /** Fold one outcome in. */
  observe(slice: Slice, failed: boolean, at: number): void {
    const key = sliceKey(slice);
    const cell = this.#cells.get(key);

    if (cell === undefined) {
      this.#cells.set(key, { slice, weight: 1, failures: failed ? 1 : 0, at });
      return;
    }

    const decay = this.#decayFrom(cell.at, at);
    cell.weight = cell.weight * decay + 1;
    cell.failures = cell.failures * decay + (failed ? 1 : 0);
    cell.at = at;
  }

  /** Rail health as of `now`, with stale rails dropped. */
  snapshot(now: number): RailHealth {
    const observations: RailObservation[] = [];

    for (const [key, cell] of [...this.#cells.entries()]) {
      const decay = this.#decayFrom(cell.at, now);
      const weight = cell.weight * decay;
      if (weight < this.#config.minWeight) {
        this.#cells.delete(key);
        continue;
      }
      observations.push({
        slice: cell.slice,
        share: weight,
        failureRate: Math.min(1, Math.max(0, (cell.failures * decay) / weight)),
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
