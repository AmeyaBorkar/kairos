import { slice } from "@kairos/domain";
import { describe, expect, it } from "vitest";
import { DEFAULT_WINDOW_CONFIG, RailWindow } from "./window.js";

const UPI = slice("upi", "hdfc", "gpay");
const CARD = slice("card", "hdfc", "visa");
const NOW = Date.UTC(2026, 7, 25, 12, 0, 0);

describe("RailWindow", () => {
  it("reports the rate it has been fed", () => {
    const window = new RailWindow();
    for (let i = 0; i < 100; i++) window.observe(UPI, i % 10 === 0, NOW);
    expect(window.snapshot(NOW).rateOf(UPI)).toBeCloseTo(0.1, 1);
  });

  it("weights recent observations more heavily than old ones", () => {
    // The point of the whole class: a rail that was healthy ten minutes ago and is failing now must
    // read as failing, or steering would always be one outage behind.
    const window = new RailWindow();
    for (let t = 0; t < 600; t++) window.observe(UPI, false, NOW + t * 1000);
    for (let t = 600; t < 840; t++) window.observe(UPI, true, NOW + t * 1000);

    expect(window.snapshot(NOW + 840_000).rateOf(UPI)).toBeGreaterThan(0.7);
  });

  it("tracks the current rate rather than a frozen baseline", () => {
    // Steering needs the number a customer is exposed to, including the outage. The detector's
    // baseline is deliberately frozen during an incident and would never look bad enough to act on.
    const window = new RailWindow();
    for (let t = 0; t < 900; t++) window.observe(UPI, t % 50 === 0, NOW + t * 1000);
    const before = window.snapshot(NOW + 900_000).rateOf(UPI);

    for (let t = 900; t < 1300; t++) window.observe(UPI, true, NOW + t * 1000);
    const during = window.snapshot(NOW + 1_300_000).rateOf(UPI);

    expect(before).toBeLessThan(0.05);
    expect(during).toBeGreaterThan(0.8);
  });

  /**
   * The lag, stated as a number rather than left as a property nobody measured.
   *
   * This is the cost of the estimator and it lands directly on time-to-steer: after an outage
   * begins the window is still carrying the weight of everything that went well beforehand, and it
   * takes roughly two half-lives to shed enough of that to reflect what customers are experiencing.
   */
  it("follows the closed form of its own step response", () => {
    // The lag, as an equation rather than a property nobody measured. Feeding a rail at a steady
    // rate and then flipping every outcome to a failure, the reported rate should track
    // `1 - 2^(-t/halfLife)` — so one half-life gets halfway there and two get three quarters.
    //
    // This is the cost of the estimator and it lands directly on time-to-steer: after an outage
    // begins the window is still carrying the weight of everything that went well beforehand.
    const window = new RailWindow();
    const halfLife = DEFAULT_WINDOW_CONFIG.halfLifeMs;

    for (let t = 0; t < 1200; t++) window.observe(UPI, false, NOW + t * 1000);
    const onset = NOW + 1_200_000;

    const seen = new Map<number, number>();
    for (let t = 1; t <= 480; t++) {
      const at = onset + t * 1000;
      window.observe(UPI, true, at);
      if (t * 1000 === halfLife || t * 1000 === 2 * halfLife) {
        seen.set(t * 1000, window.snapshot(at).rateOf(UPI));
      }
    }

    for (const [elapsed, rate] of seen) {
      expect(rate).toBeCloseTo(1 - 2 ** (-elapsed / halfLife), 1);
    }
    expect(seen.size).toBe(2);
  });

  it("keeps relative volume between rails", () => {
    const window = new RailWindow();
    for (let i = 0; i < 300; i++) window.observe(UPI, false, NOW);
    for (let i = 0; i < 100; i++) window.observe(CARD, false, NOW);

    const health = window.snapshot(NOW);
    expect(health.shareOf(UPI) / health.shareOf(CARD)).toBeCloseTo(3, 0);
  });

  it("ages out a rail that stops receiving traffic", () => {
    // Otherwise every slice ever seen stays in the snapshot forever, and the destination rate
    // slowly fills with rails nobody uses.
    const window = new RailWindow();
    for (let i = 0; i < 50; i++) window.observe(CARD, false, NOW);
    expect(window.snapshot(NOW).observations).toHaveLength(1);

    const later = NOW + DEFAULT_WINDOW_CONFIG.halfLifeMs * 20;
    expect(window.snapshot(later).observations).toHaveLength(0);
    expect(window.size).toBe(0);
  });

  it("does not let a read change what the next read says", () => {
    const window = new RailWindow();
    for (let i = 0; i < 100; i++) window.observe(UPI, i % 4 === 0, NOW);
    const first = window.snapshot(NOW).rateOf(UPI);
    expect(window.snapshot(NOW).rateOf(UPI)).toBe(first);
  });

  it("keeps rates inside the unit interval", () => {
    const window = new RailWindow();
    for (let i = 0; i < 1000; i++) window.observe(UPI, true, NOW + i * 137);
    const rate = window.snapshot(NOW + 200_000).rateOf(UPI);
    expect(rate).toBeGreaterThanOrEqual(0);
    expect(rate).toBeLessThanOrEqual(1);
  });
});
