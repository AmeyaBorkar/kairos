import {
  type CasualtyStatus,
  casualtyId,
  customerRef,
  incidentId,
  mandateId,
  type Paise,
  type ProposedAction,
  paise,
  rupees,
} from "@kairos/domain";
import { FailingLedger, MemoryLedger } from "@kairos/ledger";
import { MemoryStore } from "throttlekit";
import { beforeEach, describe, expect, it } from "vitest";
import type { ContactLedger } from "./caps.js";
import { SettlementUnrecordedError, Terminus, type TerminusOptions } from "./kernel.js";
import { ManualClock } from "./ports.js";
import { estimateSizer, worstCaseSizer } from "./reservation.js";
import { sealMandate, type UnsignedMandate } from "./signature.js";
import { CLEAN_STATUS } from "./stops.js";

const SECRET = "vault-key";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** 2026-08-25T12:00:00Z — 17:30 IST, comfortably outside any night-time quiet window. */
const NOON = Date.UTC(2026, 7, 25, 12, 0, 0);

const CUSTOMER = customerRef("cus_9f3b2a71c4e8d012");
const CASUALTY = casualtyId("cas_001");

function unsigned(overrides: Partial<UnsignedMandate> = {}): UnsignedMandate {
  return {
    id: mandateId("mnd_aug"),
    merchantId: "acme",
    campaignId: "aug-recovery",
    budgetPaise: rupees(1000),
    maxActionCostPaise: rupees(3),
    maxInFlight: 4,
    reservationTtlMs: 30_000,
    contactCap: { limit: 3, windowMs: 7 * DAY },
    quietHours: { startMinute: 21 * 60, endMinute: 8 * 60, offsetMinutes: 330 },
    allowedActions: ["contact-sms", "retry"],
    validFrom: NOON - DAY,
    validUntil: NOON + 30 * DAY,
    killSwitch: false,
    ...overrides,
  };
}

function action(overrides: Partial<ProposedAction> = {}): ProposedAction {
  return {
    kind: "contact-sms",
    customer: CUSTOMER,
    casualty: CASUALTY,
    incident: null,
    estimatedCost: rupees(1),
    expectedValue: rupees(2000),
    successProbability: 0.3,
    rationale: "issuer recovered; the customer's card failed on a transient decline",
    ...overrides,
  };
}

interface Harness {
  readonly terminus: Terminus;
  readonly ledger: MemoryLedger;
  readonly clock: ManualClock;
  readonly store: MemoryStore;
}

function harness(
  overrides: Partial<TerminusOptions> = {},
  mandateOverrides: Partial<UnsignedMandate> = {},
): Harness {
  const clock = new ManualClock(NOON);
  const ledger = new MemoryLedger();
  const store = new MemoryStore({ sweepIntervalMs: 0 });
  const mandate = sealMandate(unsigned(mandateOverrides), SECRET);
  const terminus = new Terminus({
    mandate,
    secret: SECRET,
    store,
    audit: ledger,
    actor: "recover-worker/1",
    clock,
    sizer: worstCaseSizer(mandate.maxActionCostPaise),
    ...overrides,
  });
  return { terminus, ledger, clock, store };
}

/** Admit, then reconcile at a given cost, in one step. */
async function spend(
  h: Harness,
  attemptNo: number,
  actualPaise: Paise,
  act = action(),
): Promise<boolean> {
  const admission = await h.terminus.admit({ action: act, status: CLEAN_STATUS, attemptNo });
  if (!admission.allowed) return false;
  await h.terminus.settle(admission.grant, actualPaise, "delivered");
  return true;
}

