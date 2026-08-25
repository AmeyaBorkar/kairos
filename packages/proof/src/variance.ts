/**
 * How much a number moves when nothing is wrong.
 *
 * This is the study that has to happen before a regression gate can be written honestly. Without
 * it, every tolerance is somebody's feel for the number, and the two ways of being wrong are both
 * bad: too tight and the gate cries wolf until it is ignored, too loose and it passes a real
 * regression while looking green.
 *
 * The measurement is: hold the code still, vary only the seed, and see how far the metric wanders.
 * That spread is the scale of a meaningless change. A code change that draws randomness differently
 * — an extra call to the generator, a loop reordered, a refactor nobody would call risky — moves a
 * fixed-seed benchmark by roughly one seed's worth, because it has effectively re-rolled the dice.
 * A gate must survive that or it is measuring the wrong thing.
 *
 * Two cautions the numbers do not carry themselves:
 *
 * 1. **The spread of a small run is wider than the spread of a large one.** Tolerances derived from
 *    the `quick` profile are conservative when applied to the `full` profile, which is the safe
 *    direction, and the gate runs `quick` anyway.
 * 2. **A standard deviation from eight seeds is itself an estimate**, uncertain by roughly a
 *    quarter of its own size. {@link suggestTolerance} rounds up rather than to nearest for that
 *    reason, and the count of seeds is recorded beside the tolerance in the baseline so a reviewer
 *    can see how much evidence stands behind it.
 */

export interface Spread {
  readonly n: number;
  readonly mean: number;
  /** Sample standard deviation, `n − 1` denominator: these seeds estimate a wider population. */
  readonly sd: number;
  readonly min: number;
  readonly max: number;
  /** `sd / |mean|`, or `null` at a mean of zero. Comparable across metrics of different scale. */
  readonly coefficientOfVariation: number | null;
  /**
   * Whether every seed produced the same number.
   *
   * Usually a signal that the quantity is arithmetic on the configuration rather than an outcome of
   * the simulation — a trial count, an arm count — and belongs in the baseline as an `exact`
   * invariant instead of as a metric with a band around it.
   */
  readonly degenerate: boolean;
}

export function summarise(samples: readonly number[]): Spread {
  if (samples.length === 0) throw new RangeError("a spread needs at least one sample");

  const n = samples.length;
  const mean = samples.reduce((a, b) => a + b, 0) / n;
  const variance = n < 2 ? 0 : samples.reduce((sum, x) => sum + (x - mean) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(variance);

  let min = samples[0] as number;
  let max = min;
  for (const x of samples) {
    if (x < min) min = x;
    if (x > max) max = x;
  }

  return {
    n,
    mean,
    sd,
    min,
    max,
    coefficientOfVariation: mean === 0 ? null : sd / Math.abs(mean),
    degenerate: max === min,
  };
}

/** Standard deviations of headroom. Three lets an innocent re-roll through 997 times in 1,000. */
export const DEFAULT_SIGMAS = 3;

/**
 * A tolerance a human would write down, from a standard deviation a machine measured.
 *
 * Rounded **up** to one, two or five times a power of ten. Up rather than to-nearest because the
 * standard deviation is itself estimated from a handful of seeds and rounding down would quietly
 * tighten a band that was already optimistic; to a round number because a tolerance of `1174.38` in
 * a committed file invites the reader to believe a precision that is not there.
 *
 * Returns `null` for a degenerate spread — every seed identical — because the answer there is not a
 * smaller tolerance, it is to make the thing an invariant.
 */
export function suggestTolerance(spread: Spread, sigmas = DEFAULT_SIGMAS): number | null {
  if (spread.degenerate) return null;

  const raw = spread.sd * sigmas;
  if (raw <= 0) return null;

  const magnitude = 10 ** Math.floor(Math.log10(raw));
  for (const step of [1, 2, 5]) {
    if (raw <= step * magnitude) return step * magnitude;
  }
  return 10 * magnitude;
}
