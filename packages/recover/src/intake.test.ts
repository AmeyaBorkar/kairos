import { type Attempt, attemptId, customerRef, orderId, paise, slice } from "@kairos/domain";
import { describe, expect, it } from "vitest";
import { casualtyFrom, idForAttempt } from "./intake.js";

const AT = Date.UTC(2026, 7, 25, 6, 0, 0);

function attempt(overrides: Partial<Attempt> = {}): Attempt {
  return {
    id: attemptId("pay_000001"),
    orderId: orderId("order_000001"),
    customer: customerRef("cus_000000000001"),
    amount: paise(120_000),
    slice: slice("upi", "hdfc", "gpay"),
    status: "failed",
    failure: {
      code: "BAD_REQUEST_ERROR",
      source: "customer",
      step: "payment_initiation",
      reason: "card_expired",
      description: "The card has expired",
    },
    at: AT,
    ...overrides,
  };
}

describe("intake", () => {
  it("classifies a failure at the moment it arrives", () => {
    const casualty = casualtyFrom(attempt(), "requires-customer");
    expect(casualty?.status.recoverability).toBe("customer-action");
    expect(casualty?.occurredAt).toBe(AT);
    expect(casualty?.attempts).toEqual([]);
  });

  it("gives the same payment the same casualty id from any door", () => {
    // The intake runs in a webhook, in a reconciliation sweep behind it, and in the harness. A
    // generated id would give a merchant two queue entries for one lost payment and chase both.
    expect(idForAttempt(attempt())).toBe(idForAttempt(attempt()));
    expect(idForAttempt(attempt())).not.toBe(idForAttempt(attempt({ id: attemptId("pay_2") })));
  });

  it("opens nothing for a payment that did not fail", () => {
    expect(casualtyFrom(attempt({ status: "captured", failure: null }), "autonomous")).toBeNull();
    expect(casualtyFrom(attempt({ status: "authorized", failure: null }), "autonomous")).toBeNull();
  });

  it("opens nothing for a payment still in flight", () => {
    // Counting an unresolved payment as a casualty chases a customer whose money is on its way.
    expect(casualtyFrom(attempt({ status: "created", failure: null }), "autonomous")).toBeNull();
  });

  it("carries the retry capability it was told about rather than guessing", () => {
    expect(casualtyFrom(attempt(), "autonomous")?.retry).toBe("autonomous");
    expect(casualtyFrom(attempt(), "requires-customer")?.retry).toBe("requires-customer");
  });
});
