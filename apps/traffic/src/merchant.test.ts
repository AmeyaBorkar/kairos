import { describe, expect, it } from "vitest";
import { armFor, configFor, DEFAULT_MERCHANT, degradationFor, Merchant } from "./merchant.js";

const BOOT = 1_800_000_000_000;
const options = { ...DEFAULT_MERCHANT, bootAt: BOOT };

describe("pacing", () => {
  it("delivers nothing before any time has passed", () => {
    const batch = new Merchant(options).drain(BOOT);
    expect(batch.outcomes).toHaveLength(0);
    expect(batch.simulatedTo).toBe(BOOT);
  });

  it("advances simulated time by the speed multiple", () => {
    const batch = new Merchant(options).drain(BOOT + 1000);
    expect(batch.simulatedTo).toBe(BOOT + 1000 * options.speed);
  });

  it("delivers roughly the configured rate once time has passed", () => {
    // One simulated minute of a 900/minute stream. Poisson arrivals, so this is a band and not a
    // number: a test that demanded exactly 900 would be testing the RNG rather than the pacer.
    const batch = new Merchant(options).drain(BOOT + 60_000 / options.speed);
    expect(batch.outcomes.length).toBeGreaterThan(700);
    expect(batch.outcomes.length).toBeLessThan(1100);
  });

  it("never delivers the same attempt twice", () => {
    const merchant = new Merchant(options);
    const seen = new Set<string>();
    for (let i = 1; i <= 12; i++) {
      for (const row of merchant.drain(BOOT + i * 200).outcomes) {
        expect(seen.has(row.id)).toBe(false);
        seen.add(row.id);
      }
    }
    expect(seen.size).toBeGreaterThan(0);
  });

  it("never delivers an attempt from the future", () => {
    const merchant = new Merchant(options);
    for (let i = 1; i <= 12; i++) {
      const batch = merchant.drain(BOOT + i * 200);
      for (const row of batch.outcomes) expect(row.at).toBeLessThanOrEqual(batch.simulatedTo);
    }
  });

  it("holds the attempt it looked at rather than dropping it", () => {
    // The one-attempt lookahead is the only piece of state here, and losing it would silently thin
    // the stream by one attempt per pass — invisible in a total, fatal to a rate.
    const paced = new Merchant(options);
    let pacedCount = 0;
    for (let i = 1; i <= 20; i++) pacedCount += paced.drain(BOOT + i * 100).outcomes.length;

    const inOneGo = new Merchant(options).drain(BOOT + 2000).outcomes.length;
    expect(pacedCount).toBe(inOneGo);
  });
});

describe("casualties", () => {
  it("opens one for every failure and none for a capture", () => {
    const batch = new Merchant(options).drain(BOOT + 60_000 / options.speed);
    const failed = batch.outcomes.filter((o) => o.status === "failed");
    expect(batch.casualties).toHaveLength(failed.length);
    expect(failed.length).toBeGreaterThan(0);
  });

  it("names a customer to ask a plan for only when something failed", () => {
    const batch = new Merchant(options).drain(BOOT + 60_000 / options.speed);
    expect(batch.askPlanFor).not.toBeNull();
    expect(new Merchant(options).drain(BOOT).askPlanFor).toBeNull();
  });

  it("carries a failure detail, without which the intake opens nothing", () => {
    const batch = new Merchant(options).drain(BOOT + 60_000 / options.speed);
    for (const casualty of batch.casualties) expect(casualty.failure).not.toBeNull();
  });
});

describe("arms", () => {
  it("puts a customer in the same arm every time it is asked", () => {
    const customer = "cust_000000000000000042";
    const first = armFor(customer, 0.1);
    for (let i = 0; i < 50; i++) expect(armFor(customer, 0.1)).toBe(first);
  });

  it("holds out roughly the share it was given", () => {
    let control = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) {
      if (armFor(`cust_0000000000000${String(i).padStart(6, "0")}`, 0.1) === "control") control++;
    }
    expect(control / n).toBeGreaterThan(0.07);
    expect(control / n).toBeLessThan(0.13);
  });

  it("holds nobody out at zero and everybody at one", () => {
    expect(armFor("cust_000000000000000001", 0)).toBe("treated");
    expect(armFor("cust_000000000000000001", 1)).toBe("control");
  });
});

