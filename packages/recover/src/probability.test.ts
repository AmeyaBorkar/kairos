import { describe, expect, it } from "vitest";
import {
  brierScore,
  calibrationCurve,
  expectedCalibrationError,
  type Prediction,
  skillScore,
} from "./calibration.js";
import { DEFAULT_RECOVERY_MODEL, type RecoveryFeatures, RecoveryModel } from "./probability.js";

const features = (o: Partial<RecoveryFeatures> = {}): RecoveryFeatures => ({
  action: "retry",
  recoverability: "transient",
  confidence: 1,
  railHealthy: true,
  attemptOrdinal: 0,
  ...o,
});

function feed(model: RecoveryModel, f: RecoveryFeatures, successes: number, failures: number) {
  for (let i = 0; i < successes; i++) model.observe(f, true);
  for (let i = 0; i < failures; i++) model.observe(f, false);
}

describe("cold start", () => {
  it("reports the stated prior before it has seen anything", () => {
    const model = new RecoveryModel();
    expect(model.probability(features())).toBeCloseTo(DEFAULT_RECOVERY_MODEL.coldStartRate, 6);
    expect(model.observations()).toBe(0);
    expect(model.evidence(features())).toBe(0);
  });
});

describe("hierarchical shrinkage", () => {
  it("lets a cell with enough evidence hold its own opinion", () => {
    const model = new RecoveryModel();
    const f = features();
    feed(model, f, 240, 60);

    // 80% observed, and by 300 observations the κ=12 prior has almost no say left.
    expect(model.probability(f)).toBeGreaterThan(0.75);
    expect(model.evidence(f)).toBeGreaterThan(0.9);
  });

  it("hands an unseen cell its parent's answer rather than a guess from nothing", () => {
    // The property that makes this usable on a real merchant's first week: a class-and-rail
    // combination nobody has observed inherits what the action as a whole has been doing.
    const model = new RecoveryModel();
    feed(model, features({ recoverability: "transient" }), 180, 20);

    const unseen = features({ recoverability: "timed", attemptOrdinal: 2 });
    const p = model.probability(unseen);

    expect(p).toBeGreaterThan(DEFAULT_RECOVERY_MODEL.coldStartRate);
    expect(model.evidence(unseen)).toBe(0);
  });

  it("separates a rail that has healed from one that has not", () => {
    // The whole `kairos` thesis reduced to two numbers. If the model could not tell these apart,
    // scheduling on the recovery edge would be scheduling on nothing.
    const model = new RecoveryModel();
    feed(model, features({ railHealthy: true }), 170, 30);
    feed(model, features({ railHealthy: false }), 10, 190);

    expect(model.probability(features({ railHealthy: true }))).toBeGreaterThan(0.6);
    expect(model.probability(features({ railHealthy: false }))).toBeLessThan(0.2);
  });

  it("distinguishes a first attempt from a fourth", () => {
    const model = new RecoveryModel();
    feed(model, features({ attemptOrdinal: 0 }), 120, 80);
    feed(model, features({ attemptOrdinal: 3 }), 8, 192);

    expect(model.probability(features({ attemptOrdinal: 0 }))).toBeGreaterThan(
      model.probability(features({ attemptOrdinal: 3 })),
    );
  });

  it("forgets, so a merchant whose customers change is not held to last quarter", () => {
    const model = new RecoveryModel({ ...DEFAULT_RECOVERY_MODEL, decayPerObservation: 0.95 });
    const f = features();
    feed(model, f, 300, 0);
    const before = model.probability(f);
    feed(model, f, 0, 200);

    expect(before).toBeGreaterThan(0.9);
    expect(model.probability(f)).toBeLessThan(0.2);
  });
});

describe("the confidence blend", () => {
  it("uses the cell's own answer when the classification is certain", () => {
    const model = new RecoveryModel();
    feed(model, features({ recoverability: "transient" }), 190, 10);
    expect(model.probability(features({ confidence: 1 }))).toBeGreaterThan(0.85);
  });

  it("falls back to the population rate when the classification is a guess", () => {
    // Decay is switched off here so the assertion is about the blend rather than about the order
    // the two classes happened to be observed in. With it on, the population rate is a *recent*
    // population rate, which is the behaviour wanted in production and noise in this test.
    const model = new RecoveryModel({ ...DEFAULT_RECOVERY_MODEL, decayPerObservation: 1 });
    feed(model, features({ recoverability: "transient" }), 190, 10);
    feed(model, features({ recoverability: "customer-action" }), 10, 190);

    const certain = model.probability(features({ confidence: 1 }));
    const guessed = model.probability(features({ confidence: 0 }));

    // The population cell has 200 recoveries in 400, still shrunk toward the cold-start prior:
    // (200 + 12 x 0.15) / (400 + 12). Asserting the closed form rather than "about a half" is what
    // makes this a test of the estimator instead of a test of a rounding.
    const { priorStrength: k, coldStartRate: c } = DEFAULT_RECOVERY_MODEL;
    expect(certain).toBeGreaterThan(0.85);
    expect(guessed).toBeCloseTo((200 + k * c) / (400 + k), 9);
  });

  it("is a correction and not a safety margin, even when that means predicting more", () => {
    // Worth asserting explicitly because it looks like a bug. Where a class recovers *worse* than
    // the population, an uncertain classification raises the estimate rather than lowering it.
    //
    // That is the honest answer: if we are not sure this is a `customer-action`, then it might be
    // one of the classes that does better, and the mixture over what it might be is the population
    // rate. Biasing downward "to be careful" would break the one property the expected-value gate
    // needs — a probability that can be multiplied by a rupee amount — and the calibration curve is
    // what proves the blend was right rather than merely cautious.
    const model = new RecoveryModel();
    feed(model, features({ recoverability: "transient" }), 190, 10);
    feed(model, features({ recoverability: "customer-action" }), 10, 190);

    const f = features({ recoverability: "customer-action" });
    expect(model.probability({ ...f, confidence: 0.2 })).toBeGreaterThan(
      model.probability({ ...f, confidence: 1 }),
    );
  });

  it("treats a nonsensical confidence as knowing nothing", () => {
    const model = new RecoveryModel();
    feed(model, features(), 190, 10);
    const nonsense = model.probability(features({ confidence: Number.NaN }));
    expect(nonsense).toBeCloseTo(model.probability(features({ confidence: 0 })), 6);
  });
});

