import {
  type BaselineConfig,
  type BaselineState,
  baselineConfidence,
  baselineRate,
  EMPTY_BASELINE,
  observeBaseline,
} from "./baseline.js";
import {
  alternativeRate,
  type CusumConfig,
  type CusumState,
  changepoint,
  emptyCusum,
  peakStatistic,
  updateCusum,
  updateRecovery,
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
  /**
   * The rate the alarm was actually raised on, frozen with the baseline at the moment it opened.
   *
   * An incident is a claim — "this rail has gone from `frozenBaseline` to about this" — and the
   * pair is what {@link DetectorState.recovery} later tests. Frozen for the same reason the
   * baseline is: a claim that drifts while it is being argued cannot be settled.
   */
  readonly frozenAlternative: number | null;
  /**
   * Evidence accumulated since the incident opened that it is over. Zero while quiet.
   *
   * Separate from the bank above because the two answer opposite questions and the bank is only
   * good at one of them — see the note on `updateRecovery`.
   */
  readonly recovery: number;
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
    frozenAlternative: null,
    recovery: 0,
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
  /**
   * Evidence that an open incident is over, against `recoveryThreshold`. Zero while quiet.
   *
   * Reported because an operator watching a resolution should be able to see it being argued
   * rather than have it happen to them.
   */
  readonly recoveryStatistic: number;
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

  /* The mirror statistic exists only while an incident is open. That is not tidiness: it is the
     whole reason this can be changed at all. Detection latency and the false-alarm rate are
     properties of the path *out of* `quiet`, and nothing below runs there. */
  const recovery =
    state.phase === "quiet" || state.frozenAlternative === null
      ? 0
      : updateRecovery(
          state.recovery,
          isFailure,
          effectiveRate,
          state.frozenAlternative,
          config.cusum,
        );

  const tripped = warm && statistic >= config.cusum.threshold;
  /* Two independent reasons to stop asserting an incident, and either will do.
     `low`  — the evidence for a rise has drained away.
     `over` — there is positive evidence the rise has ended.
     Keeping `low` as an alternative rather than replacing it is what makes this change
     one-directional: no incident can close later than it would have before. */
  const low = statistic < config.cusum.clearThreshold;
  const over = recovery >= config.cusum.recoveryThreshold;
  const settled = low || over;

  let phase = state.phase;
  let transition: Transition = "none";
  let onsetAt = state.onsetAt;
  let alarmedAt = state.alarmedAt;
  let clearingSince = state.clearingSince;
  let frozenBaseline = state.frozenBaseline;
  let frozenAlternative = state.frozenAlternative;
  let nextRecovery = recovery;
  let nextCusum = cusum;
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
        frozenAlternative = alternativeRate(cusum, effectiveRate, config.cusum);
        nextRecovery = 0;
        peakRate = observedRate;
      }
      break;

    case "alarmed":
      if (settled) {
        phase = "clearing";
        transition = "clearing";
        clearingSince = at;
      }
      break;

    case "clearing":
      /* A reopen has to be argued on evidence the recovery test has not already answered.
         Without `!over` this thrashes: the moment `over` carries the incident into `clearing`,
         the bank above is still holding evidence from the outage itself — a statistic near its
         ceiling, well past `threshold` — so the next observation reopens on it and discards the
         recovery evidence, and the two statistics saw-tooth against each other forever. Requiring
         the recovery argument to have collapsed first costs nothing where the rail is healthy,
         because there the argument only strengthens; where the rail really has broken again,
         failures drain it in tens of observations and the reopen follows immediately. The
         incident stays open throughout `clearing`, so nothing is unsteered while that happens. */
      if (tripped && !over) {
        phase = "alarmed";
        transition = "reopened";
        clearingSince = null;
        // The incident has been re-asserted, so the argument that it was over is spent.
        nextRecovery = 0;
      } else if (settled && clearingSince !== null && at - clearingSince >= config.clearDwellMs) {
        phase = "quiet";
        transition = "resolved";
        onsetAt = null;
        alarmedAt = null;
        clearingSince = null;
        frozenBaseline = null;
        frozenAlternative = null;
        nextRecovery = 0;
        peakRate = 0;
        /* Restart the bank — Page's own procedure, which alarms and then begins again, and the
           step this detector was missing. Without it an incident closed on recovery evidence
           leaves a statistic still above `threshold`, and the next observation re-alarms on
           evidence about an outage just declared over. Safe for the false-alarm rate by the same
           argument `statisticCeiling` rests on: it only ever lowers the statistic, so it cannot
           produce a crossing that would not have happened anyway. */
        nextCusum = emptyCusum(config.cusum);
      } else if (!settled) {
        // Rose back above the clear threshold but not to an alarm. Restart the dwell.
        clearingSince = at;
      }
      break;
  }

  return {
    state: {
      baseline,
      recent,
      cusum: nextCusum,
      phase,
      frozenBaseline,
      frozenAlternative,
      recovery: nextRecovery,
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
      recoveryStatistic: recovery,
      baselineRate: effectiveRate,
      observedRate,
      confidence: baselineConfidence(baseline, config.baseline),
    },
  };
}
