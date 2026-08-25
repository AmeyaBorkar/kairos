import {
  type CustomerRef,
  customerRef,
  incidentId,
  type PaymentMethod,
  slice,
} from "@kairos/domain";
import { describe, expect, it } from "vitest";
import { DEFAULT_STEERING_CONFIG } from "./config.js";
import { RailHealth } from "./health.js";
import { isHeldOut } from "./holdout.js";
import { isNeutral, neutralPlan, planFingerprint, planFor, type SteerDirective } from "./plan.js";
import { healthyRails, NOW } from "./testing.js";

const DEFAULT_SEQUENCE: readonly PaymentMethod[] = [
  "upi",
  "card",
  "netbanking",
  "wallet",
  "paylater",
  "emi",
];

const config = DEFAULT_STEERING_CONFIG;
const customer = (i: number): CustomerRef => customerRef(`cus_${i.toString().padStart(12, "0")}`);

const UPI_INCIDENT = incidentId("inc_upi_hdfc");
const NB_INCIDENT = incidentId("inc_nb_hdfc");

const demoteUpi: SteerDirective = {
  incident: UPI_INCIDENT,
  slice: slice("upi", "hdfc"),
  lever: "demote",
  reason: "demote upi/hdfc",
  expiresAt: NOW + 600_000,
};

const suppressNetbanking: SteerDirective = {
  incident: NB_INCIDENT,
  slice: slice("netbanking", "hdfc"),
  lever: "suppress",
  reason: "suppress netbanking/hdfc",
  expiresAt: NOW + 600_000,
};

/** A customer known to be treated for a given incident, to keep the tests deterministic. */
function treatedCustomer(incident: typeof UPI_INCIDENT): CustomerRef {
  for (let i = 0; i < 1000; i++) {
    const c = customer(i);
    if (!isHeldOut(c, incident, config.holdoutFraction)) return c;
  }
  throw new Error("no treated customer found");
}

/** A customer treated for both incidents, so a floor test is not confounded by the holdout. */
function treatedForBoth(a: typeof UPI_INCIDENT, b: typeof UPI_INCIDENT): CustomerRef {
  for (let i = 0; i < 1000; i++) {
    const c = customer(i);
    const treated =
      !isHeldOut(c, a, config.holdoutFraction) && !isHeldOut(c, b, config.holdoutFraction);
    if (treated) return c;
  }
  throw new Error("no customer treated for both");
}

function heldOutCustomer(incident: typeof UPI_INCIDENT): CustomerRef {
  for (let i = 0; i < 1000; i++) {
    const c = customer(i);
    if (isHeldOut(c, incident, config.holdoutFraction)) return c;
  }
  throw new Error("no held-out customer found");
}

describe("neutralPlan", () => {
  it("changes nothing", () => {
    const plan = neutralPlan(customer(1), DEFAULT_SEQUENCE, NOW);
    expect(isNeutral(plan)).toBe(true);
    expect(plan.sequence).toEqual(DEFAULT_SEQUENCE);
    expect(plan.applied).toEqual([]);
  });
});

