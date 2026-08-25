import { describe, expect, it } from "vitest";
import { compare } from "./compare.js";
import { checkInvariant, invariant } from "./invariant.js";
import {
  classify,
  fails,
  formatDelta,
  formatValue,
  type GatedMetric,
  type Observation,
  type Outcome,
  toleranceShare,
} from "./metric.js";
import {
  canonicalise,
  codeRevision,
  configHash,
  type JsonValue,
  type Runner,
} from "./provenance.js";
import { renderVerdict } from "./report.js";
import {
  type Baseline,
  bless,
  parseBaseline,
  parseScorecard,
  type Scorecard,
  serialiseBaseline,
} from "./scorecard.js";
import { suggestTolerance, summarise } from "./variance.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────────────────────

function gated(overrides: Partial<GatedMetric> = {}): GatedMetric {
  return {
    id: "detect.medianLatencyMs",
    value: 8000,
    direction: "lower-is-better",
    unit: "ms",
    label: "median time from a rail breaking to an incident opening",
    tolerance: 1000,
    sd: 330,
    seeds: 8,
    note: "3.0 sd over 8 seeds",
    ...overrides,
  };
}

function observed(overrides: Partial<Observation> = {}): Observation {
  const { tolerance: _t, sd: _s, seeds: _n, note: _o, ...rest } = gated();
  return { ...rest, ...overrides };
}

const CONFIG: JsonValue = { profile: "quick", attemptsPerMinute: 400 };

function scorecard(overrides: Partial<Scorecard> = {}): Scorecard {
  return {
    provenance: {
      profile: "quick",
      configHash: configHash(CONFIG),
      codeRevision: "abc1234",
      node: "v22.14.0",
      config: CONFIG,
    },
    metrics: [observed()],
    invariants: [invariant.zero("spend.overspendPaise", "spend never exceeded the budget", 0)],
    elapsedMs: 1234,
    ...overrides,
  };
}

function baseline(overrides: Partial<Baseline> = {}): Baseline {
  const card = scorecard();
  return {
    provenance: card.provenance,
    blessedAt: "2026-08-26",
    metrics: [gated()],
    invariants: card.invariants,
    ...overrides,
  };
}

// ── The band ──────────────────────────────────────────────────────────────────────────────────

describe("classify", () => {
  it("treats a move of exactly the tolerance as held", () => {
    // The tolerance is a round number a human chose from a noisy standard deviation. Treating its
    // last digit as decisive would claim a precision it does not have.
    expect(classify(gated(), observed({ value: 9000 }))).toBe("held");
    expect(classify(gated(), observed({ value: 7000 }))).toBe("held");
  });

  it("fails a move past the tolerance in the bad direction", () => {
    expect(classify(gated(), observed({ value: 9001 }))).toBe("regressed");
  });

  it("does not fail a move past the tolerance in the good direction", () => {
    expect(classify(gated(), observed({ value: 6999 }))).toBe("improved");
  });

  it("reads the direction the metric declares, not the sign of the delta", () => {
    const lift = gated({ direction: "higher-is-better", value: 100, tolerance: 10 });
    expect(classify(lift, observed({ value: 89 }))).toBe("regressed");
    expect(classify(lift, observed({ value: 111 }))).toBe("improved");
  });

  it("calls a neutral metric drifted in either direction", () => {
    const mix = gated({ direction: "neutral", value: 0.5, tolerance: 0.02, unit: "ratio" });
    expect(classify(mix, observed({ value: 0.6 }))).toBe("drifted");
    expect(classify(mix, observed({ value: 0.4 }))).toBe("drifted");
    expect(classify(mix, observed({ value: 0.51 }))).toBe("held");
  });

  it("reports an uncalibrated metric rather than inventing a band for it", () => {
    expect(classify(gated({ tolerance: null }), observed({ value: 1e9 }))).toBe("ungated");
  });
});

describe("fails", () => {
  it("stops a build only for a regression or a metric that vanished", () => {
    const stopping: Outcome[] = ["regressed", "missing"];
    const passing: Outcome[] = ["held", "improved", "drifted", "ungated", "unexpected"];
    for (const outcome of stopping) expect(fails(outcome)).toBe(true);
    for (const outcome of passing) expect(fails(outcome)).toBe(false);
  });
});

