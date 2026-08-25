import { describe, expect, it } from "vitest";
import {
  availablePaise,
  type BudgetState,
  emptyBudget,
  inFlight,
  overspendBoundPaise,
  release,
  reserve,
  settle,
  sweepExpired,
} from "./budget.js";

const TTL = 30_000;

function grant(
  state: BudgetState,
  id: string,
  amountPaise: number,
  now: number,
  maxInFlight = 100,
) {
  return reserve(state, { id, amountPaise, maxInFlight, ttlMs: TTL, now });
}

describe("the ledger identity", () => {
  it("partitions the budget into spent, held and available", () => {
    let state = emptyBudget(1000);
    state = grant(state, "a", 300, 0).state;
    state = grant(state, "b", 200, 0).state;
    state = settle(state, "a", 250, 10).state;

    expect(state.settledPaise).toBe(250);
    expect(state.committedPaise).toBe(200);
    expect(availablePaise(state)).toBe(550);
    expect(state.budgetPaise).toBe(
      state.settledPaise + state.committedPaise + availablePaise(state),
    );
  });

  it("starts with the whole budget available and nothing in flight", () => {
    const state = emptyBudget(5000);
    expect(availablePaise(state)).toBe(5000);
    expect(inFlight(state)).toBe(0);
  });
});

describe("reserve", () => {
  it("grants when the amount fits", () => {
    const { result } = grant(emptyBudget(1000), "a", 400, 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reservedPaise).toBe(400);
    expect(result.availablePaise).toBe(600);
    expect(result.replayed).toBe(false);
  });

  it("refuses when the amount exceeds what is available", () => {
    const state = grant(emptyBudget(1000), "a", 900, 0).state;
    const { result } = grant(state, "b", 200, 0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.axis).toBe("budget");
    expect(result.availablePaise).toBe(100);
  });

  it("admits an amount exactly equal to what remains", () => {
    // The boundary belongs on the permissive side: refusing the last rupee of an exhausted budget
    // would leave authority stranded that the merchant explicitly granted.
    const state = grant(emptyBudget(1000), "a", 900, 0).state;
    const { result } = grant(state, "b", 100, 0);
    expect(result.ok).toBe(true);
  });

  it("refuses on concurrency before it refuses on budget", () => {
    // Both would refuse, but only one of them clears on its own. Naming the wrong axis sends a
    // caller into a retry loop against an exhausted budget that will never free up.
    let state = emptyBudget(1_000_000);
    state = grant(state, "a", 10, 0, 2).state;
    state = grant(state, "b", 10, 0, 2).state;
    const { result } = grant(state, "c", 999_000, 0, 2);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.axis).toBe("concurrency");
    expect(result.inFlight).toBe(2);
  });

  it("is idempotent on the reservation id", () => {
    // A worker that reserves, crashes and restarts derives the same id and must get its own
    // reservation back rather than committing a second one.
    const first = grant(emptyBudget(1000), "a", 400, 0);
    const second = grant(first.state, "a", 400, 5);

    expect(second.result.ok).toBe(true);
    if (!second.result.ok) return;
    expect(second.result.replayed).toBe(true);
    expect(second.state.committedPaise).toBe(400);
    expect(inFlight(second.state)).toBe(1);
  });

  it("replays the original amount, not the amount asked for the second time", () => {
    const first = grant(emptyBudget(1000), "a", 400, 0);
    const second = grant(first.state, "a", 900, 5);
    expect(second.result.ok).toBe(true);
    if (!second.result.ok) return;
    expect(second.result.reservedPaise).toBe(400);
  });
});

describe("expiry", () => {
  it("returns authority once a reservation lapses", () => {
    const state = grant(emptyBudget(1000), "a", 400, 0).state;
    expect(availablePaise(state)).toBe(600);

    const swept = sweepExpired(state, TTL);
    expect(availablePaise(swept)).toBe(1000);
    expect(swept.expiredCount).toBe(1);
    expect(inFlight(swept)).toBe(0);
  });

  it("leaves a live reservation alone", () => {
    const state = grant(emptyBudget(1000), "a", 400, 0).state;
    expect(sweepExpired(state, TTL - 1)).toBe(state);
  });

  it("sweeps as part of every operation, so nothing has to run a timer", () => {
    const state = grant(emptyBudget(1000), "a", 900, 0).state;
    const { result } = grant(state, "b", 900, TTL);
    expect(result.ok).toBe(true);
  });

  it("counts a settlement against a lapsed reservation as an orphan, and still books it", () => {
    // The dangerous case: the money left the building while its authority had already returned to
    // the pool, so that spend was bounded by nothing. It must be visible, not discarded.
    const state = grant(emptyBudget(1000), "a", 400, 0).state;
    const { state: after, result } = settle(state, "a", 380, TTL);

    expect(result.known).toBe(false);
    expect(after.orphanCount).toBe(1);
    expect(after.settledPaise).toBe(380);
    expect(after.overrunPaise).toBe(380);
  });
});