describe("planFor", () => {
  const health = healthyRails();

  it("applies a demotion by pushing the method to the back", () => {
    const c = treatedCustomer(UPI_INCIDENT);
    const plan = planFor(c, [demoteUpi], health, config, DEFAULT_SEQUENCE, NOW);

    expect(plan.demote).toEqual(["upi"]);
    expect(plan.sequence).toEqual(["card", "netbanking", "wallet", "paylater", "emi", "upi"]);
    expect(plan.applied).toEqual([UPI_INCIDENT]);
  });

  it("leaves the merchant's ordering alone everywhere else", () => {
    // Re-sorting the whole checkout by current health would look cleverer and would override
    // ordering the merchant may have set for reasons Kairos cannot see — settlement terms, an
    // issuer relationship, a co-branded card.
    const c = treatedCustomer(UPI_INCIDENT);
    const plan = planFor(c, [demoteUpi], health, config, DEFAULT_SEQUENCE, NOW);
    const survivors = plan.sequence.filter((m) => m !== "upi");
    expect(survivors).toEqual(DEFAULT_SEQUENCE.filter((m) => m !== "upi"));
  });

  it("applies a suppression without touching the sequence", () => {
    const c = treatedCustomer(NB_INCIDENT);
    const plan = planFor(c, [suppressNetbanking], health, config, DEFAULT_SEQUENCE, NOW);

    expect(plan.suppress.map((s) => s.issuer)).toEqual(["hdfc"]);
    expect(plan.sequence).toEqual(DEFAULT_SEQUENCE);
  });

  it("changes nothing for a customer in the control group", () => {
    const c = heldOutCustomer(UPI_INCIDENT);
    const plan = planFor(c, [demoteUpi], health, config, DEFAULT_SEQUENCE, NOW);

    expect(isNeutral(plan)).toBe(true);
    expect(plan.heldOutOf).toEqual([UPI_INCIDENT]);
    expect(plan.applied).toEqual([]);
  });

  it("records the arm on the plan, before any outcome exists", () => {
    // The ordering is the whole point. An arm derived after the fact is not a control group, it is
    // a story about one.
    const c = heldOutCustomer(UPI_INCIDENT);
    const plan = planFor(c, [demoteUpi], health, config, DEFAULT_SEQUENCE, NOW);
    expect([...plan.applied, ...plan.heldOutOf]).toContain(UPI_INCIDENT);
  });

  it("can treat a customer for one incident while holding them out of another", () => {
    // Arms are per incident, so each incident gets a clean comparison rather than one global cohort.
    const c = customer(7);
    const plan = planFor(c, [demoteUpi, suppressNetbanking], health, config, DEFAULT_SEQUENCE, NOW);
    expect(plan.applied.length + plan.heldOutOf.length).toBe(2);
  });

  it("ignores a directive whose authority has lapsed", () => {
    // A steer that is not re-affirmed simply stops. This is the auto-revert, and it needs no timer.
    const c = treatedCustomer(UPI_INCIDENT);
    const expired = { ...demoteUpi, expiresAt: NOW - 1 };
    const plan = planFor(c, [expired], health, config, DEFAULT_SEQUENCE, NOW);
    expect(isNeutral(plan)).toBe(true);
  });

  it("demotes a method only once when two of its slices are steered", () => {
    const c = treatedCustomer(UPI_INCIDENT);
    const second: SteerDirective = {
      ...demoteUpi,
      incident: incidentId("inc_upi_sbi"),
      slice: slice("upi", "sbi"),
    };
    const plan = planFor(c, [demoteUpi, second], health, config, DEFAULT_SEQUENCE, NOW);
    expect(plan.demote).toEqual(["upi"]);
  });

  it("drops suppressions rather than leave a customer below the method floor", () => {
    // Defence in depth. Each of these steers is individually safe; together they empty the
    // checkout, and this is the only place that can be seen.
    const health2 = new RailHealth([
      { slice: slice("wallet", "paytm"), share: 30, failureRate: 0.5 },
      { slice: slice("card", "hdfc", "visa"), share: 40, failureRate: 0.5 },
      { slice: slice("netbanking", "hdfc"), share: 30, failureRate: 0.5 },
    ]);
    const directives: SteerDirective[] = [
      { ...suppressNetbanking, incident: incidentId("i1"), slice: slice("wallet", "paytm") },
      { ...suppressNetbanking, incident: incidentId("i2"), slice: slice("card", "hdfc", "visa") },
      { ...suppressNetbanking, incident: incidentId("i3"), slice: slice("netbanking", "hdfc") },
    ];

    const c = customer(3);
    const plan = planFor(c, directives, health2, config, DEFAULT_SEQUENCE, NOW);
    const applied = plan.suppress.length;
    expect(applied).toBeLessThan(3);
    expect(3 - applied).toBeGreaterThanOrEqual(1);
  });

  it("keeps the oldest steer when the floor forces a choice", () => {
    // Three methods against a floor of two: exactly one suppression fits, and the one that has
    // been in force longest is the one that survives. Reversing that would let a fresh alarm
    // displace a steer that has been working, which is how a checkout starts flapping.
    const health2 = new RailHealth([
      { slice: slice("wallet", "paytm"), share: 30, failureRate: 0.5 },
      { slice: slice("card", "hdfc", "visa"), share: 40, failureRate: 0.5 },
      { slice: slice("netbanking", "hdfc"), share: 30, failureRate: 0.5 },
    ]);
    const first = incidentId("i1");
    const second = incidentId("i2");
    const directives: SteerDirective[] = [
      { ...suppressNetbanking, incident: first, slice: slice("wallet", "paytm") },
      { ...suppressNetbanking, incident: second, slice: slice("card", "hdfc", "visa") },
    ];

    const c = treatedForBoth(first, second);
    const plan = planFor(c, directives, health2, config, DEFAULT_SEQUENCE, NOW);
    expect(plan.suppress.map((s) => s.method)).toEqual(["wallet"]);
  });

  it("refuses every suppression when there are only as many methods as the floor", () => {
    // Two methods, floor of two. Nothing can be removed at all, and the correct answer is to leave
    // the checkout alone rather than to remove "just one".
    const health2 = new RailHealth([
      { slice: slice("wallet", "paytm"), share: 50, failureRate: 0.5 },
      { slice: slice("card", "hdfc", "visa"), share: 50, failureRate: 0.5 },
    ]);
    const first = incidentId("i1");
    const directives: SteerDirective[] = [
      { ...suppressNetbanking, incident: first, slice: slice("wallet", "paytm") },
    ];
    const plan = planFor(
      treatedCustomer(first),
      directives,
      health2,
      config,
      DEFAULT_SEQUENCE,
      NOW,
    );
    expect(plan.suppress).toEqual([]);
  });

  it("is deterministic for the same customer", () => {
    const c = customer(11);
    const a = planFor(c, [demoteUpi, suppressNetbanking], health, config, DEFAULT_SEQUENCE, NOW);
    const b = planFor(c, [demoteUpi, suppressNetbanking], health, config, DEFAULT_SEQUENCE, NOW);
    expect(planFingerprint(a)).toBe(planFingerprint(b));
  });
});

describe("planFingerprint", () => {
  it("differs between a treated and a control plan", () => {
    const health = healthyRails();
    const treated = planFor(
      treatedCustomer(UPI_INCIDENT),
      [demoteUpi],
      health,
      config,
      DEFAULT_SEQUENCE,
      NOW,
    );
    const control = planFor(
      heldOutCustomer(UPI_INCIDENT),
      [demoteUpi],
      health,
      config,
      DEFAULT_SEQUENCE,
      NOW,
    );
    expect(planFingerprint(treated)).not.toBe(planFingerprint(control));
  });

  it("ignores the order directives arrived in", () => {
    const c = customer(5);
    const health = healthyRails();
    const a = planFor(c, [demoteUpi, suppressNetbanking], health, config, DEFAULT_SEQUENCE, NOW);
    const b = planFor(c, [suppressNetbanking, demoteUpi], health, config, DEFAULT_SEQUENCE, NOW);
    expect(planFingerprint(a)).toBe(planFingerprint(b));
  });
});
