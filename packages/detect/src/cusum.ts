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
 *
 * ## Why there is a second statistic for the way back
 *
 * The bank above answers one question — "has the rate risen?" — and it answers it from a
 * known-quiet start, which is what the floor at zero provides. It is a bad instrument for the
 * opposite question, and for a reason that is structural rather than incidental.
 *
 * Once the rail heals, statistic `i` drifts at `−KL(p₀ ‖ p₀+δᵢ)`, which is monotone increasing in
 * δ. The aggressive statistics collapse in minutes; the sensitive one, whose whole job is to be
 * slow, walks down at a few thousandths of a nat per observation. Take the maximum over the bank
 * and the alarm is governed by the fastest riser — correct — while the *clear* is governed by the
 * slowest faller. Adding a more sensitive shift, to catch milder degradations, silently makes every
 * incident close later. Sensitivity and resolution latency were coupled through a quantity nobody
 * chose.
 *
 * So the way back gets its own test: {@link updateRecovery}, the same log-likelihood ratio with its
 * two rates swapped. It runs only while an incident is open, which is what keeps it unable to touch
 * detection latency or the false-alarm rate — both of those live entirely in the path out of
 * `quiet`, and this statistic does not exist there.
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
   *
   * This is the *absence* of evidence for a rise, and it is still a legitimate reason to clear —
   * it is simply not the only one, and on a sensitive shift it is not a reachable one. See
   * {@link CusumConfig.recoveryThreshold}.
   */
  readonly clearThreshold: number;
  /**
   * Evidence required to call an open incident over — the threshold on {@link updateRecovery}.
   *
   * Set equal to `threshold` by default, so a clear claims exactly as much as an alarm did. That
   * symmetry is a choice made for want of a better one: the costs are not symmetric — a false alarm
   * steers traffic off a healthy rail, a false clear stops steering off a broken one and is
   * self-correcting because the bank above is still running — but nothing here can price that
   * difference, and a symmetric bar is the one that can be stated in a sentence. Swept like every
   * other number rather than argued about.
   */
  readonly recoveryThreshold: number;
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

/**
 * The rate an alarm is claiming the rail has moved to: `p₀ + δ` for the **smallest** δ whose
 * statistic has crossed the threshold.
 *
 * Read once, at the moment an incident opens, and frozen alongside the baseline, because the honest
 * way to end a claim is to test the claim that was made rather than a different one.
 *
 * The smallest rather than the leading δ, and the difference is not academic. `leadingIndex` is the
 * argmax at one instant, and a burst of failures pushes the most aggressive statistic up fastest —
 * so an alarm raised during a burst freezes a claim like "this rail has gone from 12% to 52%" when
 * the sustained rate is nineteen. Measured on the `card-network` scenario, that is exactly what
 * happens: the incident opens on a hypothesis the traffic never supported, the recovery test
 * demolishes it in under four minutes and cover is lost on a rail that is genuinely degraded, until
 * a second incident opens with the right claim and holds. Reading the smallest crossing shift makes
 * the frozen claim the weakest one consistent with the alarm, which is the hardest to disprove and
 * therefore the safe direction to be wrong in.
 *
 * The leader is the fallback rather than the rule, for the case where nothing has crossed — which
 * cannot happen on the path that calls this, and is handled anyway rather than trusted.
 */
export function alternativeRate(state: CusumState, baseline: number, config: CusumConfig): number {
  let shift = config.shifts[leadingIndex(state)] ?? 0;
  for (let i = 0; i < config.shifts.length; i++) {
    const candidate = config.shifts[i] ?? 0;
    if (candidate < shift && (state.statistics[i] ?? 0) >= config.threshold) shift = candidate;
  }
  return Math.min(config.maxAlternativeRate, baseline + shift);
}

/**
 * Page's CUSUM again, pointing the other way: evidence that an open incident is over.
 *
 * ```
 *   LLR(success) = log( (1−p₀) / (1−p₁) )     positive — successes are evidence the rise has ended
 *   LLR(fail)    = log( p₀ / p₁ )             negative — failures are evidence it has not
 *   Rₙ = max(0, Rₙ₋₁ + LLR)                   clear when Rₙ ≥ recoveryThreshold
 * ```
 *
 * Identical machinery to {@link updateCusum} with `p₀` and `p₁` exchanged, which is why it is the
 * same function call with its arguments swapped rather than new arithmetic to get wrong.
 *
 * Three properties make it the right instrument for the job:
 *
 * - **It cannot clear a rail that is still broken.** Under the alternative the drift is
 *   `−KL(p₁ ‖ p₀) < 0`, so the statistic pins at its floor and stays there. There is no threshold
 *   and no amount of time that gets a genuinely degraded rail past it.
 * - **It crosses at the point the evidence changes sides**, not at either hypothesis. The drift is
 *   zero at `p* = log((1−p₀)/(1−p₁)) / [log((1−p₀)/(1−p₁)) + log(p₁/p₀)]`, which sits between the
 *   two rates — the standard CUSUM crossover. Below `p*` it climbs; above it, it does not.
 * - **Resolution latency mirrors detection latency**, because it is the same test run backwards
 *   against the same pair of rates. A collapse proved in three minutes is disproved in about
 *   three; a slow bleed that took twenty minutes to establish takes about twenty to retire. That
 *   symmetry is the property the one-sided version never had.
 *
 * What it does *not* claim is that the rail is perfect — only that the evidence has turned
 * decisively against the specific rise the incident was opened on. If the rate settles somewhere
 * milder but still elevated, the right outcome is this incident closing and a smaller one opening
 * to describe what is actually happening, and that is what the bank above then does.
 */
export function updateRecovery(
  previous: number,
  isFailure: boolean,
  baseline: number,
  alternative: number,
  config: CusumConfig,
): number {
  // A degenerate pair carries no information either way, and `log(1)` would silently freeze the
  // statistic at whatever it already held rather than saying so.
  if (!(alternative > baseline)) return 0;
  const accumulated = previous + logLikelihoodRatio(isFailure, alternative, baseline);
  /* Its own ceiling, derived rather than configured, for the same reason the bank above has one:
     without it a long stretch of healthy traffic banks unbounded credit for a recovery, and a rail
     that breaks again has to spend all of it before the incident can be re-asserted. Twice the
     threshold, which is the proportion `statisticCeiling` already keeps to — and separate from it,
     because the two thresholds are not the same number and the up-statistic's ceiling is load-bearing
     for detection. */
  return Math.min(config.recoveryThreshold * 2, Math.max(0, accumulated));
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
