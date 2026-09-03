import { describe, expect, it } from "vitest";
import { type Clock, ManualClock, scaledClock, systemClock } from "./ports.js";

const EPOCH = 1_700_000_000_000;

describe("scaledClock", () => {
  it("is the clock it was given when the speed is one", () => {
    const base = new ManualClock(EPOCH);
    // Identity, not a wrapper that multiplies by one. A caller passing 1 should pay nothing and
    // should be able to compare the result by reference.
    expect(scaledClock(1, base)).toBe(base);
  });

  it("defaults to the system clock", () => {
    expect(scaledClock(1)).toBe(systemClock);
  });

  it("starts at the same instant whatever the speed", () => {
    const base = new ManualClock(EPOCH);
    expect(scaledClock(60, base).now()).toBe(EPOCH);
  });

  it("advances by the multiple", () => {
    const base = new ManualClock(EPOCH);
    const fast = scaledClock(60, base);
    base.advance(1000);
    expect(fast.now()).toBe(EPOCH + 60_000);
    base.advance(500);
    expect(fast.now()).toBe(EPOCH + 90_000);
  });

  it("is monotonic, which every window it feeds assumes", () => {
    const base = new ManualClock(EPOCH);
    const fast = scaledClock(37, base);
    let previous = fast.now();
    for (let i = 0; i < 200; i++) {
      base.advance(13);
      const now = fast.now();
      expect(now).toBeGreaterThanOrEqual(previous);
      previous = now;
    }
  });

  it("keeps every derived window in one frame", () => {
    // The reason this is a combinator and not something a caller assembles. A reservation TTL and
    // a contact window scaled separately could drift apart; scaled through one clock they cannot.
    const base = new ManualClock(EPOCH);
    const fast = scaledClock(60, base);
    const ttlExpiresAt = fast.now() + 120_000;
    const contactWindowEndsAt = fast.now() + 7 * 86_400_000;

    base.advance(2000);
    expect(fast.now()).toBeGreaterThanOrEqual(ttlExpiresAt);
    expect(fast.now()).toBeLessThan(contactWindowEndsAt);

    base.advance(7 * 86_400_000);
    expect(fast.now()).toBeGreaterThan(contactWindowEndsAt);
  });

  it("does not read the base clock until asked", () => {
    let reads = 0;
    const counting: Clock = {
      now: () => {
        reads++;
        return EPOCH;
      },
    };
    scaledClock(60, counting);
    // One, to fix the origin. A clock that polled on construction and then again per call would
    // silently double every caller's clock cost.
    expect(reads).toBe(1);
  });
});
