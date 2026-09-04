import { mandateId, paise } from "@kairos/domain";
import { MemoryStore, type Store, type Transform } from "throttlekit";
import { beforeEach, describe, expect, it } from "vitest";
import { sealMandate } from "./signature.js";
import { StopSwitch, stopSwitchKey } from "./stop-switch.js";

const SECRET = "a".repeat(64);
const DAY = 86_400_000;

function mandateFor(merchantId: string, campaignId: string) {
  return sealMandate(
    {
      id: mandateId("mnd_stop_test"),
      merchantId,
      campaignId,
      budgetPaise: paise(100_000, "budget"),
      maxActionCostPaise: paise(300),
      maxInFlight: 4,
      reservationTtlMs: 60_000,
      contactCap: { limit: 3, windowMs: 7 * DAY },
      quietHours: null,
      allowedActions: ["retry"],
      validFrom: 0,
      validUntil: 10 * DAY,
      killSwitch: false,
    },
    SECRET,
  );
}

let store: Store;
let stop: StopSwitch;

beforeEach(() => {
  store = new MemoryStore({ sweepIntervalMs: 0 });
  stop = new StopSwitch(store);
});

describe("the out-of-band stop", () => {
  it("is clear until somebody engages it", async () => {
    expect(await stop.engaged(mandateFor("m1", "recovery"))).toBe(false);
    expect(await stop.read("m1", "recovery")).toEqual({
      engagedAt: null,
      reason: null,
      by: null,
    });
  });

  it("stops the campaign it was aimed at", async () => {
    await stop.engage("m1", "recovery", 1000, "the copy is wrong", "ops@merchant");
    expect(await stop.engaged(mandateFor("m1", "recovery"))).toBe(true);
  });

  it("does not stop a campaign it was not aimed at", async () => {
    // A switch that could not be aimed is one nobody dares use.
    await stop.engage("m1", "recovery", 1000, "the copy is wrong", "ops@merchant");
    expect(await stop.engaged(mandateFor("m1", "steering"))).toBe(false);
    expect(await stop.engaged(mandateFor("m2", "recovery"))).toBe(false);
  });

  it("keeps the first account of why, not the last", async () => {
    // A second operator arriving to help should not quietly replace the record of what happened.
    const first = await stop.engage("m1", "recovery", 1000, "customers complaining", "asha");
    const second = await stop.engage("m1", "recovery", 5000, "just checking", "raj");
    expect(second).toEqual(first);
    expect(second.reason).toBe("customers complaining");
    expect(second.by).toBe("asha");
    expect(second.engagedAt).toBe(1000);
  });

  it("reports what it released", async () => {
    await stop.engage("m1", "recovery", 1000, "customers complaining", "asha");
    const released = await stop.release("m1", "recovery");
    expect(released.reason).toBe("customers complaining");
    expect(await stop.engaged(mandateFor("m1", "recovery"))).toBe(false);
  });

  it("releases a switch nobody engaged without complaining", async () => {
    expect(await stop.release("m1", "recovery")).toEqual({
      engagedAt: null,
      reason: null,
      by: null,
    });
  });

  it("counts an unreadable store as engaged", async () => {
    // P2 applied to the stop itself. If we cannot tell whether we were told to stop, we were told
    // to stop — even though it means a database outage halts the recovery arm. That is the trade.
    const broken: Store = {
      apply: () => Promise.reject(new Error("no route to host")),
      reset: () => Promise.resolve(),
    };
    expect(await new StopSwitch(broken).engaged(mandateFor("m1", "recovery"))).toBe(true);
  });

  it("lets an operator see the failure that an admission is only allowed to refuse on", async () => {
    // `engaged` swallows so an admission refuses rather than throws; `read` must not, or an
    // operator asking "is it on?" would be told "no" by a store that never answered.
    const broken: Store = {
      apply: () => Promise.reject(new Error("no route to host")),
      reset: () => Promise.resolve(),
    };
    await expect(new StopSwitch(broken).read("m1", "recovery")).rejects.toThrow(/no route to host/);
  });

  it("outlives any campaign", async () => {
    // The store has no "never": zero means gone immediately. A stop that lapsed while its campaign
    // was still running is the worst bug this file could have, so the TTL is stated and long.
    let seenTtl: number | undefined;
    const watching: Store = {
      apply: <S, R>(_key: string, apply: Transform<S, R>): Promise<R> => {
        const outcome = apply(undefined);
        seenTtl = outcome.ttlMs;
        return Promise.resolve(outcome.result);
      },
      reset: () => Promise.resolve(),
    };
    await new StopSwitch(watching).engage("m1", "recovery", 1000, "why", "who");
    expect(seenTtl).toBe(365 * 86_400_000);
  });

  it("keys by merchant and campaign", () => {
    expect(stopSwitchKey("m1", "recovery")).toBe("kairos:stop:m1:recovery");
    expect(stopSwitchKey("m1", "recovery")).not.toBe(stopSwitchKey("m1", "steering"));
  });

  it("does not write when it is only reading", async () => {
    const writes: string[] = [];
    const watching: Store = {
      apply: <S, R>(key: string, apply: Transform<S, R>): Promise<R> => {
        const outcome = apply(undefined);
        if (outcome.persist) writes.push(key);
        return Promise.resolve(outcome.result);
      },
      reset: () => Promise.resolve(),
    };
    const switched = new StopSwitch(watching);
    await switched.read("m1", "recovery");
    await switched.engaged(mandateFor("m1", "recovery"));
    expect(writes).toEqual([]);
  });
});
