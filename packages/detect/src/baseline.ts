/**
 * Baseline failure-rate estimation per slice.
 *
 * The detector tests "has this slice's failure rate risen above its own normal", so `p₀` has to be
 * per-slice: a public-sector bank running 7% technical declines is not an incident, it is Tuesday.
 * Two problems make a plain running average wrong.
 *
 * **Low volume.** A slice seeing three attempts a minute cannot support its own estimate. One
 * failure moves a naive rate from 0% to 33%. The fix is empirical-Bayes shrinkage toward the
 * parent slice: the estimate is a Beta-Binomial posterior mean with the parent's rate as the prior,
 * so a quiet slice inherits its method's behaviour and only earns its own opinion once it has the
 * evidence to justify one.
 *
 * **Drift.** Rails genuinely change over weeks. Counts decay geometrically, giving a soft window
 * that tracks slow change without a hard cutoff.
 */
export interface BaselineConfig {
  /**
   * Prior strength κ, in pseudo-observations. The estimate is half the parent's and half the
   * slice's own once the slice has seen κ observations.
   */
  readonly priorStrength: number;
  /** Geometric decay applied per observation. 0.9995 gives an effective window near 2000. */
  readonly decayPerObservation: number;
  /**
   * Lower clamp on the estimate. `log(p₁/p₀)` diverges as `p₀ → 0`, so a slice that has genuinely
   * never failed would make one failure look like infinite evidence.
   */
  readonly floor: number;
  /**
   * Upper clamp. Above this a slice is not a healthy rail with a raised rate; it is broken, and the
   * likelihood-ratio framing stops being meaningful.
   */
  readonly ceiling: number;
}

/** Decayed failure and attempt counts. Fractional, because decay is geometric. */
export interface BaselineState {
  readonly fails: number;
  readonly total: number;
}

export const EMPTY_BASELINE: BaselineState = { fails: 0, total: 0 };

/** Fold one resolved attempt into the decayed counts. */
export function observeBaseline(
  state: BaselineState,
  isFailure: boolean,
  config: BaselineConfig,
): BaselineState {
  const decay = config.decayPerObservation;
  return {
    fails: state.fails * decay + (isFailure ? 1 : 0),
    total: state.total * decay + 1,
  };
}

/**
 * The shrunk, clamped estimate: `(fails + κ·parent) / (total + κ)`.
 *
 * With no observations this is exactly the parent's rate. As `total` grows past κ the slice's own
 * evidence dominates. Nothing special-cases the cold start — it falls out of the same formula.
 */
export function baselineRate(
  state: BaselineState,
  parentRate: number,
  config: BaselineConfig,
): number {
  const kappa = config.priorStrength;
  const raw = (state.fails + kappa * parentRate) / (state.total + kappa);
  return Math.min(config.ceiling, Math.max(config.floor, raw));
}

/**
 * How much of the estimate is the slice's own evidence rather than the inherited prior, in [0,1).
 * Reported alongside an incident so a reader can tell a well-evidenced alarm from a borrowed one.
 */
export function baselineConfidence(state: BaselineState, config: BaselineConfig): number {
  return state.total / (state.total + config.priorStrength);
}
