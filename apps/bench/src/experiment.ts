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
  /** Independent runs per (threshold, scenario) cell, and per threshold for the healthy arm. */
  readonly seedsPerCell: number;
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
    (options.seedsPerCell + options.scenarios.length * options.seedsPerCell);
  let done = 0;

  const thresholds = options.thresholds.map((threshold) => {
    let totalFalseAlarms = 0;
    let healthyHours = 0;
    for (let s = 0; s < options.seedsPerCell; s++) {
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