describe("clamps", () => {
  it("never claims certainty in either direction", () => {
    const model = new RecoveryModel();
    feed(model, features(), 5000, 0);
    expect(model.probability(features())).toBeLessThanOrEqual(DEFAULT_RECOVERY_MODEL.ceiling);

    const other = new RecoveryModel();
    feed(other, features(), 0, 5000);
    expect(other.probability(features())).toBeGreaterThanOrEqual(DEFAULT_RECOVERY_MODEL.floor);
  });
});

describe("calibration", () => {
  /**
   * Predictions that are honest by construction: recovery happens at exactly the rate promised.
   *
   * Deterministic rather than sampled — of every ten predictions at 0.3, exactly three recover — so
   * the test asserts the estimator rather than the luck of a seed.
   */
  function honest(count: number): Prediction[] {
    const out: Prediction[] = [];
    for (let i = 0; i < count; i++) {
      const tenths = i % 10;
      const rank = Math.floor(i / 10) % 10;
      out.push({ predicted: tenths / 10, recovered: rank < tenths });
    }
    return out;
  }

  it("finds an honest model honest", () => {
    const curve = calibrationCurve(honest(1000));
    expect(curve).toHaveLength(10);
    expect(expectedCalibrationError(curve)).toBeLessThan(1e-9);
  });

  it("finds an inflated model inflated", () => {
    // The failure mode that matters: a model whose probabilities are all too high chases every
    // casualty it is shown and is wrong about the money every single time.
    const inflated = honest(1000).map((p) => ({
      ...p,
      predicted: Math.min(1, p.predicted + 0.25),
    }));
    expect(expectedCalibrationError(calibrationCurve(inflated))).toBeGreaterThan(0.2);
  });

  it("puts a prediction of exactly one in the last bin rather than past the end", () => {
    const curve = calibrationCurve([{ predicted: 1, recovered: true }], 10);
    expect(curve).toHaveLength(1);
    expect(curve[0]?.upper).toBe(1);
    expect(curve[0]?.count).toBe(1);
  });

  it("omits bins nobody predicted into", () => {
    // A bin with no predictions says nothing about the model, and reporting `observed: 0` for it
    // reads as a failure that did not happen.
    const curve = calibrationCurve([{ predicted: 0.55, recovered: true }], 10);
    expect(curve).toHaveLength(1);
    expect(curve[0]?.lower).toBeCloseTo(0.5, 6);
  });

  it("scores a coin flip at a quarter", () => {
    const flips: Prediction[] = [
      { predicted: 0.5, recovered: true },
      { predicted: 0.5, recovered: false },
    ];
    expect(brierScore(flips)).toBeCloseTo(0.25, 6);
  });

  it("gives no credit to a model that only ever repeats the base rate", () => {
    // Calibration alone would call this model perfect. The skill score is what stops the scorecard
    // reporting a constant as a success.
    const constant: Prediction[] = Array.from({ length: 400 }, (_, i) => ({
      predicted: 0.25,
      recovered: i % 4 === 0,
    }));
    expect(expectedCalibrationError(calibrationCurve(constant))).toBeLessThan(0.01);
    expect(skillScore(constant)).toBeCloseTo(0, 6);
  });

  it("rewards a model that separates the two populations", () => {
    const sharp: Prediction[] = [
      ...Array.from({ length: 200 }, () => ({ predicted: 0.9, recovered: true })),
      ...Array.from({ length: 200 }, () => ({ predicted: 0.1, recovered: false })),
    ];
    expect(skillScore(sharp)).toBeGreaterThan(0.9);
  });

  it("reports nothing rather than dividing by nothing", () => {
    expect(calibrationCurve([])).toEqual([]);
    expect(calibrationCurve([{ predicted: 0.5, recovered: true }], 0)).toEqual([]);
    expect(brierScore([])).toBe(0);
    expect(skillScore([])).toBe(0);
    expect(expectedCalibrationError([])).toBe(0);
    expect(skillScore([{ predicted: 0.5, recovered: true }])).toBe(0);
  });
});
