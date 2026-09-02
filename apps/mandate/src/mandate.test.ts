import { casualtyId, customerRef, DomainError, type Mandate, rupees } from "@kairos/domain";
import { MemoryLedger } from "@kairos/ledger";
import { DEFAULT_RECOVERY_CONFIG, worstActionCostPaise } from "@kairos/recover";
import { CLEAN_STATUS, ManualClock, sealMandate, Terminus, verifyMandate } from "@kairos/terminus";
import { MemoryStore } from "throttlekit";
import { describe, expect, it } from "vitest";
import { explainMandate } from "./explain.js";
import { handle } from "./routes.js";
import { type MandateSpec, toMandate } from "./spec.js";

const SECRET = "a-secret-that-lives-in-a-vault-not-a-repo";
const AT = Date.UTC(2026, 7, 25, 12, 0, 0);
const DAY = 86_400_000;

function spec(overrides: Partial<MandateSpec> = {}): MandateSpec {
  return {
    merchantId: "acme",
    campaignId: "diwali-recovery",
    purpose: "recovery",
    budgetRupees: 5000,
    maxInFlight: 16,
    runsForDays: 30,
    contactCap: { limit: 3, windowDays: 7 },
    quietHours: { start: "21:00", end: "08:00", offset: "+05:30" },
    startsAt: AT,
    ...overrides,
  };
}

describe("the units a merchant writes in", () => {
  it("turns rupees into paise, days into milliseconds, and a clock time into a minute of day", () => {
    const m = toMandate(spec());

    expect(m.budgetPaise).toBe(500_000);
    expect(m.contactCap.windowMs).toBe(7 * DAY);
    expect(m.validFrom).toBe(AT);
    expect(m.validUntil).toBe(AT + 30 * DAY);
    expect(m.reservationTtlMs).toBe(120_000);
    expect(m.quietHours).toEqual({ startMinute: 1260, endMinute: 480, offsetMinutes: 330 });
  });

  it("refuses a budget that is not a whole number of paise", () => {
    // ₹10.005 is not money. Silently rounding it is how a budget stops reconciling.
    expect(() => toMandate(spec({ budgetRupees: 10.005 }))).toThrow(DomainError);
  });

  it("refuses a time or an offset it would have to guess at", () => {
    const bad = [
      { start: "9pm", end: "08:00", offset: "+05:30" },
      { start: "21:00", end: "24:00", offset: "+05:30" },
      { start: "21:00", end: "08:00", offset: "IST" },
      { start: "21:00", end: "08:00", offset: "+5:30" },
    ];
    for (const quietHours of bad) {
      expect(() => toMandate(spec({ quietHours })), JSON.stringify(quietHours)).toThrow(
        DomainError,
      );
    }
  });

  it("accepts no quiet hours, because some campaigns genuinely have none", () => {
    expect(toMandate(spec({ quietHours: null })).quietHours).toBeNull();
  });

  it("refuses a spec the kernel could not enforce, at authoring time", () => {
    // The same check `validateMandate` runs at admission, run by the tool that writes the file.
    // Finding this out from a worker's crash loop is finding it out too late.
    expect(() => toMandate(spec({ runsForDays: 0 }))).toThrow(DomainError);
    expect(() => toMandate(spec({ maxInFlight: 0 }))).toThrow(DomainError);
    expect(() => toMandate(spec({ merchantId: "   " }))).toThrow(DomainError);
    expect(() => toMandate(spec({ contactCap: { limit: 0, windowDays: 7 } }))).toThrow(DomainError);
  });

  it("gives two mandates authored at the same instant the same id, and different campaigns different ones", () => {
    expect(toMandate(spec()).id).toBe(toMandate(spec()).id);
    expect(toMandate(spec()).id).not.toBe(toMandate(spec({ campaignId: "eid" })).id);
  });
});

describe("the fields a merchant does not get to choose", () => {
  it("takes the per-action ceiling from the price list, not from the form", () => {
    // Set below the worst message Kairos can compose, this refuses that message at settlement —
    // after it has been sent. It is a property of the price list, so it comes from there.
    expect(toMandate(spec()).maxActionCostPaise).toBe(
      worstActionCostPaise(DEFAULT_RECOVERY_CONFIG),
    );
  });

  it("gives a steering mandate the one action it needs and a ceiling that says steering is free", () => {
    const m = toMandate(spec({ purpose: "steering" }));
    expect(m.allowedActions).toEqual(["steer"]);
    expect(m.maxActionCostPaise).toBe(1);
  });

  it("lets a merchant narrow the action list", () => {
    // A merchant with email consent and no SMS consent tightening their own grant.
    const m = toMandate(spec({ allowedActions: ["contact-email", "retry"] }));
    expect(m.allowedActions).toEqual(["contact-email", "retry"]);
  });

  it("refuses to widen it past the purpose", () => {
    expect(() => toMandate(spec({ allowedActions: ["steer"] }))).toThrow(/outside this mandate/);
    expect(() => toMandate(spec({ allowedActions: ["teleport"] }))).toThrow(/unknown action/);
    expect(() => toMandate(spec({ allowedActions: [] }))).toThrow(/allows nothing/);
  });
});