describe("the scheduled incident", () => {
  it("is placed at the stated wall-clock offset, in simulated time", () => {
    const degradation = degradationFor(options);
    expect(degradation.onsetAt).toBe(BOOT + options.degradeAfterMs * options.speed);
  });

  it("recurs, so somebody arriving late still sees one", () => {
    const config = configFor(options);
    expect(config.degradations.length).toBeGreaterThan(100);
    expect(config.startAt).toBe(BOOT);

    const onsets = config.degradations.map((d) => d.onsetAt);
    const gaps = onsets.slice(1).map((at, i) => at - (onsets[i] as number));
    // Every gap identical, and every one a period a viewer would sit through: three simulated
    // hours is three real minutes at the speed the demo runs at.
    expect(new Set(gaps).size).toBe(1);
    expect((gaps[0] as number) / options.speed).toBeLessThanOrEqual(3 * 60_000);
  });

  it("alternates rails, so detection cannot be a hard-coded slice", () => {
    const [first, second] = configFor(options).degradations;
    expect(first?.slice.issuer).toBe("sbi");
    expect(first?.slice.method).toBe("upi");
    expect(second?.slice.method).toBe("card");
  });

  it("never overlaps two incidents", () => {
    // Overlapping degradations on different rails would make the simulated success rate move for
    // two reasons at once, which is the one situation this demonstration must not create.
    const sorted = [...configFor(options).degradations].sort((a, b) => a.onsetAt - b.onsetAt);
    for (const [i, d] of sorted.entries()) {
      const next = sorted[i + 1];
      if (next === undefined) break;
      expect(d.onsetAt + d.rampMs + d.holdMs + d.recoveryMs).toBeLessThanOrEqual(next.onsetAt);
    }
  });

  /*
   * Twenty seconds, against a five-second default, and the number is not padding.
   *
   * This walks 550 drain calls over ten simulated minutes at sixty times speed, which is roughly
   * fifty thousand generated attempts. Uninstrumented that is well under a second; under v8
   * coverage it is four to six, because the hot loop is exactly the kind of code instrumentation
   * is most expensive on. It was measured at 6.1s on this machine — already over the limit — and
   * the only reason it had not gone red before is that `pnpm check` runs vitest without coverage
   * and CI runs it with. So this was failing for anybody who ran the coverage script, and CI was
   * one slow runner away from finding out.
   *
   * The timeout is raised rather than the work reduced. The volume is what makes the assertion
   * mean anything: a shorter window would not separate a rail at 46% from one at 11%, which is
   * the whole point of the test.
   */
  it("actually degrades that slice and leaves the others alone", () => {
    // Only the plateau counts. Averaging across the whole run instead would mix forty-five healthy
    // simulated minutes into ten sick ones and report a rail at 11% that is really at 46% — which
    // is exactly the mistake a per-slice detector exists to stop somebody making.
    const onset = degradationFor(options);
    const plateauFrom = onset.onsetAt + onset.rampMs;
    const merchant = new Merchant(options);
    const until = BOOT + options.degradeAfterMs + (10 * 60_000) / options.speed;

    const sbiPhonePe = { failed: 0, total: 0 };
    const others = { failed: 0, total: 0 };
    for (let t = BOOT + 100; t <= until; t += 100) {
      for (const row of merchant.drain(t).outcomes) {
        if (row.at < plateauFrom) continue;
        const bucket =
          row.issuer === "sbi" && row.instrument === "phonepe" && row.method === "upi"
            ? sbiPhonePe
            : others;
        bucket.total++;
        if (row.status === "failed") bucket.failed++;
      }
    }
    expect(sbiPhonePe.total).toBeGreaterThan(50);
    expect(others.total).toBeGreaterThan(500);
    expect(sbiPhonePe.failed / sbiPhonePe.total).toBeGreaterThan(0.3);
    expect(others.failed / others.total).toBeLessThan(0.12);
  }, 20_000);
});
