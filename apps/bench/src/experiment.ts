import {
  DEFAULT_DETECTOR_CONFIG,
  DetectionEngine,
  type EngineConfig,
  withThreshold,
} from "@kairos/detect";
import { type Slice, sliceCovers, sliceKey } from "@kairos/domain";
import {
  type Degradation,
  degradationEndsAt,
  generate,
  INDIA_PROFILES,
  type SimulatorConfig,
} from "@kairos/simulator";

const MINUTE = 60_000;

/**
 * A named degradation shape.
 *
 * The set below is chosen to include the cases the detector is *bad* at, not only the ones it
 * handles well. A curve measured only on cliff-edge outages on high-volume rails would be a
 * flattering number that says nothing about the slow bleed on a thin slice, which is the case that
 * actually costs a merchant money for hours.
 */
export interface Scenario {
  readonly name: string;
  readonly description: string;
  readonly build: (onsetAt: number) => Degradation;
}

export const SCENARIOS: readonly Scenario[] = [
  {
    name: "issuer-collapse",
    description: "HDFC UPI drops to 55% failure instantly — the easy case",
    build: (onsetAt) => ({
      slice: { method: "upi", issuer: "hdfc", instrument: null },
      onsetAt,
      rampMs: 0,
      peakFailureRate: 0.55,
      holdMs: 40 * MINUTE,
      recoveryMs: 3 * MINUTE,
    }),
  },
  {
    name: "issuer-moderate",
    description: "SBI UPI degrades to 22% over two minutes",
    build: (onsetAt) => ({
      slice: { method: "upi", issuer: "sbi", instrument: null },
      onsetAt,
      rampMs: 2 * MINUTE,
      peakFailureRate: 0.22,
      holdMs: 40 * MINUTE,
      recoveryMs: 5 * MINUTE,
    }),
  },
  {
    name: "slow-bleed",
    description: "ICICI UPI creeps to 14% over fifteen minutes — the hard case",
    build: (onsetAt) => ({
      slice: { method: "upi", issuer: "icici", instrument: null },
      onsetAt,
      rampMs: 15 * MINUTE,
      peakFailureRate: 0.14,
      holdMs: 40 * MINUTE,
      recoveryMs: 10 * MINUTE,
    }),
  },
  {
    name: "single-app",
    description: "Only PhonePe-on-HDFC breaks, at 45% — a narrow slice inside a healthy issuer",
    build: (onsetAt) => ({
      slice: { method: "upi", issuer: "hdfc", instrument: "phonepe" },
      onsetAt,
      rampMs: MINUTE,
      peakFailureRate: 0.45,
      holdMs: 40 * MINUTE,
      recoveryMs: 3 * MINUTE,
    }),
  },
  {
    name: "thin-slice",
    description: "Canara-on-Paytm at 50%, on roughly four attempts a minute — barely any evidence",
    build: (onsetAt) => ({
      slice: { method: "upi", issuer: "canara", instrument: "paytm" },
      onsetAt,
      rampMs: 0,
      peakFailureRate: 0.5,
      holdMs: 40 * MINUTE,
      recoveryMs: 3 * MINUTE,
    }),
  },
  {
    name: "card-network",
    description: "HDFC Visa from 11% to 34% — a rail whose baseline is already high",
    build: (onsetAt) => ({
      slice: { method: "card", issuer: "hdfc", instrument: "visa" },
      onsetAt,
      rampMs: MINUTE,
      peakFailureRate: 0.34,
      holdMs: 40 * MINUTE,
      recoveryMs: 5 * MINUTE,
    }),
  },
];