describe("admission — the absolute refusals", () => {
  it("admits a well-formed request", async () => {
    const h = harness();
    const admission = await h.terminus.admit({
      action: action(),
      status: CLEAN_STATUS,
      attemptNo: 1,
    });
    expect(admission.allowed).toBe(true);
  });

  it("refuses a mandate whose signature does not verify", async () => {
    const clock = new ManualClock(NOON);
    const sealed = sealMandate(unsigned(), SECRET);
    const terminus = new Terminus({
      // A budget raised after signing: the exact attack the signature exists to stop.
      mandate: { ...sealed, budgetPaise: rupees(10_000_000) },
      secret: SECRET,
      store: new MemoryStore({ sweepIntervalMs: 0 }),
      audit: new MemoryLedger(),
      actor: "recover-worker/1",
      clock,
    });

    const admission = await terminus.admit({
      action: action(),
      status: CLEAN_STATUS,
      attemptNo: 1,
    });
    expect(admission.allowed).toBe(false);
    if (admission.allowed) return;
    expect(admission.axis).toBe("mandate-signature");
  });

  it("refuses when the mandate's own kill switch is set", async () => {
    const h = harness({}, { killSwitch: true });
    const admission = await h.terminus.admit({
      action: action(),
      status: CLEAN_STATUS,
      attemptNo: 1,
    });
    expect(admission.allowed).toBe(false);
    if (admission.allowed) return;
    expect(admission.axis).toBe("kill-switch");
  });

  it("refuses when the operator's out-of-band switch is engaged", async () => {
    const h = harness({ killSwitch: { engaged: async () => true } });
    const admission = await h.terminus.admit({
      action: action(),
      status: CLEAN_STATUS,
      attemptNo: 1,
    });
    expect(admission.allowed).toBe(false);
    if (admission.allowed) return;
    expect(admission.axis).toBe("kill-switch");
  });

  it("treats a kill switch it cannot read as engaged", async () => {
    // P2 applied to the stop itself: not knowing whether we have been told to stop *is* being told
    // to stop. The alternative — carry on when the switch is unreachable — makes the switch useless
    // in precisely the incident where someone reaches for it.
    const h = harness({
      killSwitch: {
        engaged: () => Promise.reject(new Error("store unreachable")),
      },
    });
    const admission = await h.terminus.admit({
      action: action(),
      status: CLEAN_STATUS,
      attemptNo: 1,
    });
    expect(admission.allowed).toBe(false);
    if (admission.allowed) return;
    expect(admission.axis).toBe("kill-switch");
  });

  it("refuses an expired mandate, with no retry time, because it will never come back", async () => {
    const h = harness();
    h.clock.set(NOON + 40 * DAY);
    const admission = await h.terminus.admit({
      action: action(),
      status: CLEAN_STATUS,
      attemptNo: 1,
    });
    expect(admission.allowed).toBe(false);
    if (admission.allowed) return;
    expect(admission.axis).toBe("mandate-validity");
    expect(admission.retryAfterMs).toBeNull();
  });

  it("refuses a mandate that has not started, and says when it will", async () => {
    const h = harness({}, { validFrom: NOON + HOUR, validUntil: NOON + 30 * DAY });
    const admission = await h.terminus.admit({
      action: action(),
      status: CLEAN_STATUS,
      attemptNo: 1,
    });
    expect(admission.allowed).toBe(false);
    if (admission.allowed) return;
    expect(admission.axis).toBe("mandate-validity");
    expect(admission.retryAfterMs).toBe(HOUR);
  });

  it("refuses an action the mandate does not name", async () => {
    const h = harness();
    const admission = await h.terminus.admit({
      action: action({ kind: "contact-whatsapp" }),
      status: CLEAN_STATUS,
      attemptNo: 1,
    });
    expect(admission.allowed).toBe(false);
    if (admission.allowed) return;
    expect(admission.axis).toBe("action-not-allowed");
  });
});

