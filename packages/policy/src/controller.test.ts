import {
  customerRef,
  type Incident,
  mandateId,
  type PaymentMethod,
  paise,
  slice,
} from "@kairos/domain";
import { MemoryLedger } from "@kairos/ledger";
import { ManualClock, sealMandate, Terminus, type UnsignedMandate } from "@kairos/terminus";
import { MemoryStore } from "throttlekit";
import { describe, expect, it } from "vitest";
import { DEFAULT_STEERING_CONFIG, type SteeringConfig } from "./config.js";
import { SteeringController } from "./controller.js";
import type { RailHealth } from "./health.js";
import { isNeutral } from "./plan.js";
import { healthWith, incidentOn, NOW } from "./testing.js";

const SECRET = "vault-key";
const DAY = 86_400_000;
const SEQUENCE: readonly PaymentMethod[] = ["upi", "card", "netbanking", "wallet"];

/**
 * The mandate a steering controller runs under.
 *
 * Two fields carry the architecture's steering bounds directly: `maxInFlight` is the blast radius
 * and `reservationTtlMs` is the maximum steer duration. Neither needs a mechanism of its own —
 * they are the kernel's concurrency cap and reservation TTL, doing what they already do.
 */
function steerMandate(config: SteeringConfig, overrides: Partial<UnsignedMandate> = {}) {
  return sealMandate(
    {
      id: mandateId("mnd_steer"),
      merchantId: "acme",
      campaignId: "steering",
      budgetPaise: paise(1000),
      maxActionCostPaise: paise(1),
      maxInFlight: config.maxConcurrentSteers,
      reservationTtlMs: config.maxIncidentDurationMs,
      contactCap: { limit: 99, windowMs: DAY },
      quietHours: null,
      allowedActions: ["steer"],
      validFrom: NOW - DAY,
      validUntil: NOW + 30 * DAY,
      killSwitch: false,
      ...overrides,
    },
    SECRET,
  );
}

interface Harness {
  readonly controller: SteeringController;
  readonly terminus: Terminus;
  readonly ledger: MemoryLedger;
  readonly clock: ManualClock;
}

function harness(
  overrides: Partial<SteeringConfig> = {},
  mandateOverrides: Partial<UnsignedMandate> = {},
): Harness {
  const config = { ...DEFAULT_STEERING_CONFIG, ...overrides };
  const clock = new ManualClock(NOW);
  const ledger = new MemoryLedger();
  const terminus = new Terminus({
    mandate: steerMandate(config, mandateOverrides),
    secret: SECRET,
    store: new MemoryStore({ sweepIntervalMs: 0 }),
    audit: ledger,
    actor: "sentry/1",
    clock,
  });
  const controller = new SteeringController({
    terminus,
    config,
    clock,
    defaultSequence: SEQUENCE,
  });
  return { controller, terminus, ledger, clock };
}

/** Drive the controller until it either steers or gives up. */
async function affirmUntilSteering(
  h: Harness,
  incidents: readonly Incident[],
  health: RailHealth,
  rounds = 5,
) {
  let last = await h.controller.affirm(incidents, health);
  for (let i = 1; i < rounds && h.controller.directives().length === 0; i++) {
    last = await h.controller.affirm(incidents, health);
  }
  return last;
}

const NETBANKING = slice("netbanking", "hdfc");
const brokenNetbanking = () => healthWith(NETBANKING, 0.5);