export interface ExperimentOptions {
  readonly thresholds: readonly number[];
  /** Independent runs per (threshold, scenario) cell. Sets the sample size behind every latency. */
  readonly seedsPerCell: number;
  /**
   * Independent runs of the *healthy* arm per threshold, which is the false-alarm rate's denominator.
   *
   * Separate from {@link ExperimentOptions.seedsPerCell} because the two size different things and
   * cost different amounts. A healthy trial injects no degradation, so it is the cheapest run in the
   * sweep; a scenario trial is what the sweep spends its time on. Tying them meant the quick profile
   * observed fifty minutes of healthy traffic, in which a *single* false alarm reads as 1.2 an hour
   * — five times the budget the project has declared. A rate cannot be gated against a threshold it
   * cannot resolve, and the fix is more denominator rather than a wider band.
   */
  readonly healthySeeds: number;
  /**
   * Shifts every seed in the sweep, so the whole curve can be re-drawn on fresh randomness.
   *
   * Zero for every run that is reported, which keeps published numbers reproducible. The seed study
   * in `apps/bench/src/variance.ts` varies it to find out how far these numbers move when nothing
   * is wrong, which is what the regression gate's tolerances are derived from.
   */
  readonly seedBase: number;
  readonly attemptsPerMinute: number;
  /** Quiet lead-in before the degradation, so baselines are established first. */
  readonly warmupMs: number;
  readonly observeMs: number;
  readonly scenarios: readonly Scenario[];
}

export const DEFAULT_OPTIONS: ExperimentOptions = {
  thresholds: [6, 8, 10, 12, 14, 17, 21],
  seedsPerCell: 4,
  healthySeeds: 12,
  seedBase: 0,
  attemptsPerMinute: 400,
  warmupMs: 25 * MINUTE,
  observeMs: 45 * MINUTE,
  scenarios: SCENARIOS,
};

/** Two slices on the same root-to-leaf path — either may explain the other. */
function related(a: Slice, b: Slice): boolean {
  return sliceCovers(a, b) || sliceCovers(b, a);
}

export interface DetectionOutcome {
  readonly scenario: string;
  readonly seed: number;
  readonly detected: boolean;
  /** Alarm time minus **true** onset. The ground truth, not the detector's own estimate. */
  readonly latencyMs: number | null;
  /** Estimated onset minus true onset. Negative means the estimate ran early. */
  readonly onsetErrorMs: number | null;
  /** Whether the incident was reported at exactly the degraded slice rather than above or below it. */
  readonly rightAltitude: boolean;
}

function engineConfig(threshold: number): EngineConfig {
  return { ...withThreshold(DEFAULT_DETECTOR_CONFIG, threshold), rollup: true };
}

/** Run one degradation scenario once and report what the detector did with it. */
export function runDetectionTrial(
  scenario: Scenario,
  threshold: number,
  seed: number,
  options: ExperimentOptions,
): DetectionOutcome {
  const startAt = 1_756_000_000_000;
  const onsetAt = startAt + options.warmupMs;
  const degradation = scenario.build(onsetAt);

  const simulation: SimulatorConfig = {
    seed,
    startAt,
    durationMs: options.warmupMs + options.observeMs,
    attemptsPerMinute: options.attemptsPerMinute,
    profiles: INDIA_PROFILES,
    degradations: [degradation],
  };

  const engine = new DetectionEngine(engineConfig(threshold));
  const deadline = Math.min(degradationEndsAt(degradation), startAt + simulation.durationMs);

  for (const attempt of generate(simulation)) {
    for (const event of engine.observe(attempt)) {
      if (event.kind !== "opened") continue;
      const incident = event.incident;
      // Only count alarms that are about this degradation, and only before it has ended.
      if (!related(incident.slice, degradation.slice)) continue;
      if (incident.detectedAt < onsetAt || incident.detectedAt > deadline) continue;

      return {
        scenario: scenario.name,
        seed,
        detected: true,
        latencyMs: incident.detectedAt - onsetAt,
        onsetErrorMs: incident.onsetAt - onsetAt,
        rightAltitude: sliceKey(incident.slice) === sliceKey(degradation.slice),
      };
    }
  }

  return {
    scenario: scenario.name,
    seed,
    detected: false,
    latencyMs: null,
    onsetErrorMs: null,
    rightAltitude: false,
  };
}

/** Run a healthy hour and count how many times the detector cried wolf. */
export function runHealthyTrial(
  threshold: number,
  seed: number,
  options: ExperimentOptions,
): { readonly alarms: number; readonly hours: number } {
  const startAt = 1_756_000_000_000;
  const durationMs = options.warmupMs + options.observeMs;

  const simulation: SimulatorConfig = {
    seed,
    startAt,
    durationMs,
    attemptsPerMinute: options.attemptsPerMinute,
    profiles: INDIA_PROFILES,
    degradations: [],
  };

  const engine = new DetectionEngine(engineConfig(threshold));
  let alarms = 0;

  for (const attempt of generate(simulation)) {
    for (const event of engine.observe(attempt)) {
      // Warmup alarms still count. A detector that fires while learning is still firing.
      if (event.kind === "opened") alarms++;
    }
  }

  return { alarms, hours: durationMs / 3_600_000 };
}

