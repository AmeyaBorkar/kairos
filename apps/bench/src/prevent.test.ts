import { slice } from "@kairos/domain";
import { DEFAULT_STEERING_CONFIG } from "@kairos/policy";
import type { Degradation } from "@kairos/simulator";
import { describe, expect, it } from "vitest";
import { DEFAULT_PREVENT_OPTIONS, type PreventOptions, runPrevention } from "./prevent.js";

const MINUTE = 60_000;
const START = 1_756_000_000_000;

/** Short enough to keep the suite quick, long enough for a steer to take hold and be measured. */
const FAST: PreventOptions = {
  ...DEFAULT_PREVENT_OPTIONS,
  warmupMs: 12 * MINUTE,
  observeMs: 25 * MINUTE,
};

function degradation(target: ReturnType<typeof slice>, peak: number): Degradation {
  return {
    slice: target,
    onsetAt: START + FAST.warmupMs,
    rampMs: 30_000,
    peakFailureRate: peak,
    holdMs: 20 * MINUTE,
    recoveryMs: MINUTE,
  };
}

const SEVERE_UPI = degradation(slice("upi", "hdfc"), 0.55);
const MODERATE_UPI = degradation(slice("upi", "hdfc"), 0.14);
const BROKEN_CARD = degradation(slice("card", "hdfc", "visa"), 0.4);

describe("a severe outage on a rail Checkout cannot name", () => {
  it("helps the customers who were exposed to it", async () => {
    const result = await runPrevention("severe", SEVERE_UPI, FAST);
    const incident = result.incidents[0];

    expect(incident).toBeDefined();
    expect(incident?.affected.lossRateDelta ?? 0).toBeGreaterThan(0);
    expect(incident?.affected.significant).toBe(true);
  });

  it("charges the bystanders it moved, and says so", async () => {
    // The honest half of the only lever available for most Indian volume. Demoting UPI because one
    // issuer is failing nudges every other bank's UPI users onto cards, which fail far more often.
    // The net is still positive; the cost is real and is not netted away.
    const result = await runPrevention("severe", SEVERE_UPI, FAST);
    const incident = result.incidents[0];

    expect(incident?.collateral.lossRateDelta ?? 0).toBeLessThan(0);
    expect(incident?.overall.lossRateDelta ?? 0).toBeGreaterThan(0);
  });
});

describe("a moderate outage on the same rail", () => {
  it("is refused, because the destination is no better than the origin", async () => {
    // UPI fails around 2% and cards around 12%. At 14% there is nothing to win by moving anyone,
    // and the correct product behaviour is to do nothing at all.
    const result = await runPrevention("moderate", MODERATE_UPI, FAST);
    expect(result.incidents).toHaveLength(0);
    expect(result.steersIssued).toBe(0);
    expect(Object.keys(result.declines).join(" ")).toMatch(/no worse|no better/);
  });
});

describe("a precisely suppressible rail", () => {
  it("is suppressed rather than demoted", async () => {
    const result = await runPrevention("card", BROKEN_CARD, FAST);
    expect(result.incidents[0]?.lever).toBe("suppress");
  });

  it("leaves the rest of the method alone", async () => {
    // Suppression names one instrument, so customers on other cards should be untouched — their
    // arms differ only by chance, which is what an interval spanning zero means.
    const result = await runPrevention("card", BROKEN_CARD, FAST);
    const collateral = result.incidents[0]?.collateral;
    expect(collateral?.significant).toBe(false);
  });
});

describe("the holdout", () => {
  it("keeps the detector's signal alive through the steer", async () => {
    // Steering moves traffic off the failing rail, so the evidence that justified it starts to
    // disappear. The control arm goes on using that rail, which is what keeps the incident open.
    const result = await runPrevention("severe", SEVERE_UPI, FAST);
    expect(result.detectionHeld).toBe(true);
  });

  it("gives both arms enough volume to compare on a high-volume rail", async () => {
    const result = await runPrevention("severe", SEVERE_UPI, FAST);
    const affected = result.incidents[0]?.affected;
    expect(affected?.control.attempts ?? 0).toBeGreaterThan(30);
    expect(affected?.treated.attempts ?? 0).toBeGreaterThan(300);
  });

  it("holds back roughly the configured share of exposed customers", async () => {
    const result = await runPrevention("severe", SEVERE_UPI, FAST);
    const affected = result.incidents[0]?.affected;
    const total = (affected?.control.attempts ?? 0) + (affected?.treated.attempts ?? 0);
    const share = (affected?.control.attempts ?? 0) / total;
    expect(share).toBeGreaterThan(0.06);
    expect(share).toBeLessThan(0.15);
  });
});

describe("bounds and bookkeeping", () => {
  it("writes a verifiable ledger for every decision", async () => {
    const result = await runPrevention("severe", SEVERE_UPI, FAST);
    expect(result.ledgerVerified).toBe(true);
  });

  it("never exceeds the configured blast radius", async () => {
    const result = await runPrevention("severe", SEVERE_UPI, {
      ...FAST,
      steering: { ...DEFAULT_STEERING_CONFIG, maxConcurrentSteers: 1 },
    });
    expect(result.incidents.length).toBeLessThanOrEqual(1);
  });

  it("is fully determined by its seed", async () => {
    const a = await runPrevention("severe", SEVERE_UPI, FAST);
    const b = await runPrevention("severe", SEVERE_UPI, FAST);
    expect(a.incidents).toEqual(b.incidents);
  });
});

describe("when the policy's belief about customers is wrong", () => {
  it("still helps the exposed when customers barely move", async () => {
    const result = await runPrevention("sluggish", SEVERE_UPI, {
      ...FAST,
      choice: { ...FAST.choice, switchElasticity: 0.05 },
    });
    expect(result.incidents[0]?.affected.lossRateDelta ?? -1).toBeGreaterThan(0);
  });

  it("does more collateral harm than it expected when customers move more", async () => {
    // The sensitivity that matters: the policy's assumed elasticity is a safety parameter, and
    // under-estimating it means under-estimating the harm being done to bystanders.
    const believed = await runPrevention("believed", SEVERE_UPI, FAST);
    const eager = await runPrevention("eager", SEVERE_UPI, {
      ...FAST,
      choice: { ...FAST.choice, switchElasticity: 0.9 },
    });

    const a = believed.incidents[0]?.collateral.lossRateDelta ?? 0;
    const b = eager.incidents[0]?.collateral.lossRateDelta ?? 0;
    expect(b).toBeLessThan(a);
  });
});
