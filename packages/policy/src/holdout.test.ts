import { customerRef, incidentId } from "@kairos/domain";
import { describe, expect, it } from "vitest";
import { holdoutDraw, isHeldOut } from "./holdout.js";

const INCIDENT = incidentId("inc_hdfc_upi_0001");
const OTHER = incidentId("inc_sbi_card_0002");

const customer = (i: number) => customerRef(`cus_${i.toString().padStart(12, "0")}`);

describe("holdoutDraw", () => {
  it("is stable for the same customer and incident", () => {
    const c = customer(1);
    expect(holdoutDraw(c, INCIDENT)).toBe(holdoutDraw(c, INCIDENT));
  });

  it("stays inside the unit interval", () => {
    for (let i = 0; i < 500; i++) {
      const draw = holdoutDraw(customer(i), INCIDENT);
      expect(draw).toBeGreaterThanOrEqual(0);
      expect(draw).toBeLessThan(1);
    }
  });

  it("spreads customers evenly across the interval", () => {
    // A hash that clumps would silently produce a biased control group, and a biased control group
    // produces a lift number that is wrong in a direction nobody can predict. Ten buckets over
    // twenty thousand customers should each hold within a few per cent of a tenth.
    const buckets = new Array<number>(10).fill(0);
    const n = 20_000;
    for (let i = 0; i < n; i++) {
      const bucket = Math.floor(holdoutDraw(customer(i), INCIDENT) * 10);
      buckets[bucket] = (buckets[bucket] ?? 0) + 1;
    }

    for (const count of buckets) {
      expect(count / n).toBeGreaterThan(0.09);
      expect(count / n).toBeLessThan(0.11);
    }
  });

  it("gives one customer independent draws across incidents", () => {
    // Otherwise the control group is a fixed cohort, and any peculiarity of those particular people
    // — a bank, a device, a habit — becomes a permanent confound in every incident measured.
    //
    // Independence has a closed form worth testing against rather than eyeballing: for two draws
    // that really are independent and uniform, P(|U - V| > t) = (1 - t)^2. Asserting the observed
    // fraction matches that curve catches a hash whose two inputs are correlated, which merely
    // asserting "the draws differ a lot" would not.
    const n = 4000;
    for (const t of [0.1, 0.2, 0.5]) {
      let differing = 0;
      for (let i = 0; i < n; i++) {
        const c = customer(i);
        if (Math.abs(holdoutDraw(c, INCIDENT) - holdoutDraw(c, OTHER)) > t) differing++;
      }
      expect(differing / n).toBeCloseTo((1 - t) ** 2, 1);
    }
  });

  it("does not put the same people in the control group every time", () => {
    const fraction = 0.1;
    const first = new Set<string>();
    const second = new Set<string>();
    for (let i = 0; i < 5000; i++) {
      const c = customer(i);
      if (isHeldOut(c, INCIDENT, fraction)) first.add(c);
      if (isHeldOut(c, OTHER, fraction)) second.add(c);
    }

    const overlap = [...first].filter((c) => second.has(c)).length;
    // Independent assignment puts roughly `fraction` of one arm into the other, not all of it.
    expect(overlap / first.size).toBeLessThan(0.2);
    expect(first.size).toBeGreaterThan(400);
  });
});

describe("isHeldOut", () => {
  it("holds back approximately the configured fraction", () => {
    const n = 20_000;
    let held = 0;
    for (let i = 0; i < n; i++) if (isHeldOut(customer(i), INCIDENT, 0.1)) held++;
    expect(held / n).toBeGreaterThan(0.095);
    expect(held / n).toBeLessThan(0.105);
  });

  it("holds nobody at zero and everybody at one", () => {
    for (let i = 0; i < 200; i++) {
      expect(isHeldOut(customer(i), INCIDENT, 0)).toBe(false);
      expect(isHeldOut(customer(i), INCIDENT, 1)).toBe(true);
    }
  });

  it("is monotone in the fraction", () => {
    // Someone held out at 10% must still be held out at 20%, or raising the holdout would swap
    // people between arms mid-incident and break the stickiness the whole design rests on.
    for (let i = 0; i < 500; i++) {
      const c = customer(i);
      if (isHeldOut(c, INCIDENT, 0.1)) expect(isHeldOut(c, INCIDENT, 0.2)).toBe(true);
    }
  });

  it("keeps a customer in the same arm for the life of one incident", () => {
    const c = customer(42);
    const first = isHeldOut(c, INCIDENT, 0.1);
    for (let i = 0; i < 50; i++) expect(isHeldOut(c, INCIDENT, 0.1)).toBe(first);
  });
});
