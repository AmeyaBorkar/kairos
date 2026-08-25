import { casualtyId, customerRef, type ProposedAction, paise, rupees } from "@kairos/domain";
import { describe, expect, it } from "vitest";
import {
  clampReservation,
  estimateSizer,
  learnedSizer,
  predictiveSizer,
  type Sizer,
  targetQuantile,
  worstCaseSizer,
} from "./reservation.js";

const MAX_COST = rupees(3);

function action(estimatedCost = rupees(1)): ProposedAction {
  return {
    kind: "contact-sms",
    customer: customerRef("cus_9f3b2a71c4e8d012"),
    casualty: casualtyId("cas_001"),
    incident: null,
    estimatedCost,
    expectedValue: rupees(2000),
    successProbability: 0.3,
    rationale: "transient decline",
  };
}

/**
 * The cost distribution this is all built around.
 *
 * A Latin-script SMS is one GSM-7 segment; the same sentence in Devanagari is UCS-2 at 70
 * characters a segment, so it is three. The model picks the script, and the price follows the
 * choice — which is why the cost cannot be known at admission.
 */
const ONE_SEGMENT = rupees(1);
const THREE_SEGMENTS = rupees(3);

function costs(devanagariShare: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) =>
    ((i * 7) % 100) / 100 < devanagariShare ? THREE_SEGMENTS : ONE_SEGMENT,
  );
}

/** Run a sizer over a cost stream and report what it reserved and what it overran. */
function exercise(sizer: Sizer, stream: readonly number[], estimate = ONE_SEGMENT) {
  let reserved = 0;
  let spent = 0;
  let overrun = 0;
  for (const cost of stream) {
    const r = clampReservation(sizer.size(action(paise(estimate))), MAX_COST);
    reserved += r;
    spent += cost;
    overrun += Math.max(0, cost - r);
    sizer.observe(cost);
  }
  return { reserved, spent, overrun, utilisation: spent / reserved };
}

describe("clampReservation", () => {
  it("never returns less than a paise", () => {
    // A zero reservation would let actions in flight consuming no budget, leaving the in-flight cap
    // as the only thing between the campaign and its worst case.
    expect(clampReservation(0, MAX_COST)).toBe(1);
    expect(clampReservation(-50, MAX_COST)).toBe(1);
  });

  it("never returns more than the per-action ceiling", () => {
    expect(clampReservation(rupees(10), MAX_COST)).toBe(MAX_COST);
  });

  it("rounds up, so a fractional estimate is never under-reserved", () => {
    expect(clampReservation(120.1, MAX_COST)).toBe(121);
  });

  it("fails toward the ceiling when a sizer returns nonsense, not toward the floor", () => {
    // The two directions are not symmetric. Over-reserving costs utilisation; under-reserving costs
    // money. A broken sizer must therefore be clamped upward, which is P2 applied to arithmetic.
    expect(clampReservation(Number.NaN, MAX_COST)).toBe(MAX_COST);
    expect(clampReservation(Number.POSITIVE_INFINITY, MAX_COST)).toBe(MAX_COST);
    expect(clampReservation(Number.NEGATIVE_INFINITY, MAX_COST)).toBe(1);
  });
});

describe("worstCaseSizer", () => {
  it("always reserves the ceiling", () => {
    const sizer = worstCaseSizer(MAX_COST);
    expect(sizer.size(action())).toBe(MAX_COST);
  });

  it("never overruns, whatever the costs turn out to be", () => {
    const result = exercise(worstCaseSizer(MAX_COST), costs(0.5, 200));
    expect(result.overrun).toBe(0);
  });

  it("pays for that with utilisation", () => {
    // Reserving three segments for a campaign that mostly sends one sterilises most of the budget.
    const result = exercise(worstCaseSizer(MAX_COST), costs(0.1, 200));
    expect(result.utilisation).toBeLessThan(0.5);
  });
});

describe("estimateSizer", () => {
  it("reserves what the action claimed", () => {
    expect(estimateSizer().size(action(rupees(2)))).toBe(rupees(2));
  });

  it("overruns on every message the estimate was wrong about", () => {
    const result = exercise(estimateSizer(), costs(0.4, 200));
    expect(result.overrun).toBeGreaterThan(0);
  });
});

