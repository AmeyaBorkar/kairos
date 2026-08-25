import { describe, expect, it } from "vitest";
import { baselineConfidence, baselineRate, EMPTY_BASELINE, observeBaseline } from "./baseline.js";
import { DEFAULT_DETECTOR_CONFIG as CFG, withThreshold } from "./config.js";
import {
  changepoint,
  emptyCusum,
  logLikelihoodRatio,
  peakStatistic,
  updateCusum,
} from "./cusum.js";
import { type DetectorState, emptyDetector, observe, type Transition } from "./detector.js";

/** Deterministic LCG. Tests must be exactly reproducible; Math.random is never acceptable here. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Feed `count` Bernoulli(rate) observations, one per second. Returns state and any transitions. */
function feed(
  state: DetectorState,
  count: number,
  rate: number,
  startAt: number,
  next: () => number,
  parentRate = 0.02,
  config = CFG,
): {
  state: DetectorState;
  transitions: { transition: Transition; at: number; onsetAt: number | null }[];
} {
  const transitions: { transition: Transition; at: number; onsetAt: number | null }[] = [];
  let current = state;
  for (let i = 0; i < count; i++) {
    const at = startAt + i * 1000;
    const result = observe(current, { isFailure: next() < rate, at, parentRate }, config);
    current = result.state;
    if (result.verdict.transition !== "none") {
      transitions.push({
        transition: result.verdict.transition,
        at,
        onsetAt: result.verdict.onsetAt,
      });
    }
  }
  return { state: current, transitions };
}

describe("baseline", () => {
  it("starts at exactly the parent's rate, with no special-casing", () => {
    expect(baselineRate(EMPTY_BASELINE, 0.09, CFG.baseline)).toBeCloseTo(0.09, 10);
  });

  it("converges to the slice's own rate once it has the volume to justify one", () => {
    const next = rng(11);
    let state = EMPTY_BASELINE;
    for (let i = 0; i < 20_000; i++) {
      state = observeBaseline(state, next() < 0.25, CFG.baseline);
    }
    // Parent says 2%; the slice has seen plenty of evidence that it is a 25% slice.
    expect(baselineRate(state, 0.02, CFG.baseline)).toBeGreaterThan(0.2);
  });

  it("holds a low-volume slice near its parent, so one failure is not an outage", () => {
    let state = EMPTY_BASELINE;
    for (let i = 0; i < 5; i++) state = observeBaseline(state, i === 0, CFG.baseline);
    // A naive rate would read 1/5 = 20%. Shrinkage keeps it close to the parent's 2%.
    expect(state.fails / state.total).toBeGreaterThan(0.19);
    expect(baselineRate(state, 0.02, CFG.baseline)).toBeLessThan(0.03);
  });

  it("clamps away from zero, where the log-ratio would treat one failure as infinite evidence", () => {
    const next = rng(3);
    let state = EMPTY_BASELINE;
    for (let i = 0; i < 5000; i++) state = observeBaseline(state, next() < 0, CFG.baseline);
    expect(baselineRate(state, 0, CFG.baseline)).toBe(CFG.baseline.floor);
  });

  it("reports how much of the estimate is the slice's own evidence", () => {
    expect(baselineConfidence(EMPTY_BASELINE, CFG.baseline)).toBe(0);
    let state = EMPTY_BASELINE;
    for (let i = 0; i < 120; i++) state = observeBaseline(state, false, CFG.baseline);
    expect(baselineConfidence(state, CFG.baseline)).toBeGreaterThan(0.45);
    expect(baselineConfidence(state, CFG.baseline)).toBeLessThan(0.55);
  });
});

describe("cusum", () => {
  it("scores failures as evidence for the change and successes against it", () => {
    expect(logLikelihoodRatio(true, 0.02, 0.2)).toBeGreaterThan(0);
    expect(logLikelihoodRatio(false, 0.02, 0.2)).toBeLessThan(0);
  });

  it("floors at zero, so evidence from before the change is discarded rather than held", () => {
    let state = emptyCusum(CFG.cusum);
    for (let i = 0; i < 500; i++) state = updateCusum(state, false, 0.02, i * 1000, CFG.cusum);
    expect(peakStatistic(state)).toBe(0);
  });

  it("respects the ceiling, so a long outage can still clear promptly", () => {
    let state = emptyCusum(CFG.cusum);
    for (let i = 0; i < 20_000; i++) state = updateCusum(state, true, 0.02, i * 1000, CFG.cusum);
    expect(peakStatistic(state)).toBeLessThanOrEqual(CFG.cusum.statisticCeiling);
  });

  it("tracks the changepoint to where the current excursion began", () => {
    let state = emptyCusum(CFG.cusum);
    for (let i = 0; i < 300; i++) state = updateCusum(state, false, 0.02, i * 1000, CFG.cusum);
    const breakAt = 300_000;
    for (let i = 0; i < 40; i++)
      state = updateCusum(state, true, 0.02, breakAt + i * 1000, CFG.cusum);
    // Within a few observations of the true break, not back at the start of the stream.
    expect(changepoint(state)).toBeGreaterThanOrEqual(breakAt - 2000);
    expect(changepoint(state)).toBeLessThanOrEqual(breakAt + 5000);
  });

  it("detects a severe collapse sooner than a mild degradation", () => {
    const runToAlarm = (rate: number): number => {
      const next = rng(7);
      let state = emptyCusum(CFG.cusum);
      for (let i = 0; i < 100_000; i++) {
        state = updateCusum(state, next() < rate, 0.02, i * 1000, CFG.cusum);
        if (peakStatistic(state) >= CFG.cusum.threshold) return i;
      }
      return Number.POSITIVE_INFINITY;
    };
    expect(runToAlarm(0.6)).toBeLessThan(runToAlarm(0.1));
  });
});

