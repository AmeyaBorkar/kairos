/**
 * One prediction and what actually happened.
 *
 * Collected at decision time, before the outcome exists, for the same reason the steering holdout
 * records its arm on the plan: a number recorded after the fact is a number that can be chosen.
 */
export interface Prediction {
  readonly predicted: number;
  readonly recovered: boolean;
}

export interface CalibrationBin {
  readonly lower: number;
  readonly upper: number;
  readonly count: number;
  /** Mean predicted probability of the predictions that fell in this bin. */
  readonly predicted: number;
  /** Fraction of them that actually recovered. */
  readonly observed: number;
}

/**
 * Predicted probability against realised frequency, in bins.
 *
 * This is the artefact §7 promises to publish, and it is published rather than an accuracy figure
 * for a specific reason. Accuracy answers "how often is it right", which is not a question the
 * expected-value gate asks. The gate multiplies the probability by an amount, so what it needs to
 * know is whether 30% means thirty per cent. A model with an excellent AUC and systematically
 * inflated probabilities will chase every casualty it is shown and be wrong about the money every
 * time; a mediocre but calibrated one will decline the right ones.
 *
 * Empty bins are omitted rather than reported as zero, because a bin nobody predicted into says
 * nothing about the model and reporting it as `observed: 0` reads as a failure.
 */
export function calibrationCurve(
  predictions: readonly Prediction[],
  bins = 10,
): readonly CalibrationBin[] {
  if (bins <= 0) return [];

  const buckets = Array.from({ length: bins }, () => ({ sum: 0, hits: 0, count: 0 }));

  for (const p of predictions) {
    const clamped = Math.min(1, Math.max(0, p.predicted));
    // A prediction of exactly 1 belongs in the last bin, not in a bin past the end.
    const index = Math.min(bins - 1, Math.floor(clamped * bins));
    const bucket = buckets[index];
    if (bucket === undefined) continue;
    bucket.sum += clamped;
    bucket.hits += p.recovered ? 1 : 0;
    bucket.count += 1;
  }

  const curve: CalibrationBin[] = [];
  for (const [index, bucket] of buckets.entries()) {
    if (bucket.count === 0) continue;
    curve.push({
      lower: index / bins,
      upper: (index + 1) / bins,
      count: bucket.count,
      predicted: bucket.sum / bucket.count,
      observed: bucket.hits / bucket.count,
    });
  }
  return curve;
}

/**
 * Mean squared error of the probabilities. Lower is better; 0.25 is what a coin flip scores.
 *
 * Reported alongside the curve because the two fail differently: a model that predicts the base
 * rate for everything is perfectly calibrated and useless, and its Brier score says so.
 */
export function brierScore(predictions: readonly Prediction[]): number {
  if (predictions.length === 0) return 0;
  let total = 0;
  for (const p of predictions) {
    const error = p.predicted - (p.recovered ? 1 : 0);
    total += error * error;
  }
  return total / predictions.length;
}

/**
 * Expected calibration error: the average gap between promise and delivery, weighted by volume.
 *
 * The single number to quote when there is only room for one. It is in the same units as the
 * probability, so an ECE of 0.04 means "when this model says 30% the truth is somewhere around
 * 26–34%", which is a sentence a merchant can act on.
 */
export function expectedCalibrationError(curve: readonly CalibrationBin[]): number {
  const total = curve.reduce((sum, bin) => sum + bin.count, 0);
  if (total === 0) return 0;
  let error = 0;
  for (const bin of curve) {
    error += (bin.count / total) * Math.abs(bin.predicted - bin.observed);
  }
  return error;
}

/**
 * How much better than always predicting the base rate.
 *
 * The counterweight to calibration. A model that emits one number forever has an ECE of zero and no
 * skill whatsoever, so the scorecard reports both: calibration says the probabilities are honest,
 * this says they are worth having. Positive is better; zero or negative means the model is not
 * beating a constant.
 */
export function skillScore(predictions: readonly Prediction[]): number {
  if (predictions.length === 0) return 0;
  const base = predictions.filter((p) => p.recovered).length / predictions.length;
  const reference = base * (1 - base);
  if (reference === 0) return 0;
  return 1 - brierScore(predictions) / reference;
}
