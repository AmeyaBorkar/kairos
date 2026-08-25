/**
 * Page's CUSUM over the Bernoulli log-likelihood ratio — the change detector itself.
 *
 * For each resolved attempt we accumulate evidence for "the failure rate has risen from `p₀` to
 * `p₁`" against "it is still `p₀`":
 *
 * ```
 *   LLR(fail)    = log( p₁ / p₀ )              positive — failures are evidence for the change
 *   LLR(success) = log( (1−p₁) / (1−p₀) )      negative — successes are evidence against it
 *   Sₙ = max(0, Sₙ₋₁ + LLR)                    alarm when Sₙ ≥ h
 * ```
 *
 * The floor at zero is what adapts it to an unknown changepoint: evidence accumulated before the
 * rail broke is discarded rather than held against it, so the statistic measures the current
 * excursion only.
 *
 * Why this rather than "alert if failure rate exceeds 20% over five minutes":
 *
 * - **Valid under continuous monitoring.** The underlying likelihood ratio is a non-negative
 *   martingale under `p₀`, so looking at every observation does not inflate the error the way
 *   repeated testing invalidates a fixed-sample window. Note what this does *not* say: the floor at
 *   zero restarts the statistic, so Ville's `e^-h` bound applies to the non-resetting martingale,
 *   not to this. A resetting CUSUM alarms eventually with probability one, and its operating
 *   characteristic is the average run length to false alarm — a quantity that has to be measured,
 *   which is what the benchmark exists to do. Quoting `e^-h` here would be an overclaim.
 * - **Volume-adaptive.** A busy slice accumulates evidence quickly and a quiet one slowly, from the
 *   same statistic. A fixed window is simultaneously too slow for the first and too jumpy for the
 *   second.
 * - **O(1) state.** One float per shift size per slice, at tens of thousands of slices.
 *
 * The shift size δ is unknown, so several CUSUMs run in parallel over a spread of δ and the alarm
 * is the maximum. A small shift is detected eventually by the sensitive statistic; a collapse is
 * detected almost immediately by the aggressive one.
 */
export interface CusumConfig {
  /**
   * Absolute increments above baseline to test for. Each gets its own statistic.
   * Small values detect slow degradations late; large values detect collapses at once.
   */
  readonly shifts: readonly number[];
  /** Alarm threshold `h`. Higher means fewer false alarms and slower detection. */
  readonly threshold: number;
  /**
   * Threshold for leaving the alarmed state, below `threshold`. The gap is a Schmitt trigger:
   * a single threshold makes the detector chatter at the boundary, steering on and off every few
   * seconds, which is worse for a merchant than never having steered.
   */
  readonly clearThreshold: number;
  /** Clamp on `p₁`. Keeps `log(1−p₁)` finite when baseline plus shift would reach 1. */
  readonly maxAlternativeRate: number;
  /**
   * Ceiling on each statistic.
   *
   * Without it a long outage accumulates enormous evidence, and once the rail recovers the
   * statistic has to be walked all the way back down before the detector can clear — a two-hour
   * degradation would leave steering stuck on long after the rail was healthy. Capping bounds
   * recovery time to a fixed number of successes.
   *
   * The false-alarm guarantee survives: capping only ever lowers the statistic, so it cannot make
   * a crossing of `threshold` happen that would not have happened anyway.
   */
  readonly statisticCeiling: number;
}

export interface CusumState {
  /** One statistic per configured shift. */
  readonly statistics: readonly number[];
  /**
   * For each statistic, when its current positive excursion began.
   *
   * This is the changepoint estimate. When a statistic alarms, the moment it last left zero is
   * when the evidence started accumulating — which is the best available estimate of when the rail
   * actually broke, and is what detection latency must be measured from. Measuring from the alarm
   * instead would flatter the detector by exactly the quantity being measured.
   */
  readonly excursionStartedAt: readonly number[];
}

export function emptyCusum(config: CusumConfig): CusumState {
  return {
    statistics: config.shifts.map(() => 0),
    excursionStartedAt: config.shifts.map(() => 0),
  };
}

/** Log-likelihood ratio contributed by one observation. */
export function logLikelihoodRatio(isFailure: boolean, p0: number, p1: number): number {
  return isFailure ? Math.log(p1 / p0) : Math.log((1 - p1) / (1 - p0));
}

/** Advance every statistic by one observation. Pure. */
export function updateCusum(
  state: CusumState,
  isFailure: boolean,
  baseline: number,
  at: number,
  config: CusumConfig,
): CusumState {
  const statistics: number[] = [];
  const excursionStartedAt: number[] = [];

  for (let i = 0; i < config.shifts.length; i++) {
    const shift = config.shifts[i] ?? 0;
    const previous = state.statistics[i] ?? 0;
    const previousStart = state.excursionStartedAt[i] ?? at;

    const p1 = Math.min(config.maxAlternativeRate, baseline + shift);
    const accumulated = Math.max(0, previous + logLikelihoodRatio(isFailure, baseline, p1));
    const next = Math.min(config.statisticCeiling, accumulated);

    statistics.push(next);
    if (next <= 0 || previous <= 0) {
      // Either the excursion just ended, or it starts here.
      excursionStartedAt.push(at);
    } else {
      excursionStartedAt.push(previousStart);
    }
  }

  return { statistics, excursionStartedAt };
}

/** Index of the statistic carrying the most evidence. */
export function leadingIndex(state: CusumState): number {
  let best = 0;
  let bestValue = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < state.statistics.length; i++) {
    const value = state.statistics[i] ?? 0;
    if (value > bestValue) {
      bestValue = value;
      best = i;
    }
  }
  return best;
}

/** The strongest evidence currently held, across all shifts. */
export function peakStatistic(state: CusumState): number {
  return state.statistics[leadingIndex(state)] ?? 0;
}

/** Changepoint estimate from whichever statistic leads. */
export function changepoint(state: CusumState): number {
  return state.excursionStartedAt[leadingIndex(state)] ?? 0;
}

/**
 * The e-value form, `exp(S)`.
 *
 * This is the quantity Ville's inequality bounds, and it is what a multiplicity procedure consumes
 * when thousands of slices are watched at once — e-values combine across dependent tests, which
 * p-values do not, and slices sharing an issuer or a gateway are emphatically dependent.
 */
export function eValue(state: CusumState): number {
  return Math.exp(peakStatistic(state));
}
