import { slice } from "@kairos/domain";
import { describe, expect, it } from "vitest";
import { drawFailure } from "./failures.js";
import {
  type Degradation,
  degradationEndsAt,
  failureRateAt,
  generate,
  isDegraded,
  type SimulatorConfig,
} from "./generate.js";
import { blendedFailureRate, INDIA_PROFILES, type SliceProfile } from "./profiles.js";
import { Rng } from "./rng.js";

const HOUR = 3_600_000;
const T0 = 1_756_000_000_000;

const PROFILES: readonly SliceProfile[] = [
  { slice: slice("upi", "hdfc", "phonepe"), share: 60, baseFailureRate: 0.02 },
  { slice: slice("upi", "hdfc", "gpay"), share: 25, baseFailureRate: 0.02 },
  { slice: slice("card", "hdfc", "visa"), share: 15, baseFailureRate: 0.12 },
];

const config = (over: Partial<SimulatorConfig> = {}): SimulatorConfig => ({
  seed: 1,
  startAt: T0,
  durationMs: HOUR,
  attemptsPerMinute: 600,
  profiles: PROFILES,
  degradations: [],
  ...over,
});

describe("Rng", () => {
  it("is fully determined by its seed", () => {
    const a = new Rng(1234);
    const b = new Rng(1234);
    const left = Array.from({ length: 500 }, () => a.next());
    const right = Array.from({ length: 500 }, () => b.next());
    expect(left).toEqual(right);
  });

  it("diverges on a different seed", () => {
    const draw = (seed: number): number[] => {
      const r = new Rng(seed);
      return Array.from({ length: 50 }, () => r.next());
    };
    expect(draw(1)).not.toEqual(draw(2));
  });

  it("stays inside the unit interval", () => {
    const r = new Rng(7);
    for (let i = 0; i < 20_000; i++) {
      const value = r.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("is roughly uniform across the interval", () => {
    const r = new Rng(99);
    const buckets = new Array<number>(10).fill(0);
    const n = 100_000;
    for (let i = 0; i < n; i++) {
      const b = Math.floor(r.next() * 10);
      buckets[b] = (buckets[b] ?? 0) + 1;
    }
    for (const count of buckets) {
      expect(count).toBeGreaterThan(n / 10 - n / 100);
      expect(count).toBeLessThan(n / 10 + n / 100);
    }
  });

  it("produces the requested Bernoulli rate", () => {
    const r = new Rng(5);
    let hits = 0;
    for (let i = 0; i < 100_000; i++) if (r.bool(0.3)) hits++;
    expect(hits / 100_000).toBeCloseTo(0.3, 2);
  });

  it("honours relative weights when picking", () => {
    const r = new Rng(11);
    const items = [
      { name: "a", w: 90 },
      { name: "b", w: 10 },
    ];
    let a = 0;
    for (let i = 0; i < 50_000; i++) if (r.pick(items, (x) => x.w).name === "a") a++;
    expect(a / 50_000).toBeCloseTo(0.9, 2);
  });

  it("draws exponential gaps with the requested mean", () => {
    const r = new Rng(3);
    let total = 0;
    const n = 100_000;
    for (let i = 0; i < n; i++) total += r.exponential(250);
    expect(total / n).toBeCloseTo(250, -1);
  });

  it("emits hex of exactly the requested length", () => {
    const r = new Rng(2);
    expect(r.hex(24)).toMatch(/^[0-9a-f]{24}$/);
    expect(r.hex(5)).toHaveLength(5);
  });
});

describe("profiles", () => {
  it("blends to a rate a real Indian merchant would recognise", () => {
    const blended = blendedFailureRate(INDIA_PROFILES);
    expect(blended).toBeGreaterThan(0.03);
    expect(blended).toBeLessThan(0.08);
  });

  it("keeps UPI healthier than cards, as published behaviour has it", () => {
    const upi = INDIA_PROFILES.filter((p) => p.slice.method === "upi");
    const card = INDIA_PROFILES.filter((p) => p.slice.method === "card");
    expect(blendedFailureRate(upi)).toBeLessThan(blendedFailureRate(card));
  });
});

describe("failureRateAt", () => {
  const target = PROFILES[0];
  if (target === undefined) throw new Error("fixture");

  const degradation: Degradation = {
    slice: slice("upi", "hdfc"),
    onsetAt: T0 + 10 * 60_000,
    rampMs: 2 * 60_000,
    peakFailureRate: 0.4,
    holdMs: 20 * 60_000,
    recoveryMs: 5 * 60_000,
  };
  const cfg = config({ degradations: [degradation] });

  it("sits at baseline before onset", () => {
    expect(failureRateAt(cfg, target, degradation.onsetAt - 1000)).toBeCloseTo(0.02, 10);
    expect(isDegraded(cfg, target, degradation.onsetAt - 1000)).toBe(false);
  });

  it("ramps monotonically to the plateau", () => {
    const quarter = failureRateAt(cfg, target, degradation.onsetAt + 30_000);
    const half = failureRateAt(cfg, target, degradation.onsetAt + 60_000);
    const peak = failureRateAt(cfg, target, degradation.onsetAt + 5 * 60_000);

    expect(quarter).toBeGreaterThan(0.02);
    expect(half).toBeGreaterThan(quarter);
    expect(peak).toBeCloseTo(0.4, 10);
  });

  it("returns to baseline after recovery completes", () => {
    expect(failureRateAt(cfg, target, degradationEndsAt(degradation) + 1000)).toBeCloseTo(0.02, 10);
    expect(isDegraded(cfg, target, degradationEndsAt(degradation) + 1000)).toBe(false);
  });

  it("applies an issuer-level degradation to every app beneath it", () => {
    const sibling = PROFILES[1];
    if (sibling === undefined) throw new Error("fixture");
    const mid = degradation.onsetAt + 10 * 60_000;
    expect(failureRateAt(cfg, sibling, mid)).toBeCloseTo(0.4, 10);
  });

  it("leaves slices outside the degradation alone", () => {
    const card = PROFILES[2];
    if (card === undefined) throw new Error("fixture");
    const mid = degradation.onsetAt + 10 * 60_000;
    expect(failureRateAt(cfg, card, mid)).toBeCloseTo(0.12, 10);
  });

  it("takes the worst overlapping degradation rather than summing past one", () => {
    const both = config({
      degradations: [
        degradation,
        { ...degradation, peakFailureRate: 0.8 },
        { ...degradation, peakFailureRate: 0.7 },
      ],
    });
    expect(failureRateAt(both, target, degradation.onsetAt + 10 * 60_000)).toBeCloseTo(0.8, 10);
  });
});

describe("generate", () => {
  it("is fully determined by the seed", () => {
    const left = [...generate(config({ durationMs: 5 * 60_000 }))];
    const right = [...generate(config({ durationMs: 5 * 60_000 }))];
    expect(left).toEqual(right);
    expect(left.length).toBeGreaterThan(0);
  });

  it("changes with the seed", () => {
    const left = [...generate(config({ durationMs: 5 * 60_000, seed: 1 }))];
    const right = [...generate(config({ durationMs: 5 * 60_000, seed: 2 }))];
    expect(left).not.toEqual(right);
  });

  it("produces roughly the requested volume", () => {
    const attempts = [...generate(config())];
    // 600/min for an hour.
    expect(attempts.length).toBeGreaterThan(34_000);
    expect(attempts.length).toBeLessThan(38_000);
  });

  it("emits attempts in time order, inside the window", () => {
    const attempts = [...generate(config({ durationMs: 10 * 60_000 }))];
    let previous = 0;
    for (const a of attempts) {
      expect(a.at).toBeGreaterThanOrEqual(previous);
      expect(a.at).toBeGreaterThanOrEqual(T0);
      expect(a.at).toBeLessThan(T0 + 10 * 60_000);
      previous = a.at;
    }
  });

  it("reproduces each slice's baseline failure rate", () => {
    const attempts = [...generate(config({ durationMs: 4 * HOUR }))];
    for (const profile of PROFILES) {
      const mine = attempts.filter((a) => a.slice === profile.slice);
      const failed = mine.filter((a) => a.status === "failed").length;
      expect(failed / mine.length).toBeCloseTo(profile.baseFailureRate, 2);
    }
  });

  it("raises the observed rate during a degradation", () => {
    const onsetAt = T0 + 10 * 60_000;
    const cfg = config({
      durationMs: HOUR,
      degradations: [
        {
          slice: slice("upi", "hdfc"),
          onsetAt,
          rampMs: 0,
          peakFailureRate: 0.45,
          holdMs: 20 * 60_000,
          recoveryMs: 0,
        },
      ],
    });
    const attempts = [...generate(cfg)].filter((a) => a.slice.method === "upi");
    const during = attempts.filter((a) => a.at >= onsetAt && a.at < onsetAt + 20 * 60_000);
    const before = attempts.filter((a) => a.at < onsetAt);

    const rate = (list: typeof attempts): number =>
      list.filter((a) => a.status === "failed").length / list.length;

    expect(rate(before)).toBeLessThan(0.05);
    expect(rate(during)).toBeGreaterThan(0.4);
  });

  it("attributes excess failures during an incident to the bank or gateway", () => {
    // The classifier downstream depends on this: a rail breaking produces bank-sourced timeouts,
    // not a sudden epidemic of expired cards.
    const onsetAt = T0 + 5 * 60_000;
    const cfg = config({
      durationMs: 40 * 60_000,
      degradations: [
        {
          slice: slice("upi", "hdfc"),
          onsetAt,
          rampMs: 0,
          peakFailureRate: 0.6,
          holdMs: 30 * 60_000,
          recoveryMs: 0,
        },
      ],
    });
    const failures = [...generate(cfg)]
      .filter((a) => a.slice.method === "upi" && a.status === "failed" && a.at >= onsetAt)
      .map((a) => a.failure?.source ?? "");

    const infra = failures.filter((s) => s === "bank" || s === "gateway").length;
    expect(infra / failures.length).toBeGreaterThan(0.85);
  });

  it("keeps a healthy rail's failures dominated by the customer", () => {
    const failures = [...generate(config({ durationMs: 3 * HOUR }))]
      .filter((a) => a.status === "failed")
      .map((a) => a.failure?.source ?? "");
    const customer = failures.filter((s) => s === "customer").length;
    expect(customer / failures.length).toBeGreaterThan(0.6);
  });

  it("attaches failure detail to failures and nothing else", () => {
    for (const a of generate(config({ durationMs: 2 * 60_000 }))) {
      if (a.status === "failed") expect(a.failure).not.toBeNull();
      else expect(a.failure).toBeNull();
    }
  });
});

describe("drawFailure", () => {
  it("draws only infrastructure causes for degradation failures", () => {
    const rng = new Rng(1);
    for (let i = 0; i < 300; i++) {
      const detail = drawFailure(rng, "card", true);
      expect(["bank", "gateway"]).toContain(detail.source);
    }
  });

  it("draws a mix that includes customer causes on a healthy rail", () => {
    const rng = new Rng(1);
    const sources = new Set<string>();
    for (let i = 0; i < 300; i++) sources.add(drawFailure(rng, "card", false).source);
    expect(sources.has("customer")).toBe(true);
  });
});
