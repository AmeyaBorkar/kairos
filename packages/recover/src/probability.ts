import type { ActionKind, RecoverabilityClass } from "@kairos/domain";

/**
 * What the model gets to know about a recovery attempt before it happens.
 *
 * Small on purpose. Every feature here is one the system already had to compute for another
 * reason — the class came from the rule table, the rail's health came from the detector, the
 * ordinal from the casualty's own history — so nothing is gathered specifically to feed a model,
 * and there is no feature that could only be obtained by holding more customer data than the
 * system already holds.
 *
 * The payment method is deliberately absent. It would split every cell six ways for information the
 * class largely already carries: a cancelled UPI collect and a cancelled card payment recover at
 * similar rates because the thing that predicts recovery is what the customer has to do next, not
 * which rail they did it on. Whether that holds on real traffic is an open question rather than a
 * finding.
 */
export interface RecoveryFeatures {
  readonly action: ActionKind;
  readonly recoverability: RecoverabilityClass;
  /** How much the classification is trusted, in `(0, 1]`. See {@link RecoveryModel.probability}. */
  readonly confidence: number;
  /** Whether the rail this payment died on is currently healthy. The `kairos` feature. */
  readonly railHealthy: boolean;
  /** How many recovery attempts have already been made on this casualty. */
  readonly attemptOrdinal: number;
}

export interface RecoveryModelConfig {
  /**
   * Prior strength κ, in pseudo-observations, applied at every level of the hierarchy.
   *
   * A cell's estimate is half its parent's and half its own once it has seen κ outcomes. Twelve is
   * deliberately small: recovery outcomes arrive far more slowly than payment attempts, and a
   * campaign that never accumulates enough evidence to form its own opinion has a model that only
   * ever repeats its prior back at it.
   */
  readonly priorStrength: number;
  /** Geometric decay per observation, so the model tracks a merchant whose customers change. */
  readonly decayPerObservation: number;
  /**
   * The recovery rate assumed before any evidence exists at all.
   *
   * A stated assumption, not a measurement: published dunning recovery rates cluster loosely
   * between 10% and 30% and depend enormously on what is being sold. It matters only for the first
   * few dozen decisions, after which the data dominates it, and the harness reports how quickly
   * that happens.
   */
  readonly coldStartRate: number;
  /** Clamps. A model certain of anything is a model about to make a large mistake. */
  readonly floor: number;
  readonly ceiling: number;
}

export const DEFAULT_RECOVERY_MODEL: RecoveryModelConfig = {
  priorStrength: 12,
  decayPerObservation: 0.999,
  coldStartRate: 0.15,
  floor: 0.005,
  ceiling: 0.95,
};

interface Cell {
  readonly successes: number;
  readonly trials: number;
}

const EMPTY: Cell = { successes: 0, trials: 0 };

/**
 * Attempt ordinals collapse into three buckets.
 *
 * The interesting distinction is first / second / later, not first / second / third / fourth. Every
 * ladder in the system is at most four rungs long, so a bucket per rung would mean a cell for the
 * fourth attempt that sees almost nothing and inherits its parent anyway.
 */
function ordinalBucket(ordinal: number): string {
  if (ordinal <= 0) return "0";
  if (ordinal === 1) return "1";
  return "2+";
}

/**
 * The chain of increasingly specific cells this observation belongs to, coarsest first.
 *
 * The same shape as the detector's slice hierarchy, and for the same reason: a cell that has not
 * earned its own opinion should borrow its parent's rather than invent one from three data points.
 * Coarsest first matters — a child shrinks toward its parent, so the parent must be current before
 * the child reads it.
 */
function chainFor(f: RecoveryFeatures): readonly string[] {
  const rail = f.railHealthy ? "healthy" : "degraded";
  return [
    "",
    f.action,
    `${f.action}|${f.recoverability}`,
    `${f.action}|${f.recoverability}|${rail}`,
    `${f.action}|${f.recoverability}|${rail}|${ordinalBucket(f.attemptOrdinal)}`,
  ];
}

/**
 * `p(recover)`, estimated by hierarchical Beta-Binomial shrinkage and reported honestly.
 *
 * The gate in §7 consumes this probability directly — `p × amount × margin > cost` — so what
 * matters is not that the model ranks casualties well but that its numbers *mean* something. A
 * model claiming 30% and recovering 30% is worth far more here than one with a better AUC and no
 * calibration, because the second one cannot be multiplied by a rupee amount. That is why this is
 * a Beta-Binomial rather than anything cleverer: it is calibrated by construction, it degrades to
 * its prior instead of to nonsense, and it can be explained to a merchant in one sentence.
 */
export class RecoveryModel {
  readonly #config: RecoveryModelConfig;
  readonly #cells = new Map<string, Cell>();

  constructor(config: RecoveryModelConfig = DEFAULT_RECOVERY_MODEL) {
    this.#config = config;
  }

  /** Fold one realised outcome into every level it belongs to. */
  observe(features: RecoveryFeatures, recovered: boolean): void {
    const decay = this.#config.decayPerObservation;
    for (const key of chainFor(features)) {
      const cell = this.#cells.get(key) ?? EMPTY;
      this.#cells.set(key, {
        successes: cell.successes * decay + (recovered ? 1 : 0),
        trials: cell.trials * decay + 1,
      });
    }
  }

  /**
   * The probability this action recovers this casualty.
   *
   * Two things happen here, and only the first is ordinary. The chain walk is standard shrinkage:
   * each level's estimate is `(successes + κ·parent) / (trials + κ)`, so a cell with no data is
   * exactly its parent and a cell with plenty is exactly itself.
   *
   * The second is the confidence blend, and it is worth being precise about what it is *not*. It is
   * not a safety margin. If the classification is only half trusted, the honest predictive
   * probability is a mixture over the classes it might really be, and the population rate is the
   * cheapest defensible stand-in for that mixture. Biasing the number downward "to be careful"
   * would break exactly the property the gate depends on — a probability that can be multiplied by
   * an amount — and the calibration curve is what proves the blend was right rather than merely
   * cautious.
   */
  probability(features: RecoveryFeatures): number {
    const { priorStrength: kappa, floor, ceiling } = this.#config;

    let estimate = this.#config.coldStartRate;
    let global = estimate;

    const chain = chainFor(features);
    for (const [level, key] of chain.entries()) {
      const cell = this.#cells.get(key) ?? EMPTY;
      estimate = (cell.successes + kappa * estimate) / (cell.trials + kappa);
      if (level === 0) global = estimate;
    }

    const confidence = clamp01(features.confidence);
    const blended = confidence * estimate + (1 - confidence) * global;
    return Math.min(ceiling, Math.max(floor, blended));
  }

  /**
   * How much of the estimate is this cell's own evidence rather than inherited, in `[0, 1)`.
   *
   * Reported next to a decision so a reader can tell a well-evidenced probability from a borrowed
   * one, exactly as the detector reports it next to an alarm.
   */
  evidence(features: RecoveryFeatures): number {
    const key = chainFor(features).at(-1) ?? "";
    const cell = this.#cells.get(key) ?? EMPTY;
    return cell.trials / (cell.trials + this.#config.priorStrength);
  }

  /** Observations folded in so far, decayed. For the scorecard, and for a warm-start check. */
  observations(): number {
    return this.#cells.get("")?.trials ?? 0;
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