describe("settle", () => {
  it("books the actual cost and frees the reservation", () => {
    const state = grant(emptyBudget(1000), "a", 400, 0).state;
    const { state: after, result } = settle(state, "a", 250, 10);

    expect(result.reservedPaise).toBe(400);
    expect(result.actualPaise).toBe(250);
    expect(result.overrunPaise).toBe(0);
    expect(after.committedPaise).toBe(0);
    expect(availablePaise(after)).toBe(750);
  });

  it("records an overrun when the real cost exceeds the reservation", () => {
    // An SMS estimated at one GSM-7 segment that the model wrote in Devanagari: three segments.
    const state = grant(emptyBudget(1000), "a", 100, 0).state;
    const { state: after, result } = settle(state, "a", 300, 10);

    expect(result.overrunPaise).toBe(200);
    expect(after.overrunPaise).toBe(200);
    expect(availablePaise(after)).toBe(700);
  });

  it("lets an early overrun self-correct out of future capacity", () => {
    // The overrun is absorbed by admitting fewer actions later, so the budget still holds. This is
    // why only reservations live at the moment of exhaustion can breach it.
    let state = emptyBudget(1000);
    state = grant(state, "a", 100, 0).state;
    state = settle(state, "a", 400, 10).state;

    expect(availablePaise(state)).toBe(600);
    const { result } = grant(state, "b", 700, 20);
    expect(result.ok).toBe(false);
  });

  it("counts a settlement of zero as a settlement", () => {
    const state = grant(emptyBudget(1000), "a", 400, 0).state;
    const { state: after } = settle(state, "a", 0, 10);
    expect(after.settledCount).toBe(1);
    expect(after.settledPaise).toBe(0);
  });
});

describe("release", () => {
  it("hands authority back without recording a spend", () => {
    const state = grant(emptyBudget(1000), "a", 400, 0).state;
    const { state: after, result } = release(state, "a", 10);

    expect(result.released).toBe(true);
    expect(result.releasedPaise).toBe(400);
    expect(availablePaise(after)).toBe(1000);
    expect(after.settledCount).toBe(0);
    expect(after.settledPaise).toBe(0);
  });

  it("is a no-op for an id it does not hold", () => {
    const state = emptyBudget(1000);
    const { result } = release(state, "ghost", 10);
    expect(result.released).toBe(false);
    expect(result.releasedPaise).toBe(0);
  });

  it("differs from settling zero, which would claim an action happened", () => {
    const base = grant(emptyBudget(1000), "a", 400, 0).state;
    expect(release(base, "a", 10).state.settledCount).toBe(0);
    expect(settle(base, "a", 0, 10).state.settledCount).toBe(1);
  });
});

describe("the overspend bound", () => {
  it("is zero when the reservation covers the worst case", () => {
    expect(overspendBoundPaise(8, 300, 300)).toBe(0);
    expect(overspendBoundPaise(8, 300, 400)).toBe(0);
  });

  it("scales with the in-flight cap, not with the worker count", () => {
    expect(overspendBoundPaise(4, 300, 100)).toBe(800);
    expect(overspendBoundPaise(8, 300, 100)).toBe(1600);
  });

  /**
   * The bound, exercised adversarially: fill the in-flight slots, drain the budget to zero, then
   * have every live action come back at the worst possible cost.
   */
  it("holds when every in-flight action overruns to the per-action ceiling at once", () => {
    const BUDGET = 1000;
    const MAX_COST = 250;
    const RESERVE = 50;
    const IN_FLIGHT = 4;

    let state = emptyBudget(BUDGET);
    let next = 0;
    const open: string[] = [];

    // Reserve and settle at the reservation amount until the budget will take no more.
    for (;;) {
      const id = `r${next++}`;
      const { state: after, result } = grant(state, id, RESERVE, 0, IN_FLIGHT);
      if (!result.ok) break;
      state = after;
      open.push(id);
      if (open.length === IN_FLIGHT) {
        const settling = open.splice(0, IN_FLIGHT - 1);
        for (const s of settling) state = settle(state, s, RESERVE, 0).state;
      }
    }

    expect(inFlight(state)).toBeGreaterThan(0);
    for (const id of [...open]) state = settle(state, id, MAX_COST, 0).state;

    const bound = overspendBoundPaise(IN_FLIGHT, MAX_COST, RESERVE);
    expect(state.settledPaise).toBeGreaterThan(BUDGET);
    expect(state.settledPaise).toBeLessThanOrEqual(BUDGET + bound);
  });

  it("is exactly zero in practice when reserving the worst case", () => {
    const BUDGET = 1000;
    const MAX_COST = 250;

    let state = emptyBudget(BUDGET);
    let next = 0;
    for (;;) {
      const { state: after, result } = grant(state, `r${next++}`, MAX_COST, 0, 4);
      if (!result.ok) break;
      state = after;
      if (inFlight(after) === 4) {
        let s = after;
        for (const id of Object.keys(after.live)) s = settle(s, id, MAX_COST, 0).state;
        state = s;
      } else {
        state = after;
      }
    }
    for (const id of Object.keys(state.live)) state = settle(state, id, MAX_COST, 0).state;

    expect(state.settledPaise).toBeLessThanOrEqual(BUDGET);
    expect(state.overrunPaise).toBe(0);
  });
});
