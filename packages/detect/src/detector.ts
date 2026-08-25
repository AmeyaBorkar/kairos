import {
  type BaselineConfig,
  type BaselineState,
  baselineConfidence,
  baselineRate,
  EMPTY_BASELINE,
  observeBaseline,
} from "./baseline.js";
import {
  type CusumConfig,
  type CusumState,
  changepoint,
  emptyCusum,
  peakStatistic,
  updateCusum,
} from "./cusum.js";

/**
 * Three states, not a boolean.
 *
 * `clearing` exists because evidence dropping below the clear threshold is not the same as the rail
 * being healthy — a degradation that oscillates would otherwise open and close an incident every
 * few seconds. A minimum dwell in `clearing` makes recovery a claim the rail has to sustain.
 */
export type DetectorPhase = "quiet" | "alarmed" | "clearing";

export interface DetectorConfig {
  readonly baseline: BaselineConfig;
  readonly cusum: CusumConfig;
  /** How long the statistic must stay low before an incident is called resolved. */
  readonly clearDwellMs: number;
  /**
   * Observations a slice must have seen before it may raise an alarm of its own.
   *
   * A brand-new slice inherits its parent's baseline, and if the parent's rate is wrong for it,
   * its first few attempts look like a change. Nothing is lost by waiting: the parent slice is
   * watching the same traffic and will alarm if the degradation is real and broad.
   */
  readonly minObservations: number;
}

export interface DetectorState {
  readonly baseline: BaselineState;
  /**
   * Counts over a much shorter window, used only for reporting the rate a human would see.
   * Never feeds the statistic.
   */
  readonly recent: BaselineState;
  readonly cusum: CusumState;
  readonly phase: DetectorPhase;
  /**
   * Baseline frozen at the moment the incident opened.
   *
   * Without this the incident poisons its own baseline: a rail failing at 35% for twenty minutes
   * teaches the estimator that 35% is normal, the statistic falls back to zero, and the detector
   * quietly declares the outage over while it is still happening. Every long degradation would
   * self-heal on paper.
   */
  readonly frozenBaseline: number | null;
  readonly onsetAt: number | null;
  readonly alarmedAt: number | null;
  readonly clearingSince: number | null;
  readonly peakRate: number;
  readonly observations: number;
}

export function emptyDetector(config: DetectorConfig): DetectorState {
  return {
    baseline: EMPTY_BASELINE,
    recent: EMPTY_BASELINE,
    cusum: emptyCusum(config.cusum),
    phase: "quiet",
    frozenBaseline: null,
    onsetAt: null,
    alarmedAt: null,
    clearingSince: null,
    peakRate: 0,
    observations: 0,
  };
}

export interface Observation {
  readonly isFailure: boolean;
  readonly at: number;
  /**
   * The parent slice's current rate, for shrinkage. A method-level slice — which has no parent —
   * passes the global rate across all traffic.
   */
  readonly parentRate: number;
}

export type Transition = "none" | "opened" | "clearing" | "reopened" | "resolved";

export interface Verdict {
  readonly transition: Transition;
  readonly phase: DetectorPhase;
  /** Estimated changepoint. Present from `opened` onward, and it is what latency is measured from. */
  readonly onsetAt: number | null;
  readonly statistic: number;
  /** The baseline in force — frozen while an incident is open. */
  readonly baselineRate: number;
  /** Failure rate over the short window, for display. */
  readonly observedRate: number;
  /** Share of the baseline that is the slice's own evidence rather than inherited, in [0,1). */
  readonly confidence: number;
}

/** Faster decay than the baseline: this tracks what is happening now, not what is normal. */
const RECENT_DECAY = 0.97;

/**
 * Fold one resolved attempt into a slice's detector. Pure — the clock arrives in `observation.at`.
 */
export function observe(
  state: DetectorState,
  observation: Observation,
  config: DetectorConfig,
): { readonly state: DetectorState; readonly verdict: Verdict } {
  const { isFailure, at, parentRate } = observation;

  const recent: BaselineState = {
    fails: state.recent.fails * RECENT_DECAY + (isFailure ? 1 : 0),
    total: state.recent.total * RECENT_DECAY + 1,
  };
  const observedRate = recent.total > 0 ? recent.fails / recent.total : 0;

  // The baseline is frozen for the whole life of an incident, including while clearing.
  const frozen = state.phase !== "quiet";
  const baseline = frozen
    ? state.baseline
    : observeBaseline(state.baseline, isFailure, config.baseline);
  const effectiveRate = state.frozenBaseline ?? baselineRate(baseline, parentRate, config.baseline);

  const cusum = updateCusum(state.cusum, isFailure, effectiveRate, at, config.cusum);
  const statistic = peakStatistic(cusum);
  const observations = state.observations + 1;

  const warm = observations >= config.minObservations;
  const tripped = warm && statistic >= config.cusum.threshold;
  const low = statistic < config.cusum.clearThreshold;

  let phase = state.phase;
  let transition: Transition = "none";
  let onsetAt = state.onsetAt;
  let alarmedAt = state.alarmedAt;
  let clearingSince = state.clearingSince;
  let frozenBaseline = state.frozenBaseline;
  let peakRate = Math.max(state.peakRate, observedRate);

  switch (state.phase) {
    case "quiet":
      if (tripped) {
        phase = "alarmed";
        transition = "opened";
        onsetAt = changepoint(cusum);
        alarmedAt = at;
        clearingSince = null;
        frozenBaseline = effectiveRate;
        peakRate = observedRate;
      }
      break;

    case "alarmed":
      if (low) {
        phase = "clearing";
        transition = "clearing";
        clearingSince = at;
      }
      break;

    case "clearing":
      if (tripped) {
        phase = "alarmed";
        transition = "reopened";
        clearingSince = null;
      } else if (low && clearingSince !== null && at - clearingSince >= config.clearDwellMs) {
        phase = "quiet";
        transition = "resolved";
        onsetAt = null;
        alarmedAt = null;
        clearingSince = null;
        frozenBaseline = null;
        peakRate = 0;
      } else if (!low) {
        // Recovered above the clear threshold but not to an alarm. Restart the dwell.
        clearingSince = at;
      }
      break;
  }

  return {
    state: {
      baseline,
      recent,
      cusum,
      phase,
      frozenBaseline,
      onsetAt,
      alarmedAt,
      clearingSince,
      peakRate,
      observations,
    },
    verdict: {
      transition,
      phase,
      onsetAt,
      statistic,
      baselineRate: effectiveRate,
      observedRate,
      confidence: baselineConfidence(baseline, config.baseline),
    },
  };
}