/**
 * The resolution arm — how long an incident stays open after the rail is healthy again.
 *
 * This exists because the two arms above cannot see it, and that blindness is not academic. A
 * detection trial stops watching 45 minutes after onset, which for most of these scenarios is a
 * minute or two after the rail heals — nowhere near long enough to watch an incident close. So the
 * sweep could report a 93-second median detection latency while the same detector held incidents
 * open for six hours, and nothing in this repository would disagree with either number. It did
 * exactly that, and it took building a console to notice.
 *
 * Its own options rather than a longer {@link ExperimentOptions}, because lengthening the shared
 * window would change the healthy arm's denominator and the detection arm's deadline — re-baselining
 * two published measurements in order to fix a third.
 */
export interface ResolutionOptions {
  readonly thresholds: readonly number[];
  readonly seedsPerCell: number;
  readonly seedBase: number;
  readonly attemptsPerMinute: number;
  readonly warmupMs: number;
  /**
   * How long to keep watching after the rail is healthy.
   *
   * Generous on purpose. A trial that runs out of traffic reports "never resolved", and a tail so
   * short that every trial reported it would flatter nothing but would also say nothing.
   */
  readonly tailMs: number;
  readonly scenarios: readonly Scenario[];
}

export const DEFAULT_RESOLUTION_OPTIONS: ResolutionOptions = {
  thresholds: [6, 8, 10, 12, 14, 17, 21],
  seedsPerCell: 4,
  seedBase: 0,
  attemptsPerMinute: 400,
  warmupMs: 25 * MINUTE,
  tailMs: 90 * MINUTE,
  scenarios: SCENARIOS,
};

export interface ResolutionOutcome {
  readonly scenario: string;
  readonly seed: number;
  readonly opened: boolean;
  readonly resolved: boolean;
  /**
   * Resolve time minus the moment the rail was **actually** healthy, taken from the simulator rather
   * than from anything the detector believes.
   */
  readonly resolutionLatencyMs: number | null;
  /** Whether an incident was open at the worst moment of the degradation. */
  readonly heldThroughPeak: boolean;
  /**
   * Whether it let go while the rail was still at its peak failure rate.
   *
   * The failure a fast clear could introduce, and the reason this is reported next to the latency
   * rather than underneath it. A resolution latency of zero achieved by clearing early is not an
   * improvement; it is a different bug wearing the first one's number.
   */
  readonly clearedEarly: boolean;
}

