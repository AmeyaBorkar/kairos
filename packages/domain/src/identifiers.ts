import { type Brand, DomainError } from "./brand.js";

/** Razorpay payment id (`pay_…`). */
export type AttemptId = Brand<string, "AttemptId">;
/** Razorpay order id (`order_…`). */
export type OrderId = Brand<string, "OrderId">;
/** A detected degradation. */
export type IncidentId = Brand<string, "IncidentId">;
/** A payment lost and queued for recovery. */
export type CasualtyId = Brand<string, "CasualtyId">;
/** A spend authority grant held by Terminus. */
export type MandateId = Brand<string, "MandateId">;

/**
 * A **pseudonymous** handle for a customer — a keyed hash of the real identifier, never the phone
 * number or email itself.
 *
 * This is the only customer key that reaches the detector, the policy engine, the ledger, or a
 * model prompt. Raw contact details live in one place with their own retention policy, and the
 * audit trail we hand to a judge or a regulator stays free of personal data while remaining fully
 * verifiable.
 */
export type CustomerRef = Brand<string, "CustomerRef">;

function makeId<T extends string>(kind: string, minLength: number) {
  return (value: string): Brand<string, T> => {
    if (value.length < minLength) {
      throw new DomainError(
        kind,
        `expected at least ${minLength} characters, received ${value.length}`,
      );
    }
    return value as Brand<string, T>;
  };
}

export const attemptId = makeId<"AttemptId">("attemptId", 1);
export const orderId = makeId<"OrderId">("orderId", 1);
export const incidentId = makeId<"IncidentId">("incidentId", 1);
export const casualtyId = makeId<"CasualtyId">("casualtyId", 1);
export const mandateId = makeId<"MandateId">("mandateId", 1);

/**
 * Customer references must be at least 16 characters, which a keyed hash always is and a raw
 * phone number never is. It is a cheap structural guard against a bare identifier leaking into
 * a field that gets logged.
 */
export const customerRef = makeId<"CustomerRef">("customerRef", 16);