describe("admission — stopping rules", () => {
  const cases: ReadonlyArray<readonly [string, Partial<CasualtyStatus>]> = [
    ["the payment already succeeded", { recovered: true }],
    ["the customer opted out", { optedOut: true }],
    ["a dispute is open", { disputed: true }],
    ["the failure is dead", { recoverability: "dead" }],
    ["hard declines have piled up", { consecutiveHardDeclines: 3 }],
  ];

  it.each(cases)("refuses when %s", async (_label, status) => {
    const h = harness();
    const admission = await h.terminus.admit({
      action: action(),
      status: { ...CLEAN_STATUS, ...status },
      attemptNo: 1,
    });
    expect(admission.allowed).toBe(false);
    if (admission.allowed) return;
    expect(admission.axis).toBe("stop-rule");
  });

  it("records which rule stopped it, not merely that one did", async () => {
    const h = harness();
    await h.terminus.admit({
      action: action(),
      status: { ...CLEAN_STATUS, optedOut: true },
      attemptNo: 1,
    });
    const record = h.ledger.records.at(-1);
    expect(record?.meta["stopReason"]).toBe("opted-out");
    expect(record?.reason).toContain("opted out");
  });

  it("stops even when the expected value is enormous", async () => {
    // The commercial case is never an argument against an opt-out. Ordering the checks so that
    // stopping rules run before the value gate is what makes that structural rather than hoped for.
    const h = harness();
    const admission = await h.terminus.admit({
      action: action({ expectedValue: rupees(500_000), successProbability: 0.99 }),
      status: { ...CLEAN_STATUS, optedOut: true },
      attemptNo: 1,
    });
    expect(admission.allowed).toBe(false);
  });
});

describe("admission — the expected-value gate", () => {
  it("refuses an action whose probable return does not clear its cost", async () => {
    const h = harness();
    const admission = await h.terminus.admit({
      action: action({
        expectedValue: rupees(2),
        successProbability: 0.1,
        estimatedCost: rupees(1),
      }),
      status: CLEAN_STATUS,
      attemptNo: 1,
    });
    expect(admission.allowed).toBe(false);
    if (admission.allowed) return;
    expect(admission.axis).toBe("expected-value");
  });

  it("admits one that clears it", async () => {
    const h = harness();
    const admission = await h.terminus.admit({
      action: action({
        expectedValue: rupees(100),
        successProbability: 0.1,
        estimatedCost: rupees(1),
      }),
      status: CLEAN_STATUS,
      attemptNo: 1,
    });
    expect(admission.allowed).toBe(true);
  });
});

describe("admission — quiet hours", () => {
  /** 02:00 IST, deep inside the 21:00–08:00 window. */
  const NIGHT = Date.UTC(2026, 7, 25, 20, 30, 0);

  it("refuses a contact and says when the window lifts", async () => {
    const h = harness();
    h.clock.set(NIGHT);
    const admission = await h.terminus.admit({
      action: action(),
      status: CLEAN_STATUS,
      attemptNo: 1,
    });
    expect(admission.allowed).toBe(false);
    if (admission.allowed) return;
    expect(admission.axis).toBe("quiet-hours");
    expect(admission.retryAfterMs).toBe(6 * HOUR);
  });

  it("lets a retry through, because a retry does not wake anybody", async () => {
    // Quiet hours protect people from being contacted, not rails from being used. Applying the
    // window to a silent payment retry would cost recovery for no benefit to anyone.
    const h = harness();
    h.clock.set(NIGHT);
    const admission = await h.terminus.admit({
      action: action({ kind: "retry" }),
      status: CLEAN_STATUS,
      attemptNo: 1,
    });
    expect(admission.allowed).toBe(true);
  });

  it("does not burn a contact allowance on a refusal", async () => {
    const h = harness();
    h.clock.set(NIGHT);
    for (let i = 1; i <= 5; i++) {
      await h.terminus.admit({ action: action(), status: CLEAN_STATUS, attemptNo: i });
    }
    h.clock.set(NOON + DAY);

    // All three contacts must still be available: refusals on cheaper axes consume nothing.
    for (let i = 10; i < 13; i++) {
      const admission = await h.terminus.admit({
        action: action(),
        status: CLEAN_STATUS,
        attemptNo: i,
      });
      expect(admission.allowed).toBe(true);
      if (admission.allowed) await h.terminus.settle(admission.grant, rupees(1), "delivered");
    }
  });
});

