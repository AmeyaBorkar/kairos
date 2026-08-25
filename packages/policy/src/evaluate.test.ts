import { slice } from "@kairos/domain";
import { describe, expect, it } from "vitest";
import { DEFAULT_STEERING_CONFIG, type SteeringConfig } from "./config.js";
import { evaluateSteer } from "./evaluate.js";
import { RailHealth } from "./health.js";
import { healthWith, incidentOn } from "./testing.js";

const config = DEFAULT_STEERING_CONFIG;
const with_ = (overrides: Partial<SteeringConfig>): SteeringConfig => ({ ...config, ...overrides });

describe("suppression — slices Checkout can name", () => {
  const failing = slice("netbanking", "hdfc");

  it("chooses suppression for a precisely addressable slice", () => {
    const evaluation = evaluateSteer(incidentOn(failing, 0.45), healthWith(failing, 0.45), config);
    expect(evaluation.lever).toBe("suppress");
    expect(evaluation.addressability).toBe("precise");
  });

  it("takes the steer when the rail is clearly broken", () => {
    const evaluation = evaluateSteer(incidentOn(failing, 0.45), healthWith(failing, 0.45), config);
    expect(evaluation.worthDoing).toBe(true);
    expect(evaluation.netFailureDelta).toBeLessThan(0);
  });

  it("moves nobody who was not on the failing rail", () => {
    // Suppression is precise by definition: only the instrument's own traffic is displaced.
    const evaluation = evaluateSteer(incidentOn(failing, 0.45), healthWith(failing, 0.45), config);
    expect(evaluation.collateralShare).toBe(0);
    expect(evaluation.rescuedShare).toBe(evaluation.movedShare);
  });

  it("declines when the rail is only mildly worse than the alternatives", () => {
    const evaluation = evaluateSteer(incidentOn(failing, 0.13), healthWith(failing, 0.13), config);
    expect(evaluation.worthDoing).toBe(false);
  });

  it("charges abandonment against the steer, and refuses more often as it rises", () => {
    // Taking away the button someone came to press does not reliably move them to another button.
    // A customer who leaves is a total loss where a failed payment is at least retryable, so
    // abandonment enters as a failure with probability one — and it raises the bar for suppressing.
    const health = healthWith(failing, 0.3);
    const incident = incidentOn(failing, 0.3);

    const forgiving = evaluateSteer(incident, health, with_({ abandonmentOnSuppress: 0 }));
    const punishing = evaluateSteer(incident, health, with_({ abandonmentOnSuppress: 0.5 }));

    expect(forgiving.netFailureDelta).toBeLessThan(punishing.netFailureDelta);
    expect(forgiving.worthDoing).toBe(true);
    expect(punishing.worthDoing).toBe(false);
  });
});