// ── Invariants ────────────────────────────────────────────────────────────────────────────────

describe("checkInvariant", () => {
  it("holds a zero at zero and breaks on a single paise", () => {
    expect(checkInvariant(invariant.zero("x", "l", 0)).ok).toBe(true);
    expect(checkInvariant(invariant.zero("x", "l", 1)).ok).toBe(false);
    expect(checkInvariant(invariant.zero("x", "l", -1)).ok).toBe(false);
  });

  it("breaks a `positive` at zero — the control arm that stopped being a control", () => {
    // If the naive spend arm stops overspending because the harness broke, every claim about the
    // kernel still passes while proving nothing. This is the only check that notices.
    const check = checkInvariant(invariant.positive("naive.overspend", "the race is real", 0));
    expect(check.ok).toBe(false);
    expect(check.reason).toContain("above zero");
  });

  it("breaks a `positive` on a non-finite value rather than letting NaN through", () => {
    expect(checkInvariant(invariant.positive("x", "l", Number.NaN)).ok).toBe(false);
    // NaN > 0 is false, so the plain comparison would catch it; Infinity would not.
    expect(checkInvariant(invariant.positive("x", "l", Number.POSITIVE_INFINITY)).ok).toBe(false);
  });

  it("holds a boolean claim only when it is true", () => {
    expect(checkInvariant(invariant.holds("x", "l", true)).ok).toBe(true);
    expect(checkInvariant(invariant.holds("x", "l", false)).ok).toBe(false);
  });

  it("compares an exact claim against its expected value", () => {
    expect(checkInvariant(invariant.exact("x", "l", 28, 28)).ok).toBe(true);
    expect(checkInvariant(invariant.exact("x", "l", 27, 28)).reason).toBe(
      "expected 28, observed 27",
    );
  });

  it("reports a mistyped observation as a failure rather than throwing", () => {
    // Four independent harnesses feed this. One emitting a boolean where a count belongs should be
    // a red line in the report, not a crash that hides the other nineteen results.
    const mistyped = { ...invariant.zero("x", "l", 0), value: true as unknown as number };
    const check = checkInvariant(mistyped);
    expect(check.ok).toBe(false);
    expect(check.reason).toContain("needs a number");
  });

  it("refuses an exact claim with no expected value", () => {
    const broken = { ...invariant.exact("x", "l", 5, 5), expected: null };
    expect(checkInvariant(broken).reason).toContain("carries no expected value");
  });
});

// ── Provenance ────────────────────────────────────────────────────────────────────────────────

describe("canonicalise", () => {
  it("ignores object key order", () => {
    expect(canonicalise({ a: 1, b: 2 })).toBe(canonicalise({ b: 2, a: 1 }));
  });

  it("respects array order, because a ladder is not a set", () => {
    // `contactLadderMs: [0, 1d, 3d]` is a different experiment from `[3d, 1d, 0]`, and the
    // canonicaliser cannot tell that list from a list of thresholds where order is presentation.
    expect(canonicalise([1, 2])).not.toBe(canonicalise([2, 1]));
  });

  it("sorts keys at every depth", () => {
    const a = { outer: { z: 1, a: { y: 2, b: 3 } } };
    const b = { outer: { a: { b: 3, y: 2 }, z: 1 } };
    expect(canonicalise(a)).toBe(canonicalise(b));
  });

  it("treats negative zero as zero", () => {
    expect(canonicalise({ x: -0 })).toBe(canonicalise({ x: 0 }));
  });

  it("throws on a non-finite number rather than hashing it as null", () => {
    // `JSON.stringify` turns NaN into null, so a broken config would hash identically to one with
    // an explicit null and the hash would certify a run that never happened.
    expect(() => canonicalise({ rate: Number.NaN })).toThrow(/config\.rate is NaN/);
    expect(() => canonicalise({ nested: [{ x: Number.POSITIVE_INFINITY }] })).toThrow(
      /config\.nested\[0\]\.x is Infinity/,
    );
  });
});