describe("admission — the consuming axes", () => {
  it("refuses once the contact cap is reached, and names the number", async () => {
    const h = harness();
    for (let i = 1; i <= 3; i++) expect(await spend(h, i, rupees(1))).toBe(true);

    const admission = await h.terminus.admit({
      action: action(),
      status: CLEAN_STATUS,
      attemptNo: 4,
    });
    expect(admission.allowed).toBe(false);
    if (admission.allowed) return;
    expect(admission.axis).toBe("contact-cap");
    expect(admission.reason).toContain("3 contacts in the last 7 days");
  });

  it("takes no budget at all for a customer already at the cap", async () => {
    // The cap is read before any budget is taken. A doomed request that briefly held a reservation
    // would occupy an in-flight slot and refuse a live request on the concurrency axis — a spurious
    // refusal caused entirely by one that was never going to succeed.
    const h = harness();
    for (let i = 1; i <= 3; i++) expect(await spend(h, i, rupees(1))).toBe(true);

    const before = await h.terminus.snapshot();
    await h.terminus.admit({ action: action(), status: CLEAN_STATUS, attemptNo: 4 });
    const after = await h.terminus.snapshot();

    expect(after.committedPaise).toBe(0);
    expect(after.inFlight).toBe(0);
    expect(after.availablePaise).toBe(before.availablePaise);
  });

  it("releases the reservation when another worker takes the last allowance mid-flight", async () => {
    // The saga's compensating step, on the race the advisory read cannot close: the cap looked open
    // when we read it and was full by the time we consumed it. Without the release, every lost race
    // would strand a reservation until its TTL expired.
    const contacts: ContactLedger = {
      peek: async () => ({ allowed: true, limit: 3, remaining: 1, resetAt: 0, retryAfterMs: 0 }),
      consume: async () => ({
        allowed: false,
        limit: 3,
        remaining: 0,
        resetAt: 0,
        retryAfterMs: 5000,
      }),
    };
    const h = harness({ contacts });

    const admission = await h.terminus.admit({
      action: action(),
      status: CLEAN_STATUS,
      attemptNo: 1,
    });
    expect(admission.allowed).toBe(false);
    if (admission.allowed) return;
    expect(admission.axis).toBe("contact-cap");
    expect(admission.retryAfterMs).toBe(5000);

    const snapshot = await h.terminus.snapshot();
    expect(snapshot.inFlight).toBe(0);
    expect(snapshot.availablePaise).toBe(rupees(1000));
  });

  it("refuses when the in-flight cap is full, and clears once one reconciles", async () => {
    const h = harness(
      { sizer: worstCaseSizer(rupees(3)) },
      { maxInFlight: 2, contactCap: { limit: 99, windowMs: DAY } },
    );

    const first = await h.terminus.admit({ action: action(), status: CLEAN_STATUS, attemptNo: 1 });
    const second = await h.terminus.admit({ action: action(), status: CLEAN_STATUS, attemptNo: 2 });
    const third = await h.terminus.admit({ action: action(), status: CLEAN_STATUS, attemptNo: 3 });

    expect(first.allowed && second.allowed).toBe(true);
    expect(third.allowed).toBe(false);
    if (third.allowed) return;
    expect(third.axis).toBe("concurrency");

    if (!first.allowed) return;
    await h.terminus.settle(first.grant, rupees(1), "delivered");
    const fourth = await h.terminus.admit({ action: action(), status: CLEAN_STATUS, attemptNo: 4 });
    expect(fourth.allowed).toBe(true);
  });

  it("refuses when the budget is exhausted", async () => {
    const h = harness({}, { budgetPaise: rupees(6), contactCap: { limit: 99, windowMs: DAY } });
    expect(await spend(h, 1, rupees(3))).toBe(true);
    expect(await spend(h, 2, rupees(3))).toBe(true);

    const admission = await h.terminus.admit({
      action: action(),
      status: CLEAN_STATUS,
      attemptNo: 3,
    });
    expect(admission.allowed).toBe(false);
    if (admission.allowed) return;
    expect(admission.axis).toBe("budget");
    expect(admission.reason).toContain("0 paise still available");
  });
});