describe("corroboration", () => {
  it("does not steer on a single observation", async () => {
    // "Never steer on a single alarm" is a bound, and the cheapest way to honour it is to make the
    // first affirmation buy nothing.
    const h = harness();
    const outcomes = await h.controller.affirm([incidentOn(NETBANKING, 0.5)], brokenNetbanking());

    expect(outcomes[0]?.status).toBe("awaiting-corroboration");
    expect(h.controller.directives()).toEqual([]);
  });

  it("steers once the evidence has been seen twice", async () => {
    const h = harness();
    const incidents = [incidentOn(NETBANKING, 0.5)];
    await h.controller.affirm(incidents, brokenNetbanking());
    const outcomes = await h.controller.affirm(incidents, brokenNetbanking());

    expect(outcomes[0]?.status).toBe("steering");
    expect(h.controller.directives()).toHaveLength(1);
    expect(h.controller.directives()[0]?.lever).toBe("suppress");
  });

  it("restarts corroboration when the evidence stops supporting a steer", async () => {
    const h = harness();
    const incident = incidentOn(NETBANKING, 0.5);
    await h.controller.affirm([incident], brokenNetbanking());
    // One healthy round wipes the count, so a flapping rail cannot accumulate its way to a steer.
    await h.controller.affirm([incident], healthWith(NETBANKING, 0.05));
    const outcomes = await h.controller.affirm([incident], brokenNetbanking());

    expect(outcomes[0]?.status).toBe("awaiting-corroboration");
  });
});

describe("the steer as a held reservation", () => {
  it("expires on its own if nothing re-affirms it", async () => {
    // The auto-revert, with no timer anywhere: the grant's TTL is the maximum steer duration, so a
    // sentry that dies mid-incident leaves a checkout that returns to normal by itself.
    const h = harness();
    const incidents = [incidentOn(NETBANKING, 0.5)];
    await affirmUntilSteering(h, incidents, brokenNetbanking());
    expect(h.controller.directives()).toHaveLength(1);

    h.clock.advance(DEFAULT_STEERING_CONFIG.maxIncidentDurationMs + 1);
    const plan = h.controller.planFor(customerRef("cus_000000000000"), brokenNetbanking());
    expect(isNeutral(plan)).toBe(true);
  });

  it("renews on continuing evidence before the authority lapses", async () => {
    const h = harness();
    const incidents = [incidentOn(NETBANKING, 0.5)];
    await affirmUntilSteering(h, incidents, brokenNetbanking());
    const first = h.controller.directives()[0]?.expiresAt ?? 0;

    h.clock.advance(DEFAULT_STEERING_CONFIG.maxIncidentDurationMs * 0.8);
    const outcomes = await h.controller.affirm(incidents, brokenNetbanking());

    expect(outcomes[0]?.status).toBe("renewed");
    expect(h.controller.directives()[0]?.expiresAt ?? 0).toBeGreaterThan(first);
  });

  it("does not spend a second concurrency slot to renew", async () => {
    // The old grant is handed back before the new one is asked for. Doing it the other way round
    // would make a renewal cost two of the slots it is bounded by, and a fleet at its cap would
    // never be able to renew anything.
    const h = harness({ maxConcurrentSteers: 1 });
    const incidents = [incidentOn(NETBANKING, 0.5)];
    await affirmUntilSteering(h, incidents, brokenNetbanking());

    h.clock.advance(DEFAULT_STEERING_CONFIG.maxIncidentDurationMs * 0.8);
    const outcomes = await h.controller.affirm(incidents, brokenNetbanking());
    expect(outcomes[0]?.status).toBe("renewed");
  });

  it("gives the authority back rather than booking a spend", async () => {
    // A steer moves no money, so it is abandoned rather than settled. Settling zero would record an
    // expense that did not happen, and over a long day it would drain a budget nothing was buying.
    const h = harness();
    const incidents = [incidentOn(NETBANKING, 0.5)];
    await affirmUntilSteering(h, incidents, brokenNetbanking());
    await h.controller.revokeAll("test");

    const snapshot = await h.terminus.snapshot();
    expect(snapshot.settledCount).toBe(0);
    expect(snapshot.settledPaise).toBe(0);
    expect(snapshot.availablePaise).toBe(1000);
  });
});