describe("configHash", () => {
  it("is stable across key order and sensitive to any value", () => {
    expect(configHash({ a: 1, b: [1, 2] })).toBe(configHash({ b: [1, 2], a: 1 }));
    expect(configHash({ a: 1 })).not.toBe(configHash({ a: 2 }));
  });

  it("is sixteen lowercase hex characters, which the baseline schema requires", () => {
    expect(configHash(CONFIG)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("codeRevision", () => {
  const runner =
    (head: string | null, status: string | null): Runner =>
    (_cmd, args) =>
      args[1] === "rev-parse" || args[0] === "rev-parse" ? head : status;

  it("marks a dirty tree", () => {
    expect(codeRevision(runner("abc1234", " M src/x.ts"))).toBe("abc1234-dirty");
  });

  it("leaves a clean tree unmarked", () => {
    expect(codeRevision(runner("abc1234", ""))).toBe("abc1234");
  });

  it("degrades to `unknown` where there is no repository", () => {
    // A scorecard produced from a tarball, or in a container that did not copy `.git`, is still a
    // valid scorecard.
    expect(codeRevision(runner(null, null))).toBe("unknown");
  });
});

// ── Comparison ────────────────────────────────────────────────────────────────────────────────

describe("compare", () => {
  it("passes a run that held", () => {
    const verdict = compare(baseline(), scorecard());
    expect(verdict.failed).toBe(false);
    expect(verdict.comparable).toBe(true);
  });

  it("fails a regression", () => {
    const verdict = compare(baseline(), scorecard({ metrics: [observed({ value: 9500 })] }));
    expect(verdict.failed).toBe(true);
    expect(verdict.metrics[0]?.outcome).toBe("regressed");
  });

  it("fails a metric the harness stopped reporting", () => {
    const verdict = compare(baseline(), scorecard({ metrics: [] }));
    expect(verdict.metrics[0]?.outcome).toBe("missing");
    expect(verdict.failed).toBe(true);
  });

  it("does not fail on a metric that is merely new", () => {
    const extra = observed({ id: "recover.optOuts", value: 43, unit: "count" });
    const verdict = compare(baseline(), scorecard({ metrics: [observed(), extra] }));
    expect(verdict.failed).toBe(false);
    expect(verdict.metrics.find((m) => m.id === "recover.optOuts")?.outcome).toBe("unexpected");
    expect(verdict.advisories.join(" ")).toContain("recover.optOuts");
  });

  describe("when the experiment itself changed", () => {
    const elsewhere = scorecard({
      provenance: { ...scorecard().provenance, configHash: configHash({ different: true }) },
      metrics: [observed({ value: 99_999 })],
    });

    it("stops comparing metrics, because they answer a different question", () => {
      const verdict = compare(baseline(), elsewhere);
      expect(verdict.comparable).toBe(false);
      expect(verdict.metrics).toEqual([]);
    });

    it("still fails, so no commit is left with a green and vacuous gate", () => {
      expect(compare(baseline(), elsewhere).failed).toBe(true);
    });

    it("says what to do instead of reporting a performance bug that does not exist", () => {
      expect(compare(baseline(), elsewhere).incomparableReason).toContain("bench:bless");
    });

    it("keeps checking the invariants, which do not depend on the experiment", () => {
      const broken = {
        ...elsewhere,
        invariants: [invariant.zero("spend.overspendPaise", "l", 500)],
      };
      const verdict = compare(baseline(), broken);
      expect(verdict.comparable).toBe(false);
      expect(verdict.invariants[0]?.check.ok).toBe(false);
    });
  });

  it("fails when the run stopped reporting an invariant the baseline expects", () => {
    // A check vanishing is the same failure as a check breaking: nothing is watching it now.
    const verdict = compare(baseline(), scorecard({ invariants: [] }));
    expect(verdict.failed).toBe(true);
    expect(verdict.invariants[0]?.check.reason).toContain("did not report it");
  });

  it("advises on a Node major mismatch without failing for it", () => {
    const onNode24 = scorecard({ provenance: { ...scorecard().provenance, node: "v24.2.0" } });
    const verdict = compare(baseline(), onNode24);
    expect(verdict.failed).toBe(false);
    expect(verdict.advisories.join(" ")).toContain("v24.2.0");
  });

  it("does not advise on a patch-level Node difference", () => {
    const patched = scorecard({ provenance: { ...scorecard().provenance, node: "v22.99.1" } });
    expect(compare(baseline(), patched).advisories).toEqual([]);
  });
});

// ── Blessing ──────────────────────────────────────────────────────────────────────────────────

describe("bless", () => {
  it("updates the value and carries the band across unchanged", () => {
    const result = bless(
      baseline(),
      scorecard({ metrics: [observed({ value: 8600 })] }),
      "2026-09-01",
    );
    const metric = result.baseline.metrics[0];
    expect(metric?.value).toBe(8600);
    expect(metric?.tolerance).toBe(1000);
    expect(metric?.sd).toBe(330);
    expect(metric?.seeds).toBe(8);
  });

  it("never widens a tolerance to fit the run being blessed", () => {
    // The ratchet this prevents: a metric drifts, sets its own gate wider on the way past, and the
    // band opens one innocent commit at a time until it catches nothing. Widening is a reviewed
    // edit to the committed file, never a side effect of running a command.
    const wandered = scorecard({ metrics: [observed({ value: 50_000 })] });
    const result = bless(baseline(), wandered, "2026-09-01");
    expect(result.baseline.metrics[0]?.tolerance).toBe(1000);
    // And the widened baseline still fails the next comparison, at the new value's own band.
    expect(
      compare(result.baseline, scorecard({ metrics: [observed({ value: 60_000 })] })).failed,
    ).toBe(true);
  });

  it("records a metric with no previous entry as uncalibrated rather than guessing", () => {
    const withNew = scorecard({
      metrics: [observed(), observed({ id: "recover.ece", value: 0.016 })],
    });
    const result = bless(baseline(), withNew, "2026-09-01");
    expect(result.uncalibrated).toEqual(["recover.ece"]);
    expect(result.baseline.metrics.find((m) => m.id === "recover.ece")?.tolerance).toBeNull();
  });

  it("reports a metric that disappeared instead of silently dropping it", () => {
    const result = bless(baseline(), scorecard({ metrics: [] }), "2026-09-01");
    expect(result.dropped).toEqual(["detect.medianLatencyMs"]);
  });

  it("is a no-op when nothing but the date would move", () => {
    // So that every change to the baseline in the history is a change to what the project claims.
    expect(bless(baseline(), scorecard(), "2027-01-01").changed).toBe(false);
    expect(
      bless(baseline(), scorecard({ metrics: [observed({ value: 8001 })] }), "2026-08-26").changed,
    ).toBe(true);
  });

  it("builds a first baseline from nothing", () => {
    const result = bless(null, scorecard(), "2026-08-26");
    expect(result.changed).toBe(true);
    expect(result.uncalibrated).toEqual(["detect.medianLatencyMs"]);
  });
});

// ── Documents ─────────────────────────────────────────────────────────────────────────────────

describe("parseBaseline", () => {
  it("round-trips what it serialises", () => {
    expect(parseBaseline(JSON.parse(serialiseBaseline(baseline())))).toEqual(baseline());
  });

  it("rejects an unknown key, so a typo does not silently ungate a metric", () => {
    const typo = { ...baseline(), metrics: [{ ...gated(), tolerence: 5 }] };
    expect(() => parseBaseline(typo)).toThrow(/not valid/);
  });

  it("rejects a config hash that is not sixteen hex characters", () => {
    const wrong = { ...baseline(), provenance: { ...baseline().provenance, configHash: "nope" } };
    expect(() => parseBaseline(wrong)).toThrow(/hex/);
  });

  it("rejects a negative tolerance", () => {
    const wrong = { ...baseline(), metrics: [gated({ tolerance: -1 })] };
    expect(() => parseBaseline(wrong)).toThrow(/not valid/);
  });

  it("names the offending field", () => {
    const wrong = { ...baseline(), blessedAt: "yesterday" };
    expect(() => parseBaseline(wrong)).toThrow(/blessedAt/);
  });

  it("accepts a nested configuration of arbitrary shape", () => {
    const nested: JsonValue = { a: [1, { b: null, c: ["x", true] }] };
    const doc = { ...baseline(), provenance: { ...baseline().provenance, config: nested } };
    expect(parseBaseline(doc).provenance.config).toEqual(nested);
  });
});

describe("parseScorecard", () => {
  it("accepts a well-formed run and rejects a non-finite metric", () => {
    expect(parseScorecard(JSON.parse(JSON.stringify(scorecard())))).toEqual(scorecard());
    // JSON has no NaN, so this arrives as a null and must not be read as zero.
    const broken = { ...scorecard(), metrics: [{ ...observed(), value: null }] };
    expect(() => parseScorecard(broken)).toThrow(/not valid/);
  });
});

// ── Spread ────────────────────────────────────────────────────────────────────────────────────

describe("summarise", () => {
  it("uses the sample standard deviation, because seeds estimate a wider population", () => {
    // Population sd of [2,4,4,4,5,5,7,9] is 2; the sample sd is larger.
    const spread = summarise([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(spread.mean).toBe(5);
    expect(spread.sd).toBeCloseTo(Math.sqrt(32 / 7), 10);
    expect(spread.sd).toBeGreaterThan(2);
  });

  it("reports the range and the coefficient of variation", () => {
    const spread = summarise([10, 20, 30]);
    expect([spread.min, spread.max, spread.n]).toEqual([10, 30, 3]);
    expect(spread.coefficientOfVariation).toBeCloseTo(10 / 20, 10);
  });

  it("flags a metric that never moved, which usually means it is an invariant", () => {
    expect(summarise([7, 7, 7]).degenerate).toBe(true);
    expect(summarise([7, 7, 8]).degenerate).toBe(false);
  });

  it("handles a single sample without dividing by zero", () => {
    expect(summarise([4])).toMatchObject({ n: 1, mean: 4, sd: 0, degenerate: true });
  });

  it("has no answer for no samples", () => {
    expect(() => summarise([])).toThrow(RangeError);
  });

  it("returns no coefficient of variation at a mean of zero", () => {
    expect(summarise([-1, 0, 1]).coefficientOfVariation).toBeNull();
  });
});

describe("suggestTolerance", () => {
  it("rounds up to one, two or five times a power of ten", () => {
    const at = (sd: number): number | null => suggestTolerance({ ...summarise([0, sd * 2]), sd });
    // 3 sd of 330 is 990 → 1,000; of 400 is 1,200 → 1,500; of 700 is 2,100 → 3,000.
    expect(at(330)).toBe(1000);
    expect(at(400)).toBe(1500);
    expect(at(700)).toBe(3000);
    // Past seven times the magnitude it steps to the next power of ten: 3 sd of 2,500 is 7,500.
    expect(at(2500)).toBe(10_000);
    // And that next power is itself a magnitude, so 10,200 rounds to 15,000, not to 20,000.
    expect(at(3400)).toBe(15_000);
  });

  it("returns the number on the ladder rather than the float that computes it", () => {
    // `3 * 0.1` is 0.30000000000000004, which in a committed baseline reads as a precision claim.
    expect(suggestTolerance({ ...summarise([0, 0.2]), sd: 0.067 })).toBe(0.3);
  });

  it("has a ladder fine enough that rounding does not dominate the evidence", () => {
    // The case that forced it: 3 sd of 9.4 percentage points is 28.1, and a 1-2-5 ladder rounds
    // that to fifty — a band wider than the metric it guards, arrived at by arithmetic on the
    // rounding rule rather than by anything measured.
    expect(suggestTolerance({ ...summarise([0, 20]), sd: 9.4 })).toBe(30);
  });

  it("rounds up rather than to nearest, because the sd is itself an estimate", () => {
    const spread = { ...summarise([0, 2]), sd: 1 };
    expect(suggestTolerance(spread, 1)).toBe(1);
    expect(suggestTolerance({ ...spread, sd: 1.01 }, 1)).toBe(1.5);
  });

  it("has no tolerance to offer for a metric that never moved", () => {
    // The answer there is to make it an invariant, not to give it a band of zero.
    expect(suggestTolerance(summarise([5, 5, 5]))).toBeNull();
  });
});

// ── Formatting ────────────────────────────────────────────────────────────────────────────────

describe("formatValue", () => {
  it("groups counts the Indian way, matching the money formatter beside it", () => {
    expect(formatValue(5556, "count")).toBe("5,556");
    expect(formatValue(1_234_567, "count")).toBe("12,34,567");
  });

  it("scales milliseconds to something a person can read", () => {
    expect(formatValue(437, "ms")).toBe("437ms");
    expect(formatValue(8437, "ms")).toBe("8.4s");
    expect(formatValue(180_000, "ms")).toBe("3.0min");
  });

  it("renders paise as rupees", () => {
    expect(formatValue(696_678_00, "paise")).toBe("₹6,96,678.00");
    expect(formatValue(-1_00, "paise")).toBe("-₹1.00");
  });

  it("throws on a non-finite paise value instead of printing ₹NaN", () => {
    expect(() => formatValue(Number.NaN, "paise")).toThrow();
  });
});

describe("formatDelta", () => {
  it("moves ratios in percentage points, which is the unambiguous unit", () => {
    expect(formatDelta(0.016, "ratio")).toBe("+1.60pp");
    expect(formatDelta(-0.016, "ratio")).toBe("−1.60pp");
    expect(formatDelta(0, "ratio")).toBe("±0.00pp");
  });

  it("signs other units without doubling the minus", () => {
    expect(formatDelta(-500, "ms")).toBe("−500ms");
  });
});

describe("toleranceShare", () => {
  it("expresses a band against the value it guards", () => {
    expect(toleranceShare(gated())).toBeCloseTo(0.125, 10);
  });

  it("has nothing to express for an ungated metric or a baseline of zero", () => {
    expect(toleranceShare(gated({ tolerance: null }))).toBeNull();
    expect(toleranceShare(gated({ value: 0 }))).toBeNull();
  });
});

// ── Report ────────────────────────────────────────────────────────────────────────────────────

describe("renderVerdict", () => {
  it("puts the failure and its band on the screen", () => {
    const text = renderVerdict(
      compare(baseline(), scorecard({ metrics: [observed({ value: 9500 })] })),
    );
    expect(text).toContain("FAILED");
    expect(text).toContain("detect.medianLatencyMs");
    expect(text).toContain("±1.0s");
    expect(text).toContain("3.0 sd over 8 seeds");
  });

  it("orders the worst outcome first", () => {
    const verdict = compare(
      baseline({ metrics: [gated(), gated({ id: "b.held", value: 10, tolerance: 1 })] }),
      scorecard({ metrics: [observed({ value: 9500 }), observed({ id: "b.held", value: 10 })] }),
    );
    const text = renderVerdict(verdict);
    expect(text.indexOf("detect.medianLatencyMs")).toBeLessThan(text.indexOf("b.held"));
  });

  it("names the broken invariant and what it protects", () => {
    const text = renderVerdict(
      compare(
        baseline(),
        scorecard({
          invariants: [
            invariant.zero("spend.overspendPaise", "spend never exceeded the budget", 700),
          ],
        }),
      ),
    );
    expect(text).toContain("spend.overspendPaise: expected 0, observed 700");
    expect(text).toContain("spend never exceeded the budget");
  });

  it("says which bands are too wide to catch anything but breakage", () => {
    // A reader who sees PASSED deserves to know which half of the sheet is load-bearing.
    const wide = gated({ id: "a.wide", value: 10, tolerance: 40 });
    const tight = gated({ id: "b.tight", value: 100, tolerance: 5 });
    const text = renderVerdict(
      compare(
        baseline({ metrics: [wide, tight] }),
        scorecard({
          metrics: [observed({ id: "a.wide", value: 10 }), observed({ id: "b.tight", value: 100 })],
        }),
      ),
    );
    expect(text).toContain("1 of 2 bands are wider than half");
    expect(text).toContain("a.wide");
    expect(text).not.toContain("breakage rather than degradation: b.tight");
  });

  it("says a run passed when it did", () => {
    expect(renderVerdict(compare(baseline(), scorecard()))).toContain("PASSED");
  });
});
