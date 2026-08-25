import { customerRef } from "@kairos/domain";
import { MemoryStore } from "throttlekit";
import { describe, expect, it } from "vitest";
import { contactLedger } from "./caps.js";
import { ManualClock } from "./ports.js";
import { BudgetLedger } from "./store.js";

const DAY = 86_400_000;

function ledger(budgetPaise = 1000): BudgetLedger {
  return new BudgetLedger({
    store: new MemoryStore({ sweepIntervalMs: 0 }),
    key: "test:budget",
    budgetPaise,
    stateTtlMs: 30 * DAY,
  });
}

describe("BudgetLedger", () => {
  it("carries state across calls", async () => {
    const budget = ledger();
    await budget.reserve({ id: "a", amountPaise: 300, maxInFlight: 4, ttlMs: 1000, now: 0 });
    const snapshot = await budget.snapshot(0);

    expect(snapshot.committedPaise).toBe(300);
    expect(snapshot.availablePaise).toBe(700);
    expect(snapshot.inFlight).toBe(1);
  });

  it("serialises concurrent reserves so the budget cannot be oversold", async () => {
    // Ten workers, each asking for a fifth of the budget, all at once. Exactly five can be right.
    const budget = ledger(1000);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        budget.reserve({ id: `w${i}`, amountPaise: 200, maxInFlight: 100, ttlMs: 1000, now: 0 }),
      ),
    );

    expect(results.filter((r) => r.ok).length).toBe(5);
    expect((await budget.snapshot(0)).availablePaise).toBe(0);
  });

  it("reads without writing", async () => {
    // A snapshot that persisted its sweep would make reading the books an act that changes them —
    // and the console reads them constantly.
    const budget = ledger();
    await budget.reserve({ id: "a", amountPaise: 300, maxInFlight: 4, ttlMs: 1000, now: 0 });

    const expired = await budget.snapshot(5000);
    expect(expired.inFlight).toBe(0);

    // The reservation is still there for the next mutating call to sweep for real.
    const replay = await budget.reserve({
      id: "a",
      amountPaise: 300,
      maxInFlight: 4,
      ttlMs: 1000,
      now: 0,
    });
    expect(replay.ok && replay.replayed).toBe(true);
  });

  it("settles and releases through the same atomic path", async () => {
    const budget = ledger();
    await budget.reserve({ id: "a", amountPaise: 300, maxInFlight: 4, ttlMs: 1000, now: 0 });
    await budget.reserve({ id: "b", amountPaise: 300, maxInFlight: 4, ttlMs: 1000, now: 0 });

    await budget.settle("a", 250, 10);
    await budget.release("b", 10);

    const snapshot = await budget.snapshot(10);
    expect(snapshot.settledPaise).toBe(250);
    expect(snapshot.committedPaise).toBe(0);
    expect(snapshot.availablePaise).toBe(750);
  });

  it("keeps two ledgers on one store independent", async () => {
    const store = new MemoryStore({ sweepIntervalMs: 0 });
    const build = (key: string) =>
      new BudgetLedger({ store, key, budgetPaise: 500, stateTtlMs: 30 * DAY });

    const august = build("acme:aug:budget");
    const september = build("acme:sep:budget");

    await august.reserve({ id: "a", amountPaise: 500, maxInFlight: 4, ttlMs: 1000, now: 0 });
    const other = await september.reserve({
      id: "a",
      amountPaise: 500,
      maxInFlight: 4,
      ttlMs: 1000,
      now: 0,
    });

    expect(other.ok).toBe(true);
  });

  it("does not re-authorise spend if the mandate's budget is edited mid-campaign", async () => {
    // The seed budget is only used when there is no prior state. A second ledger constructed with a
    // larger budget against the same key must not resurrect authority the first one already spent.
    const store = new MemoryStore({ sweepIntervalMs: 0 });
    const first = new BudgetLedger({ store, key: "k", budgetPaise: 500, stateTtlMs: DAY });
    await first.reserve({ id: "a", amountPaise: 500, maxInFlight: 4, ttlMs: 1000, now: 0 });
    await first.settle("a", 500, 1);

    const second = new BudgetLedger({ store, key: "k", budgetPaise: 5000, stateTtlMs: DAY });
    const snapshot = await second.snapshot(2);
    expect(snapshot.budgetPaise).toBe(500);
    expect(snapshot.availablePaise).toBe(0);
  });
});

describe("contactLedger", () => {
  const CUSTOMER = customerRef("cus_9f3b2a71c4e8d012");

  function caps(limit = 3) {
    return contactLedger({
      cap: { limit, windowMs: 7 * DAY },
      store: new MemoryStore({ sweepIntervalMs: 0 }),
      clock: new ManualClock(0),
      prefix: "test:contact",
    });
  }

  it("allows up to the cap and then refuses", async () => {
    const ledger = caps(3);
    for (let i = 0; i < 3; i++) expect((await ledger.consume(CUSTOMER)).allowed).toBe(true);
    expect((await ledger.consume(CUSTOMER)).allowed).toBe(false);
  });

  it("does not consume on a refusal, so `remaining` stays meaningful", async () => {
    const ledger = caps(1);
    await ledger.consume(CUSTOMER);
    const first = await ledger.consume(CUSTOMER);
    const second = await ledger.consume(CUSTOMER);
    expect(first.remaining).toBe(second.remaining);
  });

  it("reads without consuming", async () => {
    const ledger = caps(3);
    const before = await ledger.peek(CUSTOMER);
    await ledger.peek(CUSTOMER);
    const after = await ledger.peek(CUSTOMER);
    expect(before.remaining).toBe(after.remaining);
    expect(after.allowed).toBe(true);
  });

  it("counts each customer separately", async () => {
    const ledger = caps(1);
    const other = customerRef("cus_0000000000000000");
    expect((await ledger.consume(CUSTOMER)).allowed).toBe(true);
    expect((await ledger.consume(other)).allowed).toBe(true);
  });

  it("says when the allowance next returns", async () => {
    const ledger = caps(1);
    await ledger.consume(CUSTOMER);
    const refused = await ledger.consume(CUSTOMER);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterMs).toBeGreaterThan(0);
  });

  it("holds the cap against a fleet asking at once", async () => {
    const ledger = caps(3);
    const results = await Promise.all(Array.from({ length: 25 }, () => ledger.consume(CUSTOMER)));
    expect(results.filter((r) => r.allowed).length).toBe(3);
  });
});
