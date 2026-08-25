import { rupees } from "@kairos/domain";
import { worstCaseSizer } from "@kairos/terminus";
import { describe, expect, it } from "vitest";
import {
  buildJobs,
  DEFAULT_SPEND_OPTIONS,
  runNaive,
  runTerminus,
  SIZERS,
  type SpendOptions,
} from "./spend.js";

/** Small enough to keep the suite quick, large enough for the budget to bind. */
const FAST: SpendOptions = {
  ...DEFAULT_SPEND_OPTIONS,
  budgetPaise: rupees(60),
  jobs: 400,
  customers: 40,
};

const at = (workers: number): SpendOptions => ({ ...FAST, workers });

describe("buildJobs", () => {
  it("is fully determined by its seed", () => {
    expect(buildJobs(FAST)).toEqual(buildJobs(FAST));
  });

  it("clusters each customer's jobs together", () => {
    // A customer whose card is failing produces several casualties close in time. Spreading them
    // evenly would mean no two workers ever hold the same customer at once, which would make a
    // check-then-act contact cap look correct.
    const jobs = buildJobs({ ...FAST, jobs: 20, customers: 4 });
    const seen = jobs.map((j) => j.customer);
    expect(new Set(seen).size).toBe(4);
    expect(seen.slice(0, 5).every((c) => c === seen[0])).toBe(true);
  });

  it("draws the expensive script at roughly the configured share", () => {
    const jobs = buildJobs({ ...FAST, jobs: 4000, devanagariShare: 0.35 });
    const expensive = jobs.filter((j) => j.actualCostPaise === rupees(3)).length;
    expect(expensive / jobs.length).toBeGreaterThan(0.3);
    expect(expensive / jobs.length).toBeLessThan(0.4);
  });
});

describe("the naive arm", () => {
  it("overspends by the cost uncertainty alone, even with a single worker", async () => {
    // Two separate bugs live in check-then-spend, and this is the one that has nothing to do with
    // concurrency: the check prices the action at its estimate and the spend books the actual, so
    // the last message through the gate can cost more than the budget had left. One worker bounds
    // that at a single action's excess; the fleet is what turns it into a multiple.
    const result = await runNaive(at(1));
    expect(result.overspendPaise).toBeGreaterThan(0);
    expect(result.overspendPaise).toBeLessThanOrEqual(rupees(3) - rupees(1));
  });

  it("overspends far more as the fleet grows", async () => {
    const one = await runNaive(at(1));
    const large = await runNaive(at(64));
    expect(large.overspendPaise).toBeGreaterThan(one.overspendPaise * 4);
  });

  it("delivers messages past the contact cap", async () => {
    const result = await runNaive(at(32));
    expect(result.capViolations).toBeGreaterThan(0);
    expect(result.maxContactsToOneCustomer).toBeGreaterThan(FAST.contactCapLimit);
  });

  it("is deterministic despite being genuinely concurrent", async () => {
    // The microtask queue is FIFO, so a fixed number of yields fixes the interleaving. Without
    // this the whole comparison would be anecdote rather than measurement.
    const first = await runNaive(at(16));
    const second = await runNaive(at(16));
    expect(first).toEqual(second);
  });
});

describe("the kernel arm", () => {
  const workerCounts = [1, 8, 64];

  it.each(workerCounts)(
    "never overspends at %i workers, reserving the worst case",
    async (workers) => {
      const result = await runTerminus(at(workers), (max) => worstCaseSizer(max));
      expect(result.overspendPaise).toBe(0);
      expect(result.spentPaise).toBeLessThanOrEqual(FAST.budgetPaise);
    },
  );

  it.each(workerCounts)("never exceeds the contact cap at %i workers", async (workers) => {
    const result = await runTerminus(at(workers), (max) => worstCaseSizer(max));
    expect(result.capViolations).toBe(0);
    expect(result.maxContactsToOneCustomer).toBeLessThanOrEqual(FAST.contactCapLimit);
  });

  it.each(SIZERS)("keeps %s inside its own stated bound", async (_name, makeSizer) => {
    const result = await runTerminus(at(64), makeSizer);
    expect(result.boundPaise).not.toBeNull();
    expect(result.overspendPaise).toBeLessThanOrEqual(result.boundPaise ?? 0);
  });

  it("spends the budget it was given rather than sterilising it", async () => {
    // Safety that costs all the utilisation is not safety, it is a different failure.
    const result = await runTerminus(at(64), (max) => worstCaseSizer(max));
    expect(result.utilisation).toBeGreaterThan(0.95);
  });

  it("leaves no orphaned reservations behind", async () => {
    const result = await runTerminus(at(64), (max) => worstCaseSizer(max));
    expect(result.orphans).toBe(0);
  });

  it("produces an audit chain that verifies", async () => {
    const result = await runTerminus(at(16), (max) => worstCaseSizer(max));
    expect(result.ledgerVerified).toBe(true);
  });

  it("records why it refused, on named axes", async () => {
    const result = await runTerminus(at(16), (max) => worstCaseSizer(max));
    const axes = Object.keys(result.refusalsByAxis);
    expect(axes).toContain("contact-cap");
    expect(axes.every((a) => a !== "audit")).toBe(true);
  });

  it("is deterministic", async () => {
    const first = await runTerminus(at(16), (max) => worstCaseSizer(max));
    const second = await runTerminus(at(16), (max) => worstCaseSizer(max));
    expect(first).toEqual(second);
  });
});

describe("the two arms against each other", () => {
  it("shows the kernel holding both bounds where the naive version holds neither", async () => {
    const naive = await runNaive(at(64));
    const kernel = await runTerminus(at(64), (max) => worstCaseSizer(max));

    expect(naive.overspendPaise).toBeGreaterThan(0);
    expect(naive.capViolations).toBeGreaterThan(0);
    expect(kernel.overspendPaise).toBe(0);
    expect(kernel.capViolations).toBe(0);
  });

  it("does not buy that by getting less for its money", async () => {
    // The uninteresting way to hold a budget is to refuse everything, so the comparison has to be
    // efficiency rather than volume. Raw message counts cannot be compared here at all: the naive
    // arm sends three times as many because it spends nearly three times the budget, and counting
    // that as productivity would be scoring it on the overspend.
    const naive = await runNaive(at(64));
    const kernel = await runTerminus(at(64), (max) => worstCaseSizer(max));

    const perRupee = (r: { actionsTaken: number; spentPaise: number }): number =>
      r.actionsTaken / r.spentPaise;

    expect(perRupee(kernel)).toBeGreaterThan(perRupee(naive) * 0.9);
  });

  it("shows the naive overshoot scaling with the fleet rather than with the budget", async () => {
    // The overshoot is roughly `workers x maxActionCost`, which is an absolute quantity. That makes
    // it a rounding error on a large campaign and a catastrophe on a small one — the same 64 workers
    // that run a large budget 20% over run a small one nearly three times over.
    const small = await runNaive({ ...at(64), budgetPaise: rupees(60) });
    const large = await runNaive({ ...at(64), budgetPaise: rupees(500) });

    expect(small.overspendPaise / small.budgetPaise).toBeGreaterThan(
      large.overspendPaise / large.budgetPaise,
    );
  });
});