/** Watch one degradation from onset to well past its recovery, and time the close. */
export function runResolutionTrial(
  scenario: Scenario,
  threshold: number,
  seed: number,
  options: ResolutionOptions,
): ResolutionOutcome {
  const startAt = 1_756_000_000_000;
  const onsetAt = startAt + options.warmupMs;
  const degradation = scenario.build(onsetAt);

  // Three instants the simulator knows and the detector does not: the worst of it, the last moment
  // it is still at its worst, and the moment it is genuinely over.
  const peakAt = onsetAt + degradation.rampMs + degradation.holdMs / 2;
  const stillPeakUntil = onsetAt + degradation.rampMs + degradation.holdMs;
  const healthyAt = degradationEndsAt(degradation);

  const simulation: SimulatorConfig = {
    seed,
    startAt,
    durationMs: healthyAt - startAt + options.tailMs,
    attemptsPerMinute: options.attemptsPerMinute,
    profiles: INDIA_PROFILES,
    degradations: [degradation],
  };

  const engine = new DetectionEngine(engineConfig(threshold));
  const gapMs = 60_000 / options.attemptsPerMinute;
  const endsAt = startAt + simulation.durationMs;

  /* Asked of the open set rather than of the event stream, and that is not a detail.
     Rollup moves an incident between altitudes mid-flight: a leaf degradation can be reported at
     its issuer, superseded by its method, and closed there. Following one slice's `resolved` event
     would score that as an early clear while the degradation was still covered a level up. What
     the merchant experiences is whether *anything* covering the broken rail is open, so that is
     what gets measured. */
  const covered = (): boolean =>
    engine.openIncidents().some((i) => related(i.slice, degradation.slice));

  let openedAt: number | null = null;
  let lastCoveredAt: number | null = null;
  let heldThroughPeak = false;
  let clearedEarly = false;

  for (const attempt of generate(simulation)) {
    for (const event of engine.observe(attempt)) {
      if (
        event.kind === "opened" &&
        openedAt === null &&
        related(event.incident.slice, degradation.slice) &&
        event.incident.detectedAt >= onsetAt
      ) {
        openedAt = event.incident.detectedAt;
      }
    }

    const open = covered();
    if (open) lastCoveredAt = attempt.at;

    if (openedAt !== null && attempt.at > openedAt) {
      // A gap in cover while the rail is still at its worst. Nothing else in the sweep sees this.
      if (!open && attempt.at < stillPeakUntil) clearedEarly = true;
      if (Math.abs(attempt.at - peakAt) < gapMs * 5 && open) heldThroughPeak = true;
    }
  }

  /* The moment it finally let go, measured as the last instant anything covering the rail was
     open. Robust to an incident closing and a milder one opening in its place, which is a real
     outcome rather than a defect — but which the merchant still experiences as one continuous
     stretch of being steered. */
  const stillOpen = lastCoveredAt !== null && lastCoveredAt >= endsAt - gapMs * 20;

  /* A resolution latency only means anything on a trial where the incident actually outlived the
     outage. Where cover ended *before* the rail healed, the difference is negative, and folding a
     negative into the median would make the headline smaller for the one reason that is not an
     improvement. Those trials report no latency and are counted in `clearedEarly` instead, which
     the report prints in the next column along. */
  const outlived =
    openedAt !== null && !stillOpen && lastCoveredAt !== null && lastCoveredAt >= healthyAt;

  return {
    scenario: scenario.name,
    seed,
    opened: openedAt !== null,
    resolved: openedAt !== null && !stillOpen,
    resolutionLatencyMs: outlived && lastCoveredAt !== null ? lastCoveredAt - healthyAt : null,
    heldThroughPeak,
    clearedEarly,
  };
}

export interface ResolutionScenarioResult {
  readonly scenario: string;
  readonly description: string;
  readonly trials: number;
  readonly opened: number;
  readonly resolved: number;
  readonly medianResolutionMs: number | null;
  readonly p90ResolutionMs: number | null;
  readonly heldThroughPeak: number;
  readonly clearedEarly: number;
}

export interface ResolutionThresholdResult {
  readonly threshold: number;
  readonly trials: number;
  readonly opened: number;
  readonly resolved: number;
  readonly medianResolutionMs: number | null;
  readonly p90ResolutionMs: number | null;
  /** Trials where an incident was open at the worst moment. Should equal `opened`. */
  readonly heldThroughPeak: number;
  /** Trials where it let go while the rail was still at peak. Should be zero. */
  readonly clearedEarly: number;
  readonly scenarios: readonly ResolutionScenarioResult[];
}

export interface ResolutionResult {
  readonly options: ResolutionOptions;
  readonly thresholds: readonly ResolutionThresholdResult[];
}

/** The resolution sweep. Deterministic, like everything else here. */
export function runResolutionStudy(
  options: ResolutionOptions = DEFAULT_RESOLUTION_OPTIONS,
  onProgress?: (done: number, total: number) => void,
): ResolutionResult {
  const total = options.thresholds.length * options.scenarios.length * options.seedsPerCell;
  let done = 0;

  const thresholds = options.thresholds.map((threshold) => {
    const all: ResolutionOutcome[] = [];

    const scenarios = options.scenarios.map((scenario) => {
      const outcomes: ResolutionOutcome[] = [];
      for (let s = 0; s < options.seedsPerCell; s++) {
        outcomes.push(
          runResolutionTrial(scenario, threshold, options.seedBase + 1000 + s * 31, options),
        );
        onProgress?.(++done, total);
      }
      all.push(...outcomes);

      const latencies = outcomes
        .map((o) => o.resolutionLatencyMs)
        .filter((v): v is number => v !== null);

      return {
        scenario: scenario.name,
        description: scenario.description,
        trials: outcomes.length,
        opened: outcomes.filter((o) => o.opened).length,
        resolved: outcomes.filter((o) => o.resolved).length,
        medianResolutionMs: percentile(latencies, 50),
        p90ResolutionMs: percentile(latencies, 90),
        heldThroughPeak: outcomes.filter((o) => o.heldThroughPeak).length,
        clearedEarly: outcomes.filter((o) => o.clearedEarly).length,
      };
    });

    const latencies = all.map((o) => o.resolutionLatencyMs).filter((v): v is number => v !== null);

    return {
      threshold,
      trials: all.length,
      opened: all.filter((o) => o.opened).length,
      resolved: all.filter((o) => o.resolved).length,
      medianResolutionMs: percentile(latencies, 50),
      p90ResolutionMs: percentile(latencies, 90),
      heldThroughPeak: all.filter((o) => o.heldThroughPeak).length,
      clearedEarly: all.filter((o) => o.clearedEarly).length,
      scenarios,
    };
  });

  return { options, thresholds };
}