describe("concurrency", () => {
  it("holds the budget against a fleet all admitting at once", async () => {
    // The bug this kernel exists to prevent: N workers read the same remaining budget, all decide
    // they can afford it, and all spend. Here the reserve is atomic, so exactly as many are
    // admitted as the budget can pay for — regardless of how many ask.
    const WORKERS = 50;
    const COST = rupees(3);
    const h = harness(
      { sizer: worstCaseSizer(COST) },
      { budgetPaise: rupees(30), maxInFlight: WORKERS, contactCap: { limit: 999, windowMs: DAY } },
    );

    const admissions = await Promise.all(
      Array.from({ length: WORKERS }, (_, i) =>
        h.terminus.admit({ action: action(), status: CLEAN_STATUS, attemptNo: i + 1 }),
      ),
    );

    const allowed = admissions.filter((a) => a.allowed);
    expect(allowed.length).toBe(10);

    await Promise.all(
      allowed.map((a) => (a.allowed ? h.terminus.settle(a.grant, COST, "delivered") : null)),
    );
    const snapshot = await h.terminus.snapshot();
    expect(snapshot.settledPaise).toBe(rupees(30));
    expect(snapshot.settledPaise).toBeLessThanOrEqual(snapshot.budgetPaise);
  });

  it("holds the contact cap against a fleet chasing the same customer", async () => {
    const h = harness({}, { budgetPaise: rupees(10_000) });
    const admissions = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        h.terminus.admit({ action: action(), status: CLEAN_STATUS, attemptNo: i + 1 }),
      ),
    );
    expect(admissions.filter((a) => a.allowed).length).toBe(3);
  });
});

describe("idempotency and crash safety", () => {
  it("returns the same grant for a replayed attempt rather than reserving twice", async () => {
    const h = harness({}, { contactCap: { limit: 99, windowMs: DAY } });
    const first = await h.terminus.admit({
      action: action({ kind: "retry" }),
      status: CLEAN_STATUS,
      attemptNo: 1,
    });
    const replay = await h.terminus.admit({
      action: action({ kind: "retry" }),
      status: CLEAN_STATUS,
      attemptNo: 1,
    });

    expect(first.allowed && replay.allowed).toBe(true);
    if (!first.allowed || !replay.allowed) return;
    expect(replay.grant.id).toBe(first.grant.id);
    expect(replay.grant.replayed).toBe(true);

    const snapshot = await h.terminus.snapshot();
    expect(snapshot.inFlight).toBe(1);
    expect(snapshot.committedPaise).toBe(rupees(3));
  });

  it("treats a deliberate second attempt as a new action", async () => {
    const h = harness({}, { contactCap: { limit: 99, windowMs: DAY } });
    const first = await h.terminus.admit({
      action: action({ kind: "retry" }),
      status: CLEAN_STATUS,
      attemptNo: 1,
    });
    const second = await h.terminus.admit({
      action: action({ kind: "retry" }),
      status: CLEAN_STATUS,
      attemptNo: 2,
    });

    if (!first.allowed || !second.allowed) throw new Error("both should be admitted");
    expect(second.grant.id).not.toBe(first.grant.id);
  });

  it("returns authority when a worker dies mid-action and the reservation lapses", async () => {
    const h = harness({}, { contactCap: { limit: 99, windowMs: DAY } });
    const admission = await h.terminus.admit({
      action: action({ kind: "retry" }),
      status: CLEAN_STATUS,
      attemptNo: 1,
    });
    expect(admission.allowed).toBe(true);

    h.clock.advance(30_001);
    const snapshot = await h.terminus.snapshot();
    expect(snapshot.inFlight).toBe(0);
    expect(snapshot.availablePaise).toBe(rupees(1000));
  });

  it("flags a settlement that arrives after its reservation lapsed", async () => {
    // The hazard a short TTL creates: the money moved while its authority had already been returned
    // to the pool, so that spend was bounded by nothing. It has to be visible in the books.
    const h = harness({}, { contactCap: { limit: 99, windowMs: DAY } });
    const admission = await h.terminus.admit({
      action: action({ kind: "retry" }),
      status: CLEAN_STATUS,
      attemptNo: 1,
    });
    if (!admission.allowed) throw new Error("expected an allow");

    h.clock.advance(30_001);
    const receipt = await h.terminus.settle(admission.grant, rupees(3), "delivered");

    expect(receipt.recognised).toBe(false);
    expect((await h.terminus.snapshot()).orphanCount).toBe(1);
  });
});