describe("the reading", () => {
  const sealed = (overrides: Partial<MandateSpec> = {}): Mandate =>
    sealMandate(toMandate(spec(overrides)), SECRET);

  it("states the two numbers a mandate does not contain", () => {
    // Both are products of fields it does contain, which is exactly why nobody reads them off the
    // JSON — and they are the two a person signing this most needs.
    const text = explainMandate(sealed(), { now: AT }).join("\n");
    expect(text).toContain("₹5,000.00");
    // 16 in flight at the price list's worst case.
    const inFlight = 16 * worstActionCostPaise(DEFAULT_RECOVERY_CONFIG);
    expect(text).toContain(`(16 actions in flight)`);
    expect(text).toContain((inFlight / 100).toString());
  });

  it("says out loud that it did not check the signature", () => {
    // "No complaint" and "not checked" look identical on a terminal, and only one of them means the
    // mandate is genuine.
    expect(explainMandate(sealed(), { now: AT }).join("\n")).toContain("Not checked");
  });

  it("verifies a genuine mandate and catches an edited one", () => {
    const options = { secret: SECRET, verify: verifyMandate, now: AT };
    expect(explainMandate(sealed(), options).join("\n")).toContain("Verified.");

    const raised = { ...sealed(), budgetPaise: rupees(1_000_000) };
    expect(explainMandate(raised, options).join("\n")).toContain("DOES NOT VERIFY");
  });

  it("says whether the mandate is in force right now", () => {
    expect(explainMandate(sealed(), { now: AT + DAY }).join("\n")).toContain("In force now");
    expect(explainMandate(sealed(), { now: AT - DAY }).join("\n")).toContain("Not yet in force");
    expect(explainMandate(sealed(), { now: AT + 31 * DAY }).join("\n")).toContain("Expired");
  });

  it("leads with the kill switch when it is engaged", () => {
    const text = explainMandate(sealed({ killSwitch: true }), { now: AT }).join("\n");
    expect(text).toContain("ENGAGED");
    expect(text).toContain("authorises nothing at all");
  });

  it("says nothing about contact caps on a mandate that cannot contact anybody", () => {
    const text = explainMandate(sealed({ purpose: "steering" }), { now: AT }).join("\n");
    expect(text).not.toContain("PEOPLE");
    expect(text).toContain("reorder or hide payment methods");
  });
});

describe("the form's routes", () => {
  it("explains a spec without signing it, and does not look like it signed it", () => {
    const reply = handle("/preview", { spec: spec() });
    expect(reply.status).toBe(200);
    expect(reply.body["mandate"]).toBeUndefined();
    expect((reply.body["explanation"] as string[]).join("\n")).toContain("preview — not signed");
  });

  it("answers a bad spec with the domain's own words, naming the field", () => {
    const reply = handle("/preview", { spec: spec({ maxInFlight: -1 }) });
    expect(reply.status).toBe(400);
    expect(reply.body["ok"]).toBe(false);
    expect(String(reply.body["error"])).toContain("maxInFlight");
  });

  it("refuses a body that is not a spec", () => {
    expect(handle("/preview", null).status).toBe(400);
    expect(handle("/preview", {}).status).toBe(400);
  });

  it("refuses to seal without a key, and says what to do instead", () => {
    const reply = handle("/seal", { spec: spec() });
    expect(reply.status).toBe(403);
    expect(String(reply.body["error"])).toContain("kairos-mandate seal");
  });

  it("seals a mandate that verifies against the key it was sealed with", () => {
    const reply = handle("/seal", { spec: spec() }, SECRET);
    expect(reply.status).toBe(200);
    const mandate = reply.body["mandate"] as Mandate;
    expect(verifyMandate(mandate, SECRET)).toBe(true);
    expect(verifyMandate(mandate, `${SECRET}x`)).toBe(false);
    expect((reply.body["explanation"] as string[]).join("\n")).toContain("Verified.");
  });
});

/**
 * The point of the whole path. A mandate authored in a form is worth nothing unless the kernel
 * accepts it and enforces exactly what the form said it would.
 */
describe("end to end", () => {
  function terminus(mandate: Mandate): Terminus {
    return new Terminus({
      mandate,
      secret: SECRET,
      store: new MemoryStore({ sweepIntervalMs: 0 }),
      audit: new MemoryLedger(),
      actor: "recover-worker/test",
      clock: new ManualClock(AT),
    });
  }

  const action = {
    kind: "contact-sms" as const,
    customer: customerRef("cus_9f3b2a71c4e8d012"),
    casualty: casualtyId("cas_001"),
    incident: null,
    estimatedCost: rupees(0.2),
    expectedValue: rupees(2000),
    successProbability: 0.3,
    rationale: "issuer recovered; the customer's card failed on a transient decline",
  };

  it("produces a mandate the kernel admits an action against", async () => {
    const mandate = sealMandate(toMandate(spec()), SECRET);
    const admission = await terminus(mandate).admit({ action, status: CLEAN_STATUS, attemptNo: 1 });
    expect(admission.allowed).toBe(true);
  });

  it("enforces the narrowing the merchant made in the form", async () => {
    // Untick SMS in the form and the kernel refuses an SMS by name — not because the worker
    // remembered to check, but because the grant does not contain it.
    const mandate = sealMandate(toMandate(spec({ allowedActions: ["contact-email"] })), SECRET);
    const admission = await terminus(mandate).admit({ action, status: CLEAN_STATUS, attemptNo: 1 });
    expect(admission.allowed).toBe(false);
  });

  it("enforces a kill switch sealed into the mandate", async () => {
    const mandate = sealMandate(toMandate(spec({ killSwitch: true })), SECRET);
    const admission = await terminus(mandate).admit({ action, status: CLEAN_STATUS, attemptNo: 1 });
    expect(admission.allowed).toBe(false);
  });

  it("refuses a mandate whose budget was raised after it was signed", async () => {
    // The attack the signature exists to stop: edit the JSON the form produced, hand it to an
    // operator, and hope nobody re-reads it.
    const mandate = sealMandate(toMandate(spec()), SECRET);
    const raised = { ...mandate, budgetPaise: rupees(10_000_000) };
    const admission = await terminus(raised).admit({ action, status: CLEAN_STATUS, attemptNo: 1 });
    expect(admission.allowed).toBe(false);
  });
});