export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? null;
}

export interface ScenarioResult {
  readonly scenario: string;
  readonly description: string;
  readonly trials: number;
  readonly detected: number;
  readonly detectionRate: number;
  readonly medianLatencyMs: number | null;
  readonly p90LatencyMs: number | null;
  readonly medianOnsetErrorMs: number | null;
  readonly rightAltitudeRate: number;
}

export interface ThresholdResult {
  readonly threshold: number;
  readonly falseAlarmsPerHour: number;
  readonly healthyHours: number;
  readonly totalFalseAlarms: number;
  readonly overallDetectionRate: number;
  readonly overallMedianLatencyMs: number | null;
  readonly scenarios: readonly ScenarioResult[];
}

export interface CurveResult {
  readonly options: ExperimentOptions;
  readonly thresholds: readonly ThresholdResult[];
}

/** The whole sweep. Deterministic: same options in, same numbers out, forever. */
export function runCurve(
  options: ExperimentOptions = DEFAULT_OPTIONS,
  onProgress?: (done: number, total: number) => void,
): CurveResult {
  const total =
    options.thresholds.length *
    (options.healthySeeds + options.scenarios.length * options.seedsPerCell);
  let done = 0;

  const thresholds = options.thresholds.map((threshold) => {
    let totalFalseAlarms = 0;
    let healthyHours = 0;
    for (let s = 0; s < options.healthySeeds; s++) {
      const trial = runHealthyTrial(threshold, options.seedBase + 9000 + s * 17, options);
      totalFalseAlarms += trial.alarms;
      healthyHours += trial.hours;
      onProgress?.(++done, total);
    }

    const allLatencies: number[] = [];
    let detectedAll = 0;
    let trialsAll = 0;

    const scenarios = options.scenarios.map((scenario) => {
      const outcomes: DetectionOutcome[] = [];
      for (let s = 0; s < options.seedsPerCell; s++) {
        outcomes.push(
          runDetectionTrial(scenario, threshold, options.seedBase + 1000 + s * 31, options),
        );
        onProgress?.(++done, total);
      }

      const detected = outcomes.filter((o) => o.detected);
      const latencies = detected.map((o) => o.latencyMs ?? 0);
      const onsetErrors = detected.map((o) => o.onsetErrorMs ?? 0);

      allLatencies.push(...latencies);
      detectedAll += detected.length;
      trialsAll += outcomes.length;

      return {
        scenario: scenario.name,
        description: scenario.description,
        trials: outcomes.length,
        detected: detected.length,
        detectionRate: detected.length / outcomes.length,
        medianLatencyMs: percentile(latencies, 50),
        p90LatencyMs: percentile(latencies, 90),
        medianOnsetErrorMs: percentile(onsetErrors, 50),
        rightAltitudeRate:
          detected.length === 0
            ? 0
            : detected.filter((o) => o.rightAltitude).length / detected.length,
      };
    });

    return {
      threshold,
      falseAlarmsPerHour: healthyHours === 0 ? 0 : totalFalseAlarms / healthyHours,
      healthyHours,
      totalFalseAlarms,
      overallDetectionRate: trialsAll === 0 ? 0 : detectedAll / trialsAll,
      overallMedianLatencyMs: percentile(allLatencies, 50),
      scenarios,
    };
  });

  return { options, thresholds };
}