describe("revocation", () => {
  it("stops steering when the incident resolves", async () => {
    const h = harness();
    const open = incidentOn(NETBANKING, 0.5);
    await affirmUntilSteering(h, [open], brokenNetbanking());

    const outcomes = await h.controller.affirm([], brokenNetbanking());
    expect(outcomes[0]?.status).toBe("revoked");
    expect(h.controller.directives()).toEqual([]);
  });

  it("stops steering when the rail recovers, without waiting for the TTL", async () => {
    // Steering a rail that has healed is a self-inflicted outage. The TTL is a backstop for the
    // case where nobody is left to notice, not the normal path.
    const h = harness();
    const incident = incidentOn(NETBANKING, 0.5);
    await affirmUntilSteering(h, [incident], brokenNetbanking());

    const outcomes = await h.controller.affirm([incident], healthWith(NETBANKING, 0.05));
    expect(outcomes[0]?.status).toBe("revoked");
    expect(h.controller.directives()).toEqual([]);
  });
});

describe("bounds the kernel enforces", () => {
  it("caps how many incidents may be steered at once", async () => {
    // Blast radius is the kernel's in-flight cap, so two sentry instances share it rather than each
    // keeping their own counter.
    const h = harness({ maxConcurrentSteers: 2 });
    const incidents = [
      incidentOn(slice("netbanking", "hdfc"), 0.5),
      incidentOn(slice("netbanking", "sbi"), 0.5),
      incidentOn(slice("netbanking", "icici"), 0.5),
    ];
    const health = healthWith(slice("netbanking"), 0.5);

    await h.controller.affirm(incidents, health);
    const outcomes = await h.controller.affirm(incidents, health);

    expect(h.controller.directives().length).toBe(2);
    expect(outcomes.filter((o) => o.status === "refused")).toHaveLength(1);
    expect(outcomes.find((o) => o.status === "refused")?.detail).toContain("concurrency");
  });

  it("refuses every steer when the kill switch is engaged", async () => {
    const h = harness({}, { killSwitch: true });
    const incidents = [incidentOn(NETBANKING, 0.5)];
    const outcomes = await affirmUntilSteering(h, incidents, brokenNetbanking());

    expect(h.controller.directives()).toEqual([]);
    expect(outcomes[0]?.detail).toContain("kill-switch");
  });

  it("refuses a steer once the mandate has expired", async () => {
    const h = harness();
    h.clock.set(NOW + 40 * DAY);
    const incidents = [incidentOn(NETBANKING, 0.5)];
    const outcomes = await affirmUntilSteering(h, incidents, brokenNetbanking());

    expect(h.controller.directives()).toEqual([]);
    expect(outcomes[0]?.detail).toContain("mandate-validity");
  });

  it("writes every decision to the ledger, refusals included", async () => {
    const h = harness({}, { killSwitch: true });
    await affirmUntilSteering(h, [incidentOn(NETBANKING, 0.5)], brokenNetbanking());

    expect(h.ledger.length).toBeGreaterThan(0);
    expect(h.ledger.countByBinding()["kill-switch"]).toBeGreaterThan(0);
    expect(h.ledger.verify()).toMatchObject({ valid: true });
  });
});

describe("declining to steer", () => {
  it("never asks the kernel for authority it has already decided against", async () => {
    // A moderate UPI issuer outage: the destination rails are worse than the failing one, so the
    // correct answer is to do nothing. The kernel is not consulted at all, because refusing on
    // grounds of blast radius would imply the steer was otherwise a good idea.
    const h = harness();
    const failing = slice("upi", "hdfc");
    const outcomes = await affirmUntilSteering(
      h,
      [incidentOn(failing, 0.12)],
      healthWith(failing, 0.12),
    );

    expect(outcomes[0]?.status).toBe("declined");
    expect(h.ledger.length).toBe(0);
    expect(h.controller.directives()).toEqual([]);
  });

  it("steers the same slice once it gets bad enough", async () => {
    const h = harness();
    const failing = slice("upi", "hdfc");
    await affirmUntilSteering(h, [incidentOn(failing, 0.55)], healthWith(failing, 0.55));

    expect(h.controller.directives()).toHaveLength(1);
    expect(h.controller.directives()[0]?.lever).toBe("demote");
  });
});
