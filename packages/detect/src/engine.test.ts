/**
 * The engine, which is where the slice tree, rollup and incident lifecycle meet.
 *
 * Everything here was previously covered only by proxy, through the console's scenarios — which is
 * how a defect in exactly this seam survived: rollup suppressed a child's alarm without retiring
 * the evidence behind it, and nothing looked at that directly.
 */

import { type Attempt, attemptId, customerRef, orderId, paise, slice } from "@kairos/domain";
import { describe, expect, it } from "vitest";
import { DEFAULT_DETECTOR_CONFIG as CFG } from "./config.js";
import { peakStatistic } from "./cusum.js";
import { DetectionEngine, type EngineConfig } from "./engine.js";

const CONFIG: EngineConfig = { ...CFG, rollup: true };

/** Deterministic LCG. A detector test that uses Math.random is a test that reports weather. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

let counter = 0;
function attempt(at: number, failed: boolean, method: string, issuer: string | null): Attempt {
  counter += 1;
  return {
    id: attemptId(`pay_${counter}`),
    orderId: orderId(`order_${counter}`),
    customer: customerRef(`cus_${String(counter).padStart(12, "0")}`),
    amount: paise(50_000),
    // biome-ignore lint/suspicious/noExplicitAny: the slice builder validates the method itself.
    slice: slice(method as any, issuer, null),
    status: failed ? "failed" : "captured",
    failure: failed
      ? {
          code: "GATEWAY_ERROR",
          source: "bank",
          step: "payment_authorization",
          reason: "payment_failed",
          description: "issuer unavailable",
        }
      : null,
    at,
  };
}

/**
 * Feed traffic split across two issuers on one method, so there is a real slice tree to roll up.
 *
 * `hdfcRate` is the rail under test; `otherRate` is a healthy sibling that dilutes it at the method
 * level, which is what gives rollup something to decide.
 */
function feed(
  engine: DetectionEngine,
  count: number,
  from: number,
  hdfcRate: number,
  otherRate: number,
  next: () => number,
): {
  readonly opened: string[];
  readonly resolved: string[];
  readonly superseded: string[];
  readonly until: number;
} {
  const opened: string[] = [];
  const resolved: string[] = [];
  const superseded: string[] = [];
  let at = from;

  for (let i = 0; i < count; i++) {
    at = from + i * 1000;
    const onHdfc = i % 2 === 0;
    const rate = onHdfc ? hdfcRate : otherRate;
    for (const event of engine.observe(
      attempt(at, next() < rate, "netbanking", onHdfc ? "hdfc" : "sbi"),
    )) {
      const key = (s: { method: string; issuer: string | null }): string =>
        `${s.method}|${s.issuer ?? ""}`;
      if (event.kind === "opened") opened.push(key(event.incident.slice));
      if (event.kind === "resolved") resolved.push(key(event.slice));
      if (event.kind === "superseded") superseded.push(key(event.slice));
    }
  }

  return { opened, resolved, superseded, until: at + 1000 };
}

describe("detection engine", () => {
  it("reports an issuer-wide outage once, at the altitude that explains it", () => {
    const next = rng(5);
    const engine = new DetectionEngine(CONFIG);
    const warm = feed(engine, 4000, 0, 0.02, 0.02, next);
    const broken = feed(engine, 3000, warm.until, 0.5, 0.02, next);

    expect(warm.opened).toEqual([]);
    expect(broken.opened.length).toBeGreaterThan(0);
    // One event for one outage, not one per slice on the path.
    expect(new Set(broken.opened).size).toBe(broken.opened.length);
  });

  it("retires the evidence of the slices an incident was standing in for", () => {
    /* Rollup reports one event at the coarsest slice that explains it, and leaves every slice
       underneath holding its own account of the same outage. A descendant that raised its own
       alarm has a way out; one that never crossed `minObservations` has none, and its bank simply
       keeps whatever it accumulated.

       On the console's `issuer-outage` that produced an incident opened twelve minutes *after* the
       rail was healthy — an outage reported for the first time after it ended. The evidence was
       real and entirely spent, because the incident carrying it had already been opened, watched
       and closed one level up. */
    const next = rng(9);
    const engine = new DetectionEngine(CONFIG);
    const child = slice("netbanking", "hdfc", null);

    const warm = feed(engine, 4000, 0, 0.02, 0.02, next);
    const broken = feed(engine, 3000, warm.until, 0.5, 0.02, next);
    expect(broken.opened.length).toBeGreaterThan(0);

    // The child has banked plenty, whether or not it was ever entitled to report it.
    expect(
      peakStatistic(engine.stateOf(child)?.cusum ?? { statistics: [], excursionStartedAt: [] }),
    ).toBeGreaterThan(0);

    const healed = feed(engine, 6000, broken.until, 0.02, 0.02, next);
    expect(healed.resolved.length).toBeGreaterThan(0);

    // Nothing opens on the way out, on a rail that has been healthy the whole time.
    const after = feed(engine, 4000, healed.until, 0.02, 0.02, next);
    expect(after.opened).toEqual([]);
    expect(engine.openIncidents()).toEqual([]);
  });

  it("leaves a descendant that is making its own claim alone", () => {
    // Only quiet descendants are retired. One mid-incident is entitled to finish arguing it, and
    // has the recovery statistic to do so.
    const next = rng(13);
    const engine = new DetectionEngine({ ...CONFIG, rollup: false });
    const warm = feed(engine, 4000, 0, 0.02, 0.02, next);
    const broken = feed(engine, 4000, warm.until, 0.5, 0.02, next);

    // Without rollup both the method and the issuer report for themselves.
    expect(new Set(broken.opened).size).toBeGreaterThan(1);
    expect(engine.stateOf(slice("netbanking", "hdfc", null))?.phase).toBe("alarmed");
  });

  it("closes what it opens, and stops holding the rail once it is healthy", () => {
    const next = rng(21);
    const engine = new DetectionEngine(CONFIG);
    const warm = feed(engine, 4000, 0, 0.02, 0.02, next);
    const broken = feed(engine, 3000, warm.until, 0.5, 0.02, next);
    const healed = feed(engine, 8000, broken.until, 0.02, 0.02, next);

    /* Every incident that opened has to end, and there are exactly two ways out: it resolves, or a
       coarser slice takes it over. An incident that leaves by neither is one still being asserted
       against a rail nobody is watching any more. */
    const ended = broken.resolved.length + broken.superseded.length + healed.resolved.length;
    expect(broken.opened.length).toBeGreaterThan(0);
    expect(ended).toBe(broken.opened.length);
    expect(engine.openIncidents()).toEqual([]);
  });
});
