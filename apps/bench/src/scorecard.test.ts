import { describe, expect, it } from "vitest";
import type { Comparison } from "./prevent.js";
import { combine } from "./scorecard.js";

function comparison(
  treated: [attempts: number, lost: number],
  control: [attempts: number, lost: number],
  savedPaise = 0,
): Comparison {
  const arm = ([attempts, lost]: [number, number]) => ({
    attempts,
    lost,
    lossRate: attempts === 0 ? 0 : lost / attempts,
    abandoned: 0,
    lostPaise: 0,
    volumePaise: 0,
  });
  return {
    treated: arm(treated),
    control: arm(control),
    lossRateDelta: 0,
    confidenceHalfWidth: 0,
    significant: false,
    savedPaise,
  };
}

describe("combine", () => {
  it("weights by attempts rather than averaging incidents", () => {
    // An incident that saw forty attempts and one that saw four thousand are not two equal
    // opinions about the same effect. Averaging the two deltas would give 0.25; pooling gives the
    // rate the traffic actually experienced.
    const small = comparison([10, 5], [10, 0]); // treated 50%, control 0% → delta −0.5
    const large = comparison([1000, 0], [1000, 1000]); // treated 0%, control 100% → delta +1.0
    const pooled = combine([small, large]);

    // Pooled: treated 5/1010, control 1000/1010.
    expect(pooled.lossRateDelta).toBeCloseTo(1000 / 1010 - 5 / 1010, 10);
    expect(pooled.lossRateDelta).not.toBeCloseTo(0.25, 2);
  });

  it("adds the money saved across incidents", () => {
    expect(
      combine([comparison([1, 0], [1, 0], 500), comparison([1, 0], [1, 0], 250)]).savedPaise,
    ).toBe(750);
  });

  it("reports no effect where there was no traffic, rather than dividing by zero", () => {
    expect(combine([comparison([0, 0], [0, 0])])).toEqual({ lossRateDelta: 0, savedPaise: 0 });
    expect(combine([])).toEqual({ lossRateDelta: 0, savedPaise: 0 });
  });

  it("reports a negative delta where the treated arm did worse", () => {
    // Steering can cost the people it moves. That has to survive pooling rather than be clamped.
    expect(combine([comparison([100, 30], [100, 10])]).lossRateDelta).toBeCloseTo(-0.2, 10);
  });
});
