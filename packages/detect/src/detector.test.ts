import { describe, expect, it } from "vitest";
import { baselineConfidence, baselineRate, EMPTY_BASELINE, observeBaseline } from "./baseline.js";
import { DEFAULT_DETECTOR_CONFIG as CFG, withThreshold } from "./config.js";
import {
  alternativeRate,
  changepoint,
  emptyCusum,
  logLikelihoodRatio,
  peakStatistic,
  updateCusum,
  updateRecovery,
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

describe("recovery statistic", () => {
  const P0 = 0.02;
  const P1 = 0.2;

  it("scores successes as evidence the rise is over and failures against it", () => {
    expect(updateRecovery(0, false, P0, P1, CFG.cusum)).toBeGreaterThan(0);
    // A failure from a floor of zero cannot go negative, so start it somewhere it can fall from.
    expect(updateRecovery(5, true, P0, P1, CFG.cusum)).toBeLessThan(5);
  });

  it("is the detection ratio with its two rates exchanged, exactly", () => {
    // Not "similar to". The same function, the same numbers, the other way round — which is why
    // there is no second piece of arithmetic here to get wrong.
    expect(updateRecovery(0, false, P0, P1, CFG.cusum)).toBeCloseTo(
      logLikelihoodRatio(false, P1, P0),
      12,
    );
  });

  it("pins at its floor while the rail is still at the rate it alarmed on", () => {
    const next = rng(19);
    let r = 0;
    let peak = 0;
    for (let i = 0; i < 50_000; i++) {
      r = updateRecovery(r, next() < P1, P0, P1, CFG.cusum);
      peak = Math.max(peak, r);
    }
    expect(peak).toBeLessThan(CFG.cusum.recoveryThreshold);
  });

  it("climbs to its ceiling once the rail is back at its baseline", () => {
    const next = rng(19);
    let r = 0;
    let crossedAt = -1;
    for (let i = 0; i < 5000; i++) {
      r = updateRecovery(r, next() < P0, P0, P1, CFG.cusum);
      if (crossedAt < 0 && r >= CFG.cusum.recoveryThreshold) crossedAt = i;
    }
    expect(crossedAt).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThanOrEqual(CFG.cusum.recoveryThreshold * 2);
  });

  it("changes sides between the two rates rather than at either of them", () => {
    /* The standard CUSUM crossover. Below `p*` the drift is positive and the incident can close;
       above it the statistic pins. It sits strictly between the baseline and the alternative,
       which is what makes "the evidence has turned against the claim" a different and more useful
       statement than "the rail is perfect again". */
    const star =
      Math.log((1 - P0) / (1 - P1)) / (Math.log((1 - P0) / (1 - P1)) + Math.log(P1 / P0));
    expect(star).toBeGreaterThan(P0);
    expect(star).toBeLessThan(P1);

    const drift = (rate: number): number =>
      rate * Math.log(P0 / P1) + (1 - rate) * Math.log((1 - P0) / (1 - P1));
    expect(drift(star)).toBeCloseTo(0, 10);
    expect(drift(star - 0.01)).toBeGreaterThan(0);
    expect(drift(star + 0.01)).toBeLessThan(0);
  });

  it("says nothing at all when the two hypotheses are the same rate", () => {
    expect(updateRecovery(9, false, 0.2, 0.2, CFG.cusum)).toBe(0);
    expect(updateRecovery(9, false, 0.3, 0.2, CFG.cusum)).toBe(0);
  });
});

describe("the claim an alarm freezes", () => {
  it("takes the smallest shift that crossed, not whichever statistic is highest", () => {
    /* A burst pushes the most aggressive statistic up fastest, so the argmax at the instant of an
       alarm can name a shift the sustained traffic never supported — and the incident is then
       closed against a claim nobody made. Measured on `card-network`: the incident opened saying
       the rail had gone from 12% to 52% when it was running at 19%, the recovery test demolished
       that in under four minutes, and cover lapsed on a rail that was genuinely degraded. */
    const shifts = CFG.cusum.shifts;
    const above = CFG.cusum.threshold + 1;
    const state = {
      // Both the mild and the severe hypotheses have crossed; the severe one leads.
      statistics: shifts.map((shift) => (shift === 0.08 ? above : shift === 0.4 ? above + 8 : 0)),
      excursionStartedAt: shifts.map(() => 0),
    };
    expect(alternativeRate(state, 0.1, CFG.cusum)).toBeCloseTo(0.18, 10);
  });

  it("falls back to the leader when nothing has crossed", () => {
    const shifts = CFG.cusum.shifts;
    const state = {
      statistics: shifts.map((shift) => (shift === 0.18 ? 3 : 1)),
      excursionStartedAt: shifts.map(() => 0),
    };
    expect(alternativeRate(state, 0.1, CFG.cusum)).toBeCloseTo(0.28, 10);
  });

  it("never proposes a rate the log-ratio cannot take", () => {
    const shifts = CFG.cusum.shifts;
    const state = {
      statistics: shifts.map((shift) => (shift === 0.4 ? 20 : 0)),
      excursionStartedAt: shifts.map(() => 0),
    };
    expect(alternativeRate(state, 0.9, CFG.cusum)).toBeLessThanOrEqual(
      CFG.cusum.maxAlternativeRate,
    );
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
    expect(healed.state.frozenAlternative).toBeNull();
    expect(healed.state.recovery).toBe(0);
  });

  it("resolves in minutes rather than hours, which is open question 19", () => {
    /* The assertion this file used to make was that a healed rail resolves *eventually*, over
       twenty thousand observations. It does, and the detector still took six hours over it: a
       one-sided CUSUM decays at `KL(p₀ ‖ p₀+δ)`, which for the most sensitive shift in the bank is
       a few thousandths of a nat per observation, and the bank reports its maximum. So the alarm
       was governed by the fastest riser and the clear by the slowest faller, and adding a shift to
       catch milder degradations made every incident close later.

       Four seeds because one would be an anecdote. The bound is loose on purpose — the measured
       spread is 141 to 276 observations and the point is the order of magnitude, not the digit. */
    for (const seed of [13, 29, 41, 57]) {
      const next = rng(seed);
      const warm = feed(emptyDetector(CFG), 5000, 0.02, 0, next);
      const broken = feed(warm.state, 4000, 0.35, 5_000_000, next);
      expect(broken.state.phase).toBe("alarmed");

      const healed = feed(broken.state, 20_000, 0.02, 9_000_000, next);
      const resolved = healed.transitions.find((t) => t.transition === "resolved");
      expect(resolved, `seed ${seed} never resolved`).toBeDefined();
      // One observation a second, so this is ten minutes. The old detector needed roughly 1,700.
      expect(((resolved?.at ?? 0) - 9_000_000) / 1000, `seed ${seed}`).toBeLessThan(600);
    }
  });

  it("will not let go of a rail that is still broken, at any length", () => {
    /* The failure a fast clear could introduce, and the reason the recovery statistic is a
       likelihood ratio rather than a timer. Under the alternative its drift is `−KL(p₁ ‖ p₀) < 0`,
       so it pins at its floor: there is no threshold and no amount of patience that gets a
       genuinely degraded rail past it. Sixteen hours of failure, one observation a second. */
    for (const seed of [13, 29, 41]) {
      const next = rng(seed);
      const warm = feed(emptyDetector(CFG), 5000, 0.02, 0, next);
      const broken = feed(warm.state, 60_000, 0.35, 5_000_000, next);
      expect(broken.transitions.filter((t) => t.transition === "resolved")).toEqual([]);
      expect(broken.state.phase).toBe("alarmed");
    }
  });

  it("restarts the bank when an incident closes, so it does not re-alarm on the way out", () => {
    /* Page's own procedure — alarm, then begin again — and the step this detector was missing.
       An incident closed on recovery evidence leaves a statistic that may still be past
       `threshold`, and without the restart the next observation reopens on evidence about an
       outage just declared over. */
    const next = rng(31);
    const warm = feed(emptyDetector(CFG), 5000, 0.02, 0, next);
    const broken = feed(warm.state, 4000, 0.35, 5_000_000, next);
    const healed = feed(broken.state, 2000, 0.02, 9_000_000, next);

    expect(healed.transitions.some((t) => t.transition === "resolved")).toBe(true);
    // Whatever it holds afterwards was earned on healthy traffic, not carried over the transition.
    expect(peakStatistic(healed.state.cusum)).toBeLessThan(CFG.cusum.threshold);
    expect(healed.transitions.filter((t) => t.transition === "opened")).toEqual([]);
  });

  it("does not flap at the boundary", () => {
    /* The hazard the `clearing` phase exists for, at the period it was written against: "a
       degradation that oscillates would otherwise open and close an incident every few seconds."
       A minute hot, a minute cool, for the best part of an hour — well inside the two-minute dwell,
       so the whole stretch has to read as one incident.

       This used to oscillate on a seven-minute period and demand the same answer, which the old
       detector gave for the wrong reason: it could not close an incident at all, so of course it
       never opened a second one. See the test below for what a seven-minute period should do. */
    const next = rng(17);
    let state = feed(emptyDetector(CFG), 5000, 0.02, 0, next).state;
    state = feed(state, 600, 0.35, 5_000_000, next).state;
    let at = 5_600_000;
    let opens = 0;

    for (let cycle = 0; cycle < 24; cycle++) {
      const hot = feed(state, 60, 0.3, at, next);
      state = hot.state;
      at += 60_000;
      opens += hot.transitions.filter((t) => t.transition === "opened").length;

      const cool = feed(state, 60, 0.05, at, next);
      state = cool.state;
      at += 60_000;
      opens += cool.transitions.filter((t) => t.transition === "opened").length;
    }

    // One incident that persists, not one per cycle.
    expect(opens).toBe(0);
    expect(state.phase).not.toBe("quiet");
  });

  it("reports a rail that really breaks and really heals as one incident per episode", () => {
    /* The other side of the same coin, and the behaviour the old detector could not produce.
       Seven minutes at thirty per cent, seven minutes at five, twelve times over: that is not a
       detector chattering at a boundary, it is a rail that is genuinely broken and genuinely fine
       in turn, and a merchant is entitled to be told each time. Twelve episodes, and the detector
       finds six of them — the ones where the hot stretch accumulated enough evidence to alarm.

       Under the old detector this produced exactly one incident, which stayed open for the entire
       hundred and sixty minutes including every stretch where the rail was fine. */
    const next = rng(17);
    let state = feed(emptyDetector(CFG), 5000, 0.02, 0, next).state;
    let at = 5_000_000;
    let opens = 0;
    let resolves = 0;

    for (let cycle = 0; cycle < 12; cycle++) {
      const hot = feed(state, 400, 0.3, at, next);
      state = hot.state;
      at += 400_000;
      opens += hot.transitions.filter((t) => t.transition === "opened").length;
      resolves += hot.transitions.filter((t) => t.transition === "resolved").length;

      const cool = feed(state, 400, 0.05, at, next);
      state = cool.state;
      at += 400_000;
      opens += cool.transitions.filter((t) => t.transition === "opened").length;
      resolves += cool.transitions.filter((t) => t.transition === "resolved").length;
    }

    expect(opens).toBeGreaterThan(2);
    // Every one of them closed. An incident left open is the defect this replaced.
    expect(resolves).toBe(opens);
    expect(state.phase).toBe("quiet");
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