describe("settlement", () => {
  it("records the overrun when a message costs more than it was priced at", async () => {
    // One GSM-7 segment estimated, three UCS-2 segments delivered, because the model wrote in
    // Devanagari. The script choice sets the price and is known only after generation.
    const h = harness({ sizer: estimateSizer() });
    const admission = await h.terminus.admit({
      action: action(),
      status: CLEAN_STATUS,
      attemptNo: 1,
    });
    if (!admission.allowed) throw new Error("expected an allow");

    expect(admission.grant.reservedPaise).toBe(rupees(1));
    const receipt = await h.terminus.settle(admission.grant, rupees(3), "delivered");
    expect(receipt.overrunPaise).toBe(rupees(2));
  });

  it("flags an adapter that reports a cost above the mandate's ceiling", async () => {
    const h = harness();
    const admission = await h.terminus.admit({
      action: action(),
      status: CLEAN_STATUS,
      attemptNo: 1,
    });
    if (!admission.allowed) throw new Error("expected an allow");

    const receipt = await h.terminus.settle(admission.grant, rupees(9), "delivered");
    expect(receipt.exceededActionCap).toBe(true);
  });

  it("abandoning returns the authority without recording a spend", async () => {
    const h = harness();
    const admission = await h.terminus.admit({
      action: action(),
      status: CLEAN_STATUS,
      attemptNo: 1,
    });
    if (!admission.allowed) throw new Error("expected an allow");

    await h.terminus.abandon(admission.grant, "the provider rejected the number");
    const snapshot = await h.terminus.snapshot();

    expect(snapshot.settledCount).toBe(0);
    expect(snapshot.settledPaise).toBe(0);
    expect(snapshot.availablePaise).toBe(rupees(1000));
  });
});

describe("the audit trail", () => {
  it("records a decision for every admission, allowed or refused", async () => {
    const h = harness();
    await h.terminus.admit({ action: action(), status: CLEAN_STATUS, attemptNo: 1 });
    await h.terminus.admit({
      action: action({ kind: "escalate" }),
      status: CLEAN_STATUS,
      attemptNo: 2,
    });

    expect(h.ledger.length).toBe(2);
    expect(h.ledger.records[0]?.allowed).toBe(true);
    expect(h.ledger.records[1]?.allowed).toBe(false);
    expect(h.ledger.records[1]?.binding).toBe("action-not-allowed");
  });

  it("names the binding axis on every refusal", async () => {
    const h = harness({}, { budgetPaise: rupees(3), contactCap: { limit: 99, windowMs: DAY } });
    await spend(h, 1, rupees(3));
    await h.terminus.admit({ action: action(), status: CLEAN_STATUS, attemptNo: 2 });
    await h.terminus.admit({
      action: action({ kind: "escalate" }),
      status: CLEAN_STATUS,
      attemptNo: 3,
    });

    expect(h.ledger.countByBinding()).toEqual({ budget: 1, "action-not-allowed": 1 });
  });

  it("keeps raw personal data out of the record", async () => {
    const h = harness();
    await h.terminus.admit({ action: action(), status: CLEAN_STATUS, attemptNo: 1 });
    const record = h.ledger.records[0];
    expect(record?.target).toBe(`casualty:${CASUALTY}`);
    expect(JSON.stringify(record)).not.toContain("+91");
  });

  it("produces a chain that verifies", async () => {
    const h = harness({}, { contactCap: { limit: 99, windowMs: DAY } });
    for (let i = 1; i <= 10; i++) await spend(h, i, rupees(2), action({ kind: "retry" }));
    expect(h.ledger.verify()).toMatchObject({ valid: true, length: 20 });
  });

  it("refuses the action when the decision cannot be recorded", async () => {
    // P8: no unaudited money movement. A ledger that is unavailable is not a logging inconvenience,
    // it is a loss of the only record that would explain the spend afterwards.
    const audit = new FailingLedger();
    const h = harness({ audit });
    const admission = await h.terminus.admit({
      action: action(),
      status: CLEAN_STATUS,
      attemptNo: 1,
    });

    expect(admission.allowed).toBe(false);
    if (admission.allowed) return;
    expect(admission.axis).toBe("audit");
  });

  it("releases the reservation it had taken when the ledger refuses it", async () => {
    const audit = new FailingLedger();
    const h = harness({ audit });
    await h.terminus.admit({ action: action(), status: CLEAN_STATUS, attemptNo: 1 });

    const snapshot = await h.terminus.snapshot();
    expect(snapshot.inFlight).toBe(0);
    expect(snapshot.availablePaise).toBe(rupees(1000));
  });

  it("throws on a settlement it cannot record, because the money has already moved", async () => {
    // Admission fails closed; settlement fails loud. Swallowing this would leave a spend in the
    // books with nothing anywhere to explain it.
    const audit = new FailingLedger(false);
    const h = harness({ audit });
    const admission = await h.terminus.admit({
      action: action(),
      status: CLEAN_STATUS,
      attemptNo: 1,
    });
    if (!admission.allowed) throw new Error("expected an allow");

    audit.failing = true;
    await expect(h.terminus.settle(admission.grant, rupees(2), "delivered")).rejects.toThrow(
      SettlementUnrecordedError,
    );
  });

  it("hands the receipt back on that failure so the record can be completed without double-booking", async () => {
    const audit = new FailingLedger(false);
    const h = harness({ audit });
    const admission = await h.terminus.admit({
      action: action(),
      status: CLEAN_STATUS,
      attemptNo: 1,
    });
    if (!admission.allowed) throw new Error("expected an allow");

    audit.failing = true;
    const error = await h.terminus
      .settle(admission.grant, rupees(2), "delivered")
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SettlementUnrecordedError);
    if (!(error instanceof SettlementUnrecordedError)) return;
    expect(error.receipt.actualPaise).toBe(rupees(2));

    audit.failing = false;
    await h.terminus.recordSettlement(error.receipt, admission.grant);

    const snapshot = await h.terminus.snapshot();
    expect(snapshot.settledPaise).toBe(rupees(2));
    expect(snapshot.settledCount).toBe(1);
  });
});

