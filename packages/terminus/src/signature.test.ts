import type { Mandate } from "@kairos/domain";
import { mandateId, rupees } from "@kairos/domain";
import { describe, expect, it } from "vitest";
import { sealMandate, signMandate, type UnsignedMandate, verifyMandate } from "./signature.js";

const SECRET = "a-secret-that-lives-in-a-vault-not-a-repo";
const HOUR = 3_600_000;

const base: UnsignedMandate = {
  id: mandateId("mnd_aug"),
  merchantId: "acme",
  campaignId: "aug-recovery",
  budgetPaise: rupees(50_000),
  maxActionCostPaise: rupees(3),
  maxInFlight: 8,
  reservationTtlMs: 30_000,
  contactCap: { limit: 3, windowMs: 7 * 24 * HOUR },
  quietHours: { startMinute: 21 * 60, endMinute: 8 * 60, offsetMinutes: 330 },
  allowedActions: ["contact-sms", "retry"],
  validFrom: 1_756_000_000_000,
  validUntil: 1_756_000_000_000 + 30 * 24 * HOUR,
  killSwitch: false,
};

describe("signMandate", () => {
  it("is deterministic", () => {
    expect(signMandate(base, SECRET)).toBe(signMandate(base, SECRET));
  });

  it("does not depend on the order fields were written in", () => {
    // The canonical encoding sorts keys, so two mandates assembled by different code paths with
    // identical content produce identical bytes. Without this, verification would fail for a
    // mandate nobody had touched.
    const reordered = {
      killSwitch: base.killSwitch,
      validUntil: base.validUntil,
      validFrom: base.validFrom,
      allowedActions: base.allowedActions,
      quietHours: base.quietHours,
      contactCap: base.contactCap,
      reservationTtlMs: base.reservationTtlMs,
      maxInFlight: base.maxInFlight,
      maxActionCostPaise: base.maxActionCostPaise,
      budgetPaise: base.budgetPaise,
      campaignId: base.campaignId,
      merchantId: base.merchantId,
      id: base.id,
    } satisfies UnsignedMandate;
    expect(signMandate(reordered, SECRET)).toBe(signMandate(base, SECRET));
  });

  it("changes with the key", () => {
    expect(signMandate(base, "other-secret")).not.toBe(signMandate(base, SECRET));
  });
});

/**
 * Every field, perturbed.
 *
 * This is the test that keeps the hand-written canonical projection honest. Add a field to
 * `Mandate`, forget to add it to the encoder, and that field is unsigned — a limit anyone can edit
 * without breaking verification. The list below has to be extended alongside the type, and a
 * missing entry is the one failure this suite cannot catch on its own, so the count is asserted too.
 */
const PERTURBATIONS: ReadonlyArray<readonly [string, UnsignedMandate]> = [
  ["id", { ...base, id: mandateId("mnd_sep") }],
  ["merchantId", { ...base, merchantId: "acme-two" }],
  ["campaignId", { ...base, campaignId: "sep-recovery" }],
  ["budgetPaise", { ...base, budgetPaise: rupees(50_001) }],
  ["maxActionCostPaise", { ...base, maxActionCostPaise: rupees(4) }],
  ["maxInFlight", { ...base, maxInFlight: 9 }],
  ["reservationTtlMs", { ...base, reservationTtlMs: 30_001 }],
  ["contactCap.limit", { ...base, contactCap: { ...base.contactCap, limit: 4 } }],
  ["contactCap.windowMs", { ...base, contactCap: { ...base.contactCap, windowMs: HOUR } }],
  [
    "quietHours.startMinute",
    { ...base, quietHours: { startMinute: 1, endMinute: 480, offsetMinutes: 330 } },
  ],
  [
    "quietHours.endMinute",
    { ...base, quietHours: { startMinute: 1260, endMinute: 481, offsetMinutes: 330 } },
  ],
  [
    "quietHours.offsetMinutes",
    { ...base, quietHours: { startMinute: 1260, endMinute: 480, offsetMinutes: 0 } },
  ],
  ["quietHours removed", { ...base, quietHours: null }],
  ["allowedActions content", { ...base, allowedActions: ["contact-sms", "escalate"] }],
  ["allowedActions order", { ...base, allowedActions: ["retry", "contact-sms"] }],
  ["allowedActions length", { ...base, allowedActions: ["contact-sms"] }],
  ["validFrom", { ...base, validFrom: base.validFrom + 1 }],
  ["validUntil", { ...base, validUntil: base.validUntil + 1 }],
  ["killSwitch", { ...base, killSwitch: true }],
];

describe("signature coverage", () => {
  it.each(PERTURBATIONS)("changes when %s changes", (_label, perturbed) => {
    expect(signMandate(perturbed, SECRET)).not.toBe(signMandate(base, SECRET));
  });

  it("covers every field of the mandate", () => {
    // A field added to `Mandate` without a perturbation here would be silently unsigned. Counting
    // the top-level keys is a crude guard, but it fails loudly on the day someone adds one.
    const topLevel = Object.keys(base).length;
    expect(topLevel).toBe(13);
  });
});

describe("verifyMandate", () => {
  it("accepts a mandate it sealed", () => {
    expect(verifyMandate(sealMandate(base, SECRET), SECRET)).toBe(true);
  });

  it("rejects a mandate whose budget was edited after signing", () => {
    const sealed = sealMandate(base, SECRET);
    const tampered: Mandate = { ...sealed, budgetPaise: rupees(5_000_000) };
    expect(verifyMandate(tampered, SECRET)).toBe(false);
  });

  it("rejects a mandate whose kill switch was cleared after signing", () => {
    const stopped = sealMandate({ ...base, killSwitch: true }, SECRET);
    const restarted: Mandate = { ...stopped, killSwitch: false };
    expect(verifyMandate(restarted, SECRET)).toBe(false);
  });

  it("rejects a mandate signed with a different key", () => {
    expect(verifyMandate(sealMandate(base, "other-secret"), SECRET)).toBe(false);
  });

  it("rejects a signature of the wrong length without throwing", () => {
    // `timingSafeEqual` throws on a length mismatch, so the length is compared first. An attacker
    // presenting a truncated digest must get `false`, not an exception the caller might mishandle.
    const sealed = sealMandate(base, SECRET);
    expect(verifyMandate({ ...sealed, signature: "" }, SECRET)).toBe(false);
    expect(verifyMandate({ ...sealed, signature: sealed.signature.slice(0, 32) }, SECRET)).toBe(
      false,
    );
    expect(verifyMandate({ ...sealed, signature: `${sealed.signature}00` }, SECRET)).toBe(false);
  });

  it("rejects a signature that differs in a single character", () => {
    const sealed = sealMandate(base, SECRET);
    const first = sealed.signature[0] === "a" ? "b" : "a";
    expect(verifyMandate({ ...sealed, signature: first + sealed.signature.slice(1) }, SECRET)).toBe(
      false,
    );
  });
});