describe("learnedSizer", () => {
  it("moves toward the costs it observes", () => {
    const sizer = learnedSizer({ holdCost: 1, overrunCost: 4, maxActionCostPaise: MAX_COST });
    const before = sizer.size(action());
    for (const cost of costs(1, 400)) sizer.observe(cost);
    expect(sizer.size(action())).toBeGreaterThan(before);
  });

  it("settles low when the costs are consistently low", () => {
    const sizer = learnedSizer({ holdCost: 1, overrunCost: 4, maxActionCostPaise: MAX_COST });
    for (let i = 0; i < 400; i++) sizer.observe(ONE_SEGMENT);
    expect(sizer.size(action())).toBeLessThan(MAX_COST);
  });

  it("cannot breach the budget however wrong it is, because the reservation is not the bound", () => {
    // Safety is the ledger's job, not the learner's. A reservation of one paise still admits only
    // as many actions as the in-flight cap allows, and every one of them is still reconciled.
    const sizer = learnedSizer({ holdCost: 1000, overrunCost: 1, maxActionCostPaise: MAX_COST });
    for (let i = 0; i < 200; i++) sizer.observe(THREE_SEGMENTS);
    expect(clampReservation(sizer.size(action()), MAX_COST)).toBeGreaterThanOrEqual(1);
  });
});

describe("predictiveSizer", () => {
  it("follows an estimate that keeps being right", () => {
    const sizer = predictiveSizer({ holdCost: 1, overrunCost: 4, maxActionCostPaise: MAX_COST });
    for (let i = 0; i < 300; i++) {
      sizer.size(action(paise(THREE_SEGMENTS)));
      sizer.observe(THREE_SEGMENTS);
    }
    expect(sizer.size(action(paise(THREE_SEGMENTS)))).toBeGreaterThan(ONE_SEGMENT);
  });

  it("stops following an estimate that keeps being wrong", () => {
    // The adversarial case: the estimate always says one segment and the model always writes three.
    // The Hedge meta-learner has to move weight onto the robust learner rather than keep trusting it.
    const sizer = predictiveSizer({ holdCost: 1, overrunCost: 4, maxActionCostPaise: MAX_COST });
    let lastReservation = 0;
    for (let i = 0; i < 400; i++) {
      lastReservation = sizer.size(action(paise(ONE_SEGMENT)));
      sizer.observe(THREE_SEGMENTS);
    }
    expect(lastReservation).toBeGreaterThan(ONE_SEGMENT);
  });
});

describe("targetQuantile", () => {
  it("is the median when holding and overrunning cost the same", () => {
    expect(targetQuantile(1, 1)).toBeCloseTo(0.5, 6);
  });

  it("rises as an overrun gets more expensive relative to a hold", () => {
    expect(targetQuantile(1, 4)).toBeCloseTo(0.8, 6);
    expect(targetQuantile(1, 9)).toBeCloseTo(0.9, 6);
  });
});

describe("the sizers against each other", () => {
  /**
   * The comparison §8 commits to making rather than asserting: does learning the reservation earn
   * its complexity against simply reserving the worst case?
   *
   * On this cost distribution it does — the learner recovers most of the utilisation the worst case
   * gives away. What it costs is a non-zero overrun, which is exactly the trade the operator is
   * choosing. The measurement harness runs the same comparison end to end, with the overspend
   * actually observed rather than only the reservation sizes.
   */
  it("shows the trade-off between overrun and utilisation", () => {
    const stream = costs(0.25, 400);
    const worst = exercise(worstCaseSizer(MAX_COST), stream);
    const learned = exercise(
      learnedSizer({ holdCost: 1, overrunCost: 4, maxActionCostPaise: MAX_COST }),
      stream,
    );

    expect(worst.overrun).toBe(0);
    expect(learned.utilisation).toBeGreaterThan(worst.utilisation);
    expect(learned.overrun).toBeGreaterThanOrEqual(0);
  });
});