describe("demotion — slices Checkout cannot name", () => {
  const failing = slice("upi", "hdfc");

  it("falls back to demotion for a UPI issuer", () => {
    const evaluation = evaluateSteer(incidentOn(failing, 0.5), healthWith(failing, 0.5), config);
    expect(evaluation.lever).toBe("demote");
    expect(evaluation.addressability).toBe("none");
  });

  it("moves far more healthy traffic than failing traffic", () => {
    // The cost of the only lever available for most of the volume. Demoting UPI because HDFC's UPI
    // handle is sick nudges every other bank's UPI users too, and they were perfectly fine.
    const evaluation = evaluateSteer(incidentOn(failing, 0.5), healthWith(failing, 0.5), config);
    expect(evaluation.collateralShare).toBeGreaterThan(evaluation.rescuedShare);
  });

  it("refuses a moderate UPI issuer outage, because the destination is worse", () => {
    // UPI fails around 2% and cards around 12%. At 12% on the failing rail there is nothing to win:
    // the people rescued land somewhere no better, and the collateral traffic lands somewhere worse.
    const evaluation = evaluateSteer(incidentOn(failing, 0.12), healthWith(failing, 0.12), config);
    expect(evaluation.worthDoing).toBe(false);
    expect(evaluation.netFailureDelta).toBeGreaterThan(0);
    expect(evaluation.declineReason).toMatch(/no better/);
  });

  it("takes a severe UPI issuer outage, where the arithmetic finally turns", () => {
    const evaluation = evaluateSteer(incidentOn(failing, 0.55), healthWith(failing, 0.55), config);
    expect(evaluation.worthDoing).toBe(true);
    expect(evaluation.netFailureDelta).toBeLessThan(0);
  });

  /**
   * The break-even point is a real number, not a judgement call, and it falls out of the traffic
   * mix rather than being chosen. Recording it here means a change to the mix that moves it shows
   * up as a failing test rather than as a quietly different product.
   */
  it("puts the break-even for demoting UPI somewhere in the high twenties per cent", () => {
    const worthAt = (rate: number): boolean =>
      evaluateSteer(incidentOn(failing, rate), healthWith(failing, rate), config).worthDoing;

    expect(worthAt(0.25)).toBe(false);
    expect(worthAt(0.32)).toBe(true);
  });

  it("turns much sooner when customers are more willing to switch", () => {
    // Elasticity scales both halves of the trade, so it cannot change the sign on its own — but it
    // scales the benefit against a fixed minimum, so a more responsive audience clears the bar
    // earlier.
    const health = healthWith(failing, 0.3);
    const incident = incidentOn(failing, 0.3);
    const sluggish = evaluateSteer(incident, health, with_({ switchElasticity: 0.05 }));
    const eager = evaluateSteer(incident, health, with_({ switchElasticity: 0.9 }));
    expect(Math.abs(eager.netFailureDelta)).toBeGreaterThan(Math.abs(sluggish.netFailureDelta));
  });
});

describe("bounds", () => {
  it("refuses to steer a resolved incident", () => {
    const failing = slice("netbanking", "hdfc");
    const incident = incidentOn(failing, 0.45, { state: "resolved", resolvedAt: Date.now() });
    const evaluation = evaluateSteer(incident, healthWith(failing, 0.45), config);
    expect(evaluation.worthDoing).toBe(false);
    expect(evaluation.declineReason).toMatch(/already resolved/);
  });

  it("refuses when the peak never exceeded the baseline", () => {
    const failing = slice("netbanking", "hdfc");
    const incident = incidentOn(failing, 0.45, { baselineFailureRate: 0.5 });
    const evaluation = evaluateSteer(incident, healthWith(failing, 0.45), config);
    expect(evaluation.declineReason).toMatch(/never exceeded/);
  });

  it("refuses to suppress the last instrument when it would breach the method floor", () => {
    // The bound worth defending hardest: a checkout with nothing on it is worse than the outage
    // that prompted it.
    const failing = slice("wallet", "paytm");
    const health = new RailHealth([
      { slice: slice("wallet", "paytm"), share: 50, failureRate: 0.6 },
      { slice: slice("card", "hdfc", "visa"), share: 50, failureRate: 0.05 },
    ]);
    const evaluation = evaluateSteer(incidentOn(failing, 0.6), health, config);
    expect(evaluation.worthDoing).toBe(false);
    expect(evaluation.declineReason).toMatch(/floor/);
  });

  it("allows the same suppression when another method survives", () => {
    const failing = slice("wallet", "paytm");
    const health = new RailHealth([
      { slice: slice("wallet", "paytm"), share: 40, failureRate: 0.6 },
      { slice: slice("card", "hdfc", "visa"), share: 30, failureRate: 0.05 },
      { slice: slice("upi", "hdfc", "gpay"), share: 30, failureRate: 0.02 },
    ]);
    const evaluation = evaluateSteer(incidentOn(failing, 0.6), health, config);
    expect(evaluation.worthDoing).toBe(true);
  });

  it("declines a slice it has never seen any volume on", () => {
    const failing = slice("netbanking", "yesbank");
    const evaluation = evaluateSteer(incidentOn(failing, 0.9), healthWith(failing, 0.9), config);
    expect(evaluation.worthDoing).toBe(false);
    expect(evaluation.declineReason).toMatch(/no observed volume/);
  });

  it("declines an improvement too small to be worth moving customers for", () => {
    const failing = slice("netbanking", "icici");
    const health = healthWith(failing, 0.115);
    const evaluation = evaluateSteer(incidentOn(failing, 0.115), health, config);
    expect(evaluation.worthDoing).toBe(false);
  });
});
