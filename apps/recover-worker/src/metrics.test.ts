import { BINDING_AXES } from "@kairos/domain";
import type { DrainReport } from "@kairos/recover";
import type { BudgetSnapshot } from "@kairos/terminus";
import { describe, expect, it } from "vitest";
import { accumulate, emptyTotals, type MetricsInput, renderMetrics } from "./metrics.js";

const report = (over: Partial<DrainReport> = {}): DrainReport => ({
  considered: 10,
  claimed: 9,
  acted: 2,
  recovered: 1,
  declined: 6,
  refused: 1,
  spentPaise: 40,
  refusalsByAxis: { budget: 1 },
  declinesByReason: { "one ask": 6 },
  ...over,
});

const budget: BudgetSnapshot = {
  budgetPaise: 100_000,
  settledPaise: 400,
  committedPaise: 60,
  availablePaise: 99_540,
  overrunPaise: 0,
  inFlight: 2,
  settledCount: 8,
  expiredCount: 1,
  orphanCount: 0,
};

const input = (over: Partial<MetricsInput> = {}): MetricsInput => ({
  totals: accumulate(emptyTotals(), report(), 5000),
  budget,
  stopEngaged: false,
  startedAt: 1000,
  now: 61_000,
  fleet: true,
  delivery: "dry-run",
  campaignId: "recovery",
  merchantId: "acme",
  ...over,
});

describe("accumulate", () => {
  it("starts at nothing, with no pass recorded", () => {
    const totals = emptyTotals();
    expect(totals.passes).toBe(0);
    expect(totals.lastPassAt).toBeNull();
  });

  it("adds each pass to the running totals", () => {
    let totals = emptyTotals();
    totals = accumulate(totals, report(), 1000);
    totals = accumulate(totals, report(), 2000);
    expect(totals.passes).toBe(2);
    expect(totals.acted).toBe(4);
    expect(totals.spentPaise).toBe(80);
    expect(totals.lastPassAt).toBe(2000);
  });

  it("sums refusals per axis rather than replacing them", () => {
    let totals = emptyTotals();
    totals = accumulate(totals, report({ refusalsByAxis: { budget: 2 } }), 1000);
    totals = accumulate(totals, report({ refusalsByAxis: { budget: 3, "quiet-hours": 1 } }), 2000);
    expect(totals.refusalsByAxis).toEqual({ budget: 5, "quiet-hours": 1 });
  });

  it("counts a pass that did nothing", () => {
    // An idle pass is evidence the loop is turning, which is the whole point of the counter.
    const totals = accumulate(emptyTotals(), report({ considered: 0, acted: 0, declined: 0 }), 9);
    expect(totals.passes).toBe(1);
  });

  it("does not mutate what it was given", () => {
    const before = emptyTotals();
    accumulate(before, report(), 1000);
    expect(before.passes).toBe(0);
    expect(before.refusalsByAxis).toEqual({});
  });
});

describe("the exposition", () => {
  it("declares a type and help for every metric it emits", () => {
    const text = renderMetrics(input());
    const names = [...text.matchAll(/^([a-z_]+)\{|^([a-z_]+) /gm)]
      .map((m) => m[1] ?? m[2])
      .filter((n): n is string => n !== undefined && !n.startsWith("#"));
    for (const name of new Set(names)) {
      expect(text).toContain(`# HELP ${name} `);
      expect(text).toContain(`# TYPE ${name} `);
    }
  });

  it("emits every refusal axis, including the ones that never fired", () => {
    // A series that only appears once it fires is a series nobody can alert on the absence of.
    const text = renderMetrics(input());
    for (const axis of BINDING_AXES)
      expect(text).toContain(`kairos_refusals_total{axis="${axis}"}`);
    expect(text).toContain('kairos_refusals_total{axis="budget"} 1');
    expect(text).toContain('kairos_refusals_total{axis="audit"} 0');
  });

  it("succeeds with the store unreadable, and says so", () => {
    // A scrape that fails tells a dashboard nothing. One that succeeds with store_readable 0 tells
    // it exactly what is wrong, and marks the budget gauges as the stale numbers they are.
    const text = renderMetrics(input({ budget: null }));
    expect(text).toContain("kairos_store_readable 0");
    expect(text).not.toContain("kairos_budget_paise{");
    expect(text).toContain("kairos_drain_passes_total 1");
  });

  it("reports the budget as Terminus accounts for it", () => {
    const text = renderMetrics(input());
    expect(text).toContain(
      'kairos_budget_paise{campaign="recovery",merchant="acme",kind="ceiling"} 100000',
    );
    expect(text).toContain(
      'kairos_budget_paise{campaign="recovery",merchant="acme",kind="available"} 99540',
    );
    expect(text).toContain(
      'kairos_reservations{campaign="recovery",merchant="acme",state="in_flight"} 2',
    );
  });

  it("omits the stop gauge when there is no switch, rather than reporting a false zero", () => {
    expect(renderMetrics(input({ stopEngaged: null }))).not.toContain("kairos_stop_engaged{");
    expect(renderMetrics(input({ stopEngaged: true }))).toContain("kairos_stop_engaged{");
  });

  it("reports the stop as one when it is engaged", () => {
    expect(renderMetrics(input({ stopEngaged: true }))).toMatch(/kairos_stop_engaged\{[^}]*\} 1/);
    expect(renderMetrics(input({ stopEngaged: false }))).toMatch(/kairos_stop_engaged\{[^}]*\} 0/);
  });

  it("escapes a label value that would otherwise break the format", () => {
    const text = renderMetrics(input({ campaignId: 'we"ird\\one' }));
    expect(text).toContain('campaign="we\\"ird\\\\one"');
    // Whatever it did, every sample line must still parse as name{labels} value.
    for (const sample of text.split("\n").filter((l) => l !== "" && !l.startsWith("#"))) {
      expect(sample).toMatch(/^[a-z_]+(\{.*\})? -?\d+$/);
    }
  });

  it("reports uptime in whole seconds and never negative", () => {
    expect(renderMetrics(input())).toContain("kairos_worker_uptime_seconds 60");
    // A clock that went backwards is not a reason to publish a negative gauge.
    expect(renderMetrics(input({ now: 0, startedAt: 1000 }))).toContain(
      "kairos_worker_uptime_seconds 0",
    );
  });

  it("ends with a newline, which the format requires", () => {
    expect(renderMetrics(input()).endsWith("\n")).toBe(true);
  });
});