describe("construction", () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore({ sweepIntervalMs: 0 });
  });

  it("rejects an unenforceable mandate at construction rather than at admission", () => {
    expect(
      () =>
        new Terminus({
          mandate: sealMandate(unsigned({ maxInFlight: 0 }), SECRET),
          secret: SECRET,
          store,
          audit: new MemoryLedger(),
          actor: "test",
        }),
    ).toThrow(/maxInFlight/);
  });

  it("scopes its keys by merchant and campaign, so two campaigns cannot spend each other's budget", async () => {
    const shared = new MemoryStore({ sweepIntervalMs: 0 });
    const clock = new ManualClock(NOON);
    const build = (campaignId: string): Terminus =>
      new Terminus({
        mandate: sealMandate(
          unsigned({
            campaignId,
            budgetPaise: rupees(3),
            contactCap: { limit: 99, windowMs: DAY },
          }),
          SECRET,
        ),
        secret: SECRET,
        store: shared,
        audit: new MemoryLedger(),
        actor: "test",
        clock,
      });

    const august = build("aug");
    const september = build("sep");

    const a = await august.admit({ action: action(), status: CLEAN_STATUS, attemptNo: 1 });
    const s = await september.admit({ action: action(), status: CLEAN_STATUS, attemptNo: 1 });
    expect(a.allowed).toBe(true);
    expect(s.allowed).toBe(true);
  });

  it("reports the sizer in force", () => {
    const h = harness({ sizer: estimateSizer() });
    expect(h.terminus.sizerName).toBe("estimate");
  });

  it("exposes the mandate it is enforcing", () => {
    const h = harness();
    expect(h.terminus.mandate.campaignId).toBe("aug-recovery");
  });
});

describe("steering actions", () => {
  it("targets the incident when there is no casualty", async () => {
    const h = harness({}, { allowedActions: ["steer"] });
    const incident = incidentId("inc_hdfc_upi_1");
    const admission = await h.terminus.admit({
      action: action({ kind: "steer", casualty: null, incident, estimatedCost: paise(0) }),
      status: CLEAN_STATUS,
      attemptNo: 1,
    });

    expect(admission.allowed).toBe(true);
    expect(h.ledger.records[0]?.target).toBe(`incident:${incident}`);
  });

  it("falls back to the customer when there is neither", async () => {
    const h = harness({}, { allowedActions: ["steer"] });
    await h.terminus.admit({
      action: action({ kind: "steer", casualty: null, incident: null }),
      status: CLEAN_STATUS,
      attemptNo: 1,
    });
    expect(h.ledger.records[0]?.target).toBe(`customer:${CUSTOMER}`);
  });
});

