import type { DetectorConfig } from "./detector.js";

/**
 * Starting configuration. Every number here is a hypothesis, not a result — the operating point is
 * chosen from the measured detection-latency versus false-alarm curve the benchmark produces, and
 * these values exist so that curve has somewhere to start.
 */
export const DEFAULT_DETECTOR_CONFIG: DetectorConfig = {
  baseline: {
    // A slice trusts its own evidence over the inherited prior once it has seen ~120 attempts.
    priorStrength: 120,
    // Effective window of roughly 2000 observations — long enough to be stable, short enough to
    // follow genuine drift in a rail's behaviour over weeks.
    decayPerObservation: 0.9995,
    // 0.2%. Below this the log-ratio starts treating a single failure as overwhelming evidence.
    floor: 0.002,
    // Above 50% a rail is not a healthy one with a raised rate; the framing no longer applies.
    ceiling: 0.5,
  },
  cusum: {
    // Four hypotheses spanning what actually goes wrong: a mild degradation, a bad one, a severe
    // one, and a rail that has essentially stopped working.
    shifts: [0.03, 0.08, 0.18, 0.4],
    threshold: 12,
    // Must sit *above* the largest jump a single failure can produce — at a 2% baseline the most
    // aggressive shift contributes log(0.42/0.02) ≈ 3.04. Set it lower and one ordinary failure
    // restarts the recovery dwell every time, so an incident can never clear at all.
    clearThreshold: 3.6,
    maxAlternativeRate: 0.95,
    // Roughly twice the threshold: enough headroom that a marginal alarm is not instantly
    // reversible, bounded enough that a long outage still clears promptly once the rail recovers.
    statisticCeiling: 24,
  },
  // Two minutes of sustained recovery before an incident is called resolved.
  clearDwellMs: 120_000,
  // A new slice watches for 200 attempts before it may alarm on its own. Its parent is watching the
  // same traffic in the meantime, so a real degradation is not missed.
  minObservations: 200,
};

/** Derive a variant with a different threshold — the sweep the benchmark runs. */
export function withThreshold(config: DetectorConfig, threshold: number): DetectorConfig {
  return {
    ...config,
    cusum: {
      ...config.cusum,
      threshold,
      // Proportional, but never below the single-failure jump — see the note on the default.
      clearThreshold: Math.max(3.6, threshold * 0.3),
      statisticCeiling: Math.max(config.cusum.statisticCeiling, threshold * 2),
    },
  };
}