describe("detector", () => {
  it("stays quiet through a long healthy stream", () => {
    const next = rng(42);
    const { state, transitions } = feed(emptyDetector(CFG), 40_000, 0.02, 0, next);
    expect(transitions).toEqual([]);
    expect(state.phase).toBe("quiet");
  });

  it("keeps false alarms rare across independent healthy streams", () => {
    // The benchmark measures the real false-alarm rate. This only guards against a regression that
    // makes the detector fire constantly on nothing.
    let alarms = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const { transitions } = feed(emptyDetector(CFG), 20_000, 0.02, 0, rng(seed * 977));
      alarms += transitions.filter((t) => t.transition === "opened").length;
    }
    expect(alarms).toBeLessThanOrEqual(1);
  });

  it("opens on a genuine degradation", () => {
    const next = rng(5);
    const warm = feed(emptyDetector(CFG), 5000, 0.02, 0, next);
    const broken = feed(warm.state, 3000, 0.35, 5_000_000, next);

    const opened = broken.transitions.find((t) => t.transition === "opened");
    expect(opened).toBeDefined();
    expect(broken.state.phase).toBe("alarmed");
  });

  it("estimates onset earlier than the alarm, so latency is not measured against itself", () => {
    const next = rng(5);
    const warm = feed(emptyDetector(CFG), 5000, 0.02, 0, next);
    const breakAt = 5_000_000;
    const broken = feed(warm.state, 3000, 0.35, breakAt, next);

    const opened = broken.transitions.find((t) => t.transition === "opened");
    expect(opened?.onsetAt).toBeDefined();
    const onset = opened?.onsetAt ?? 0;
    expect(onset).toBeLessThan(opened?.at ?? 0);
    // And it lands near the true break rather than somewhere in the healthy prefix.
    expect(onset).toBeGreaterThanOrEqual(breakAt - 5_000);
  });

  it("does not let a long outage teach it that the outage is normal", () => {
    // The failure this guards: with a live baseline, sustained 35% failure becomes the new normal,
    // the statistic falls back to zero, and the detector declares the outage over while it rages.
    const next = rng(9);
    const warm = feed(emptyDetector(CFG), 5000, 0.02, 0, next);
    const broken = feed(warm.state, 60_000, 0.35, 5_000_000, next);

    expect(broken.transitions.some((t) => t.transition === "opened")).toBe(true);
    expect(broken.transitions.some((t) => t.transition === "resolved")).toBe(false);
    expect(broken.state.phase).toBe("alarmed");
    expect(broken.state.frozenBaseline).not.toBeNull();
    expect(broken.state.frozenBaseline ?? 1).toBeLessThan(0.05);
  });

  it("resolves once the rail recovers and stays recovered", () => {
    const next = rng(13);
    const warm = feed(emptyDetector(CFG), 5000, 0.02, 0, next);
    const broken = feed(warm.state, 4000, 0.35, 5_000_000, next);
    expect(broken.state.phase).toBe("alarmed");

    const healed = feed(broken.state, 20_000, 0.02, 9_000_000, next);
    expect(healed.transitions.some((t) => t.transition === "resolved")).toBe(true);
    expect(healed.state.phase).toBe("quiet");
    expect(healed.state.frozenBaseline).toBeNull();
  });

  it("does not flap at the boundary", () => {
    const next = rng(17);
    const warm = feed(emptyDetector(CFG), 5000, 0.02, 0, next);
    let state = warm.state;
    let at = 5_000_000;
    let opens = 0;

    // Oscillate around the trip point for a long stretch.
    for (let cycle = 0; cycle < 12; cycle++) {
      const hot = feed(state, 400, 0.3, at, next);
      state = hot.state;
      at += 400_000;
      opens += hot.transitions.filter((t) => t.transition === "opened").length;

      const cool = feed(state, 400, 0.05, at, next);
      state = cool.state;
      at += 400_000;
      opens += cool.transitions.filter((t) => t.transition === "opened").length;
    }

    // One incident that persists, not one per cycle.
    expect(opens).toBeLessThanOrEqual(2);
  });

  it("holds a cold slice quiet until it has watched enough traffic", () => {
    const next = rng(23);
    const { transitions } = feed(emptyDetector(CFG), CFG.minObservations - 1, 0.9, 0, next);
    expect(transitions.filter((t) => t.transition === "opened")).toEqual([]);
  });

  it("trades detection latency for false alarms as the threshold rises", () => {
    const latencyAt = (threshold: number): number => {
      const config = withThreshold(CFG, threshold);
      const next = rng(31);
      const warm = feed(emptyDetector(config), 5000, 0.02, 0, next, 0.02, config);
      const broken = feed(warm.state, 20_000, 0.25, 5_000_000, next, 0.02, config);
      const opened = broken.transitions.find((t) => t.transition === "opened");
      return opened === undefined ? Number.POSITIVE_INFINITY : opened.at - 5_000_000;
    };
    expect(latencyAt(8)).toBeLessThanOrEqual(latencyAt(20));
  });
});
