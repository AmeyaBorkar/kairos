import { createHmac, timingSafeEqual } from "node:crypto";
import type { Mandate } from "@kairos/domain";
import { canonicalize, type JsonValue } from "@kairos/ledger";

/** A mandate before it has been sealed. */
export type UnsignedMandate = Omit<Mandate, "signature">;

/**
 * The exact bytes a mandate's signature covers.
 *
 * Written as an explicit field-by-field projection rather than a spread, because the failure mode
 * of the convenient version is silent and severe: add a field to {@link Mandate}, forget to add it
 * here, and that field is unsigned — a limit anyone can edit without breaking verification. The
 * spelling-it-out cost is one line per field; the test suite asserts that perturbing *any* field
 * changes the signature, so the omission is caught rather than merely discouraged.
 */
function mandateToJson(m: UnsignedMandate): JsonValue {
  return {
    id: m.id,
    merchantId: m.merchantId,
    campaignId: m.campaignId,
    budgetPaise: m.budgetPaise,
    maxActionCostPaise: m.maxActionCostPaise,
    maxInFlight: m.maxInFlight,
    reservationTtlMs: m.reservationTtlMs,
    contactCap: { limit: m.contactCap.limit, windowMs: m.contactCap.windowMs },
    quietHours:
      m.quietHours === null
        ? null
        : {
            startMinute: m.quietHours.startMinute,
            endMinute: m.quietHours.endMinute,
            offsetMinutes: m.quietHours.offsetMinutes,
          },
    allowedActions: [...m.allowedActions],
    validFrom: m.validFrom,
    validUntil: m.validUntil,
    killSwitch: m.killSwitch,
  };
}

/**
 * Sign a mandate.
 *
 * The domain separator prevents a mandate's canonical bytes from ever being mistaken for another
 * kind of signed object under the same key — a cross-protocol confusion that costs nothing to
 * prevent here and cannot be retrofitted once signatures are in circulation.
 */
export function signMandate(m: UnsignedMandate, secret: string): string {
  return createHmac("sha256", secret)
    .update("kairos.mandate.v1\n", "utf8")
    .update(canonicalize(mandateToJson(m)), "utf8")
    .digest("hex");
}

/** Attach a signature, producing a mandate the kernel will accept. */
export function sealMandate(m: UnsignedMandate, secret: string): Mandate {
  return { ...m, signature: signMandate(m, secret) };
}

/**
 * Constant-time signature check.
 *
 * `timingSafeEqual` throws on length mismatch, so the length is compared first — and that
 * comparison leaks only the length of a hex digest, which is a constant of the algorithm.
 */
export function verifyMandate(m: Mandate, secret: string): boolean {
  const expected = Buffer.from(signMandate(m, secret), "utf8");
  const presented = Buffer.from(m.signature, "utf8");
  if (expected.length !== presented.length) return false;
  return timingSafeEqual(expected, presented);
}
