import { slice } from "@kairos/domain";
import { describe, expect, it } from "vitest";
import { type AppliedPlan, type ChoiceModel, chooseUnderPlan } from "./choice.js";
import { INDIA_PROFILES, type SliceProfile } from "./profiles.js";
import { Rng } from "./rng.js";

const NEUTRAL: AppliedPlan = { suppress: [], demote: [] };
const MODEL: ChoiceModel = { switchElasticity: 0.35, abandonmentOnSuppress: 0.08 };

const profile = (method: string, issuer: string, instrument: string | null): SliceProfile => {
  const found = INDIA_PROFILES.find(
    (p) =>
      p.slice.method === method && p.slice.issuer === issuer && p.slice.instrument === instrument,
  );
  if (found === undefined) throw new Error(`no profile for ${method}/${issuer}/${instrument}`);
  return found;
};

const HDFC_GPAY = profile("upi", "hdfc", "gpay");
const HDFC_NETBANKING = profile("netbanking", "hdfc", null);

/** Run many customers through one plan and report what they did. */
function run(plan: AppliedPlan, preferred: SliceProfile, model = MODEL, n = 4000) {
  const rng = new Rng(4242);
  let stayed = 0;
  let switched = 0;
  let abandoned = 0;
  for (let i = 0; i < n; i++) {
    const choice = chooseUnderPlan(rng, preferred, INDIA_PROFILES, plan, model);
    if (choice.abandoned) abandoned++;
    else if (choice.switched) switched++;
    else stayed++;
  }
  return { stayed: stayed / n, switched: switched / n, abandoned: abandoned / n };
}

describe("with no plan in force", () => {
  it("everyone pays the way they intended to", () => {
    const result = run(NEUTRAL, HDFC_GPAY);
    expect(result.stayed).toBe(1);
  });
});

describe("demotion", () => {
  const plan: AppliedPlan = { suppress: [], demote: ["upi"] };

  it("moves roughly the elastic fraction and strands nobody", () => {
    const result = run(plan, HDFC_GPAY);
    expect(result.switched).toBeCloseTo(MODEL.switchElasticity, 1);
    expect(result.abandoned).toBe(0);
  });

  it("leaves customers on other methods alone", () => {
    const result = run(plan, HDFC_NETBANKING);
    expect(result.stayed).toBe(1);
  });

  it("never sends a switcher back to the demoted method", () => {
    const rng = new Rng(7);
    for (let i = 0; i < 2000; i++) {
      const choice = chooseUnderPlan(rng, HDFC_GPAY, INDIA_PROFILES, plan, MODEL);
      if (choice.switched) expect(choice.slice?.method).not.toBe("upi");
    }
  });

  it("scales with elasticity", () => {
    const sluggish = run(plan, HDFC_GPAY, { ...MODEL, switchElasticity: 0.05 });
    const eager = run(plan, HDFC_GPAY, { ...MODEL, switchElasticity: 0.9 });
    expect(sluggish.switched).toBeLessThan(0.1);
    expect(eager.switched).toBeGreaterThan(0.85);
  });
});

describe("suppression", () => {
  const plan: AppliedPlan = { suppress: [slice("netbanking", "hdfc")], demote: [] };

  it("displaces everyone on the removed instrument", () => {
    const result = run(plan, HDFC_NETBANKING);
    expect(result.stayed).toBe(0);
  });

  it("loses the abandoning fraction entirely", () => {
    // The cost that makes suppression expensive: a customer who leaves is a total loss, where a
    // failed payment is at least retryable.
    const result = run(plan, HDFC_NETBANKING);
    expect(result.abandoned).toBeCloseTo(MODEL.abandonmentOnSuppress, 1);
  });

  it("never returns the suppressed instrument to anyone", () => {
    const rng = new Rng(11);
    for (let i = 0; i < 2000; i++) {
      const choice = chooseUnderPlan(rng, HDFC_NETBANKING, INDIA_PROFILES, plan, MODEL);
      if (choice.slice !== null) {
        expect(`${choice.slice.method}/${choice.slice.issuer}`).not.toBe("netbanking/hdfc");
      }
    }
  });

  it("leaves customers on other instruments of the same method alone", () => {
    const sbi = profile("netbanking", "sbi", null);
    expect(run(plan, sbi).stayed).toBe(1);
  });

  it("reports a lost sale rather than a silent fallback when nothing is left", () => {
    // The method floor exists so this cannot happen. If it ever does, the honest outcome is a lost
    // sale, not a quiet fallback to the rail that was removed.
    const everything: AppliedPlan = {
      suppress: INDIA_PROFILES.map((p) => p.slice),
      demote: [],
    };
    const result = run(everything, HDFC_NETBANKING);
    expect(result.abandoned).toBe(1);
  });
});

describe("determinism", () => {
  it("is fully determined by its seed", () => {
    const plan: AppliedPlan = { suppress: [slice("netbanking", "hdfc")], demote: ["upi"] };
    const once = run(plan, HDFC_GPAY);
    const twice = run(plan, HDFC_GPAY);
    expect(once).toEqual(twice);
  });
});
