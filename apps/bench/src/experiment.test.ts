import { describe, expect, it } from "vitest";
import {
  type CurveResult,
  DEFAULT_OPTIONS,
  type ExperimentOptions,
  percentile,
  runDetectionTrial,
  runHealthyTrial,
  SCENARIOS,
} from "./experiment.js";
import { recommend } from "./format.js";

const MINUTE = 60_000;

/** Short enough to keep the suite fast, long enough for the detector to have an opinion. */
const FAST: ExperimentOptions = {
  ...DEFAULT_OPTIONS,
  thresholds: [12],
  seedsPerCell: 1,
  warmupMs: 12 * MINUTE,
  observeMs: 20 * MINUTE,
};

const scenario = (name: string) => {
  const found = SCENARIOS.find((s) => s.name === name);
  if (found === undefined) throw new Error(`no scenario ${name}`);
  return found;
};

describe("percentile", () => {
  it("returns null for an empty sample rather than inventing a zero", () => {
    expect(percentile([], 50)).toBeNull();
  });

  it("picks the expected order statistics", () => {
    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 90)).toBe(90);
    expect(percentile(values, 100)).toBe(100);
  });

  it("does not care about input order", () => {
    expect(percentile([5, 1, 4, 2, 3], 50)).toBe(3);
  });
});

describe("runDetectionTrial", () => {
  it("catches an issuer collapse quickly", () => {
    const outcome = runDetectionTrial(scenario("issuer-collapse"), 12, 1000, FAST);
    expect(outcome.detected).toBe(true);
    expect(outcome.latencyMs).not.toBeNull();
    expect(outcome.latencyMs ?? Infinity).toBeLessThan(60_000);
  });

  it("attributes the collapse to the slice that actually broke", () => {
    const outcome = runDetectionTrial(scenario("issuer-collapse"), 12, 1000, FAST);
    expect(outcome.rightAltitude).toBe(true);
  });

  it("measures latency from the true onset, so the number cannot flatter itself", () => {
    const outcome = runDetectionTrial(scenario("issuer-collapse"), 12, 1000, FAST);
    // Onset error is the detector's own estimate against ground truth, reported separately.
    expect(outcome.onsetErrorMs).not.toBeNull();
    expect(Math.abs(outcome.onsetErrorMs ?? 0)).toBeLessThan(120_000);
  });

  it("misses a slice too thin to carry evidence, and says so plainly", () => {
    // Roughly four attempts a minute. This is a real limitation, recorded rather than hidden.
    const outcome = runDetectionTrial(scenario("thin-slice"), 12, 1000, FAST);
    expect(outcome.detected).toBe(false);
    expect(outcome.latencyMs).toBeNull();
  });

  it("is fully determined by its seed", () => {
    const a = runDetectionTrial(scenario("single-app"), 12, 4242, FAST);
    const b = runDetectionTrial(scenario("single-app"), 12, 4242, FAST);
    expect(a).toEqual(b);
  });

  it("detects a severe collapse faster than a slow bleed", () => {
    const fast = runDetectionTrial(scenario("issuer-collapse"), 12, 1000, FAST);
    const slow = runDetectionTrial(scenario("slow-bleed"), 12, 1000, FAST);
    expect(fast.latencyMs ?? 0).toBeLessThan(slow.latencyMs ?? Number.POSITIVE_INFINITY);
  });
});

describe("runHealthyTrial", () => {
  it("stays silent on healthy traffic at the operating threshold", () => {
    const { alarms, hours } = runHealthyTrial(12, 9000, FAST);
    expect(alarms).toBe(0);
    expect(hours).toBeCloseTo(32 / 60, 5);
  });

  it("alarms more often as the threshold falls", () => {
    const low = runHealthyTrial(5, 9000, FAST).alarms;
    const high = runHealthyTrial(20, 9000, FAST).alarms;
    expect(low).toBeGreaterThanOrEqual(high);
  });
});

describe("recommend", () => {
  const curve = (
    rows: readonly { t: number; fa: number; rate: number; median: number }[],
  ): CurveResult => ({
    options: FAST,
    thresholds: rows.map((r) => ({
      threshold: r.t,
      falseAlarmsPerHour: r.fa,
      healthyHours: 1,
      totalFalseAlarms: Math.round(r.fa),
      overallDetectionRate: r.rate,
      overallMedianLatencyMs: r.median,
      scenarios: [],
    })),
  });

  it("refuses to spend more than the false-alarm budget for speed", () => {
    const chosen = recommend(
      curve([
        { t: 6, fa: 12, rate: 1, median: 40_000 },
        { t: 12, fa: 0.2, rate: 1, median: 90_000 },
      ]),
      0.25,
    );
    expect(chosen?.threshold).toBe(12);
  });

  it("takes the fastest option among those inside the budget", () => {
    const chosen = recommend(
      curve([
        { t: 12, fa: 0.2, rate: 1, median: 90_000 },
        { t: 17, fa: 0.0, rate: 1, median: 130_000 },
      ]),
      0.25,
    );
    expect(chosen?.threshold).toBe(12);
  });

  it("prefers materially better coverage over raw speed", () => {
    const chosen = recommend(
      curve([
        { t: 12, fa: 0.1, rate: 0.6, median: 60_000 },
        { t: 17, fa: 0.1, rate: 0.95, median: 120_000 },
      ]),
      0.25,
    );
    expect(chosen?.threshold).toBe(17);
  });

  it("returns null rather than a bad recommendation when nothing fits the budget", () => {
    expect(recommend(curve([{ t: 6, fa: 12, rate: 1, median: 40_000 }]), 0.25)).toBeNull();
  });
});