describe("a model call is an action", () => {
  it("is admitted only where the mandate says so", async () => {
    // The whole reason `reason` is in the action vocabulary rather than beside it. Inference spends
    // money, so it is governed by the lever that governs every other spend — and a merchant turns
    // model use off by editing `allowedActions`, not by shipping a deploy.
    const allowed = harness({}, { allowedActions: ["reason"] });
    const admission = await allowed.terminus.admit({
      action: action({ kind: "reason", casualty: null, incident: null, estimatedCost: paise(600) }),
      status: CLEAN_STATUS,
      attemptNo: 1,
    });
    expect(admission.allowed).toBe(true);

    const denied = harness({}, { allowedActions: ["contact-sms"] });
    const refused = await denied.terminus.admit({
      action: action({ kind: "reason", casualty: null, incident: null, estimatedCost: paise(600) }),
      status: CLEAN_STATUS,
      attemptNo: 1,
    });
    expect(refused.allowed).toBe(false);
  });

  it("does not count against a contact cap, because nobody is contacted", async () => {
    const h = harness({}, { allowedActions: ["reason"], contactCap: { limit: 1, windowMs: 1000 } });
    for (let i = 0; i < 5; i++) {
      const admission = await h.terminus.admit({
        action: action({ kind: "reason", casualty: null, incident: null, estimatedCost: paise(1) }),
        status: CLEAN_STATUS,
        attemptNo: 1,
      });
      expect(admission.allowed).toBe(true);
    }
  });

  it("draws on the same budget as the postage it is spent to improve", async () => {
    // Asking a model and sending an SMS come out of one campaign budget, so a merchant cannot be
    // surprised by an inference bill sitting outside the number they authorised.
    const h = harness(
      {},
      {
        budgetPaise: rupees(6),
        allowedActions: ["reason"],
        contactCap: { limit: 99, windowMs: DAY },
      },
    );
    const thinking = action({ kind: "reason", casualty: null, incident: null });

    expect(await spend(h, 1, rupees(3), thinking)).toBe(true);
    expect(await spend(h, 2, rupees(3), thinking)).toBe(true);

    const admission = await h.terminus.admit({
      action: thinking,
      status: CLEAN_STATUS,
      attemptNo: 3,
    });
    expect(admission.allowed).toBe(false);
    if (admission.allowed) return;
    expect(admission.axis).toBe("budget");
  });

  it("is not weighed against a recovery it was never attempting", async () => {
    // Asking a model what a failure was does not recover a rupee under any outcome — it changes
    // which message gets sent, and that message is weighed on its own merits a moment later. So
    // there is no expected return to put in the numerator, and the honest thing is to say so
    // rather than to invent a plausible one and round it upward until it passes.
    const h = harness({}, { allowedActions: ["reason"] });
    const admission = await h.terminus.admit({
      action: action({
        kind: "reason",
        casualty: null,
        incident: null,
        estimatedCost: paise(39),
        expectedValue: paise(0),
        successProbability: 0,
      }),
      status: CLEAN_STATUS,
      attemptNo: 1,
    });
    expect(admission.allowed).toBe(true);
  });

  it("still weighs every action that is attempting one", async () => {
    // The exemption is one kind wide. A message with no expected return is still measurable waste
    // and is still refused, which is what makes the gate worth having at all.
    const h = harness({}, { allowedActions: ["contact-sms"] });
    const admission = await h.terminus.admit({
      action: action({ estimatedCost: paise(39), expectedValue: paise(0), successProbability: 0 }),
      status: CLEAN_STATUS,
      attemptNo: 1,
    });
    expect(admission.allowed).toBe(false);
    if (admission.allowed) return;
    expect(admission.axis).toBe("expected-value");
  });
});
