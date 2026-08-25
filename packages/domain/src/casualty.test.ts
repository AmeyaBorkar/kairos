import { describe, expect, it } from "vitest";
import type { FailureDetail } from "./attempt.js";
import { DomainError } from "./brand.js";
import {
  applyOutcome,
  type Casualty,
  contactsSent,
  hasTried,
  lastActedAt,
  markDisputed,
  markOptedOut,
  markRecovered,
  openCasualty,
  type RecoveryAttempt,
  retriesMade,
} from "./casualty.js";
import { attemptId, casualtyId, customerRef, orderId } from "./identifiers.js";
import { paise } from "./money.js";
import { slice } from "./slice.js";

const AT = Date.UTC(2026, 7, 25, 10, 0, 0);

const failure: FailureDetail = {
  code: "GATEWAY_ERROR",
  source: "bank",
  step: "payment_authorization",
  reason: "payment_timed_out_at_bank",
  description: "Bank did not respond in time",
};

function casualty(overrides: Partial<Parameters<typeof openCasualty>[0]> = {}): Casualty {
  return openCasualty(
    {
      id: casualtyId("cas_1"),
      kind: "payment-failed",
      customer: customerRef("cus_000000000001"),
      orderId: orderId("order_1"),
      attemptId: attemptId("pay_1"),
      slice: slice("upi", "hdfc", "gpay"),
      amount: paise(120_000),
      failure,
      retry: "requires-customer",
      occurredAt: AT,
      ...overrides,
    },
    "transient",
  );
}

const attempt = (o: Partial<RecoveryAttempt> = {}): RecoveryAttempt => ({
  kind: "retry",
  at: AT + 60_000,
  outcome: "declined-soft",
  costPaise: paise(0),
  externalRef: null,
  ...o,
});

describe("openCasualty", () => {
  it("starts with a clean status and no attempts", () => {
    const c = casualty();
    expect(c.status).toEqual({
      recovered: false,
      optedOut: false,
      disputed: false,
      consecutiveHardDeclines: 0,
      recoverability: "transient",
    });
    expect(c.attempts).toEqual([]);
  });

  it("refuses a failed payment with no failure attached", () => {
    // The classifier reads the failure triple. A payment-failed casualty without one would be
    // classified as a residual and chased on the wrong ladder, so it is rejected at construction
    // rather than silently downgraded.
    expect(() => casualty({ failure: null })).toThrow(DomainError);
  });

  it("allows a kind that genuinely has no failure to describe", () => {
    const c = openCasualty(
      {
        id: casualtyId("cas_2"),
        kind: "checkout-abandoned",
        customer: customerRef("cus_000000000002"),
        orderId: orderId("order_2"),
        attemptId: null,
        slice: slice("upi"),
        amount: paise(90_000),
        failure: null,
        retry: "requires-customer",
        occurredAt: AT,
      },
      "customer-retry",
    );
    expect(c.status.recoverability).toBe("customer-retry");
  });

  it("refuses a casualty for no money", () => {
    expect(() => casualty({ amount: paise(0) })).toThrow(DomainError);
  });
});

describe("applyOutcome", () => {
  it("counts consecutive hard declines", () => {
    let c = casualty();
    c = applyOutcome(c, attempt({ outcome: "declined-hard" }));
    c = applyOutcome(c, attempt({ outcome: "declined-hard" }));
    expect(c.status.consecutiveHardDeclines).toBe(2);
  });

  it("resets the counter on a delivered message, which is a real loosening", () => {
    // Documented in the implementation and asserted here so the choice cannot drift silently: a
    // contact between two hard declines makes the stopping rule start again. What bounds the damage
    // is the contact cap and the budget, not this counter.
    let c = casualty();
    c = applyOutcome(c, attempt({ outcome: "declined-hard" }));
    c = applyOutcome(c, attempt({ outcome: "declined-hard" }));
    c = applyOutcome(c, attempt({ kind: "contact-sms", outcome: "delivered" }));
    c = applyOutcome(c, attempt({ outcome: "declined-hard" }));

    expect(c.status.consecutiveHardDeclines).toBe(1);
    expect(c.attempts).toHaveLength(4);
  });

  it("is monotone in recovery — a later decline cannot un-recover money", () => {
    let c = casualty();
    c = applyOutcome(c, attempt({ outcome: "recovered" }));
    c = applyOutcome(c, attempt({ outcome: "declined-hard" }));
    expect(c.status.recovered).toBe(true);
  });

  it("leaves the original untouched", () => {
    const before = casualty();
    const after = applyOutcome(before, attempt());
    expect(before.attempts).toEqual([]);
    expect(after.attempts).toHaveLength(1);
  });
});

describe("marks", () => {
  it("records recovery that Kairos did not cause", () => {
    expect(markRecovered(casualty()).status.recovered).toBe(true);
  });

  it("records an opt-out and a dispute", () => {
    expect(markOptedOut(casualty()).status.optedOut).toBe(true);
    expect(markDisputed(casualty()).status.disputed).toBe(true);
  });
});

describe("history", () => {
  it("counts contacts that were actually sent", () => {
    let c = casualty();
    c = applyOutcome(c, attempt({ kind: "contact-sms", outcome: "delivered" }));
    c = applyOutcome(c, attempt({ kind: "contact-email", outcome: "undeliverable" }));
    c = applyOutcome(c, attempt({ kind: "retry", outcome: "declined-soft" }));

    // An undeliverable message reached nobody, so it does not count as having contacted them.
    expect(contactsSent(c)).toBe(1);
    expect(retriesMade(c)).toBe(1);
  });

  it("remembers what has been tried, deliverable or not", () => {
    const c = applyOutcome(
      casualty(),
      attempt({ kind: "contact-email", outcome: "undeliverable" }),
    );
    expect(hasTried(c, "contact-email")).toBe(true);
    expect(hasTried(c, "contact-sms")).toBe(false);
  });

  it("reports no last action before anything has happened", () => {
    expect(lastActedAt(casualty())).toBeNull();
    expect(lastActedAt(applyOutcome(casualty(), attempt({ at: 42 })))).toBe(42);
  });
});
