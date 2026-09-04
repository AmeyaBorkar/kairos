import { createHmac } from "node:crypto";
import { customerRef } from "@kairos/domain";
import { describe, expect, it } from "vitest";
import { attemptFrom, paymentFrom } from "./inbound.js";

const pseudonymise = (raw: string) =>
  customerRef(`rzp_${createHmac("sha256", "k".repeat(64)).update(raw).digest("hex").slice(0, 32)}`);
const options = { pseudonymise };

/**
 * A real payment, taken out of a real Razorpay test account.
 *
 * Kept verbatim apart from the contact, because the shape is the point: `network: "Visa"` with
 * `issuer: null` is what Razorpay actually returns for a card it cannot attribute, and the first
 * version of this translator built an illegal slice out of it and dropped the payment in silence.
 * A fixture invented from the documentation would have had an issuer.
 */
const REAL_FAILED_CARD = {
  id: "pay_TXhqg0VMRjQhkS",
  entity: "payment",
  amount: 100,
  currency: "INR",
  status: "failed",
  order_id: null,
  method: "card",
  bank: null,
  wallet: null,
  vpa: null,
  card: { network: "Visa", issuer: null, last4: "1111", type: "credit" },
  contact: "+919999999999",
  email: "someone@example.com",
  error_code: "BAD_REQUEST_ERROR",
  error_source: "business",
  error_step: "payment_initiation",
  error_reason: "international_transaction_not_allowed",
  error_description:
    "Your payment could not be completed as this business accepts domestic (Indian) card payments only.",
  created_at: 1_788_469_555,
};

describe("a real Razorpay payment", () => {
  it("is read, not dropped", () => {
    expect(attemptFrom(REAL_FAILED_CARD, options)).not.toBeNull();
  });

  it("drops the network when the issuer is unknown, rather than the payment", () => {
    // The domain refuses an instrument under a null issuer, and is right to: the slice key is a
    // hierarchy and "Visa, bank unknown" cannot sit under a bank. `card||` is a true thing to say.
    const attempt = attemptFrom(REAL_FAILED_CARD, options);
    expect(attempt?.slice).toEqual({ method: "card", issuer: null, instrument: null });
  });

  it("keeps the network when there is an issuer to hang it on", () => {
    const attempt = attemptFrom(
      { ...REAL_FAILED_CARD, card: { network: "Visa", issuer: "HDFC" } },
      options,
    );
    expect(attempt?.slice).toEqual({ method: "card", issuer: "hdfc", instrument: "visa" });
  });

  it("passes Razorpay's failure triple through untranslated", () => {
    // The classifier reads source/step/reason. Re-coding them into a private enum here would put a
    // lossy mapping between the gateway's account of what went wrong and the decision made about it.
    expect(attemptFrom(REAL_FAILED_CARD, options)?.failure).toEqual({
      code: "BAD_REQUEST_ERROR",
      source: "business",
      step: "payment_initiation",
      reason: "international_transaction_not_allowed",
      description: REAL_FAILED_CARD.error_description,
    });
  });

  it("converts seconds to milliseconds", () => {
    // Out by a factor of a thousand lands every observation in 1970, where a rolling window
    // silently contains nothing at all.
    expect(attemptFrom(REAL_FAILED_CARD, options)?.at).toBe(1_788_469_555_000);
    expect(new Date(attemptFrom(REAL_FAILED_CARD, options)?.at ?? 0).getUTCFullYear()).toBe(2026);
  });

  it("lets a payment with no order stand on its own id", () => {
    expect(attemptFrom(REAL_FAILED_CARD, options)?.orderId).toBe("pay_TXhqg0VMRjQhkS");
  });
});

describe("personal data", () => {
  it("never reaches the attempt", () => {
    const attempt = attemptFrom(REAL_FAILED_CARD, options);
    const serialised = JSON.stringify(attempt);
    expect(serialised).not.toContain("9999999999");
    expect(serialised).not.toContain("example.com");
  });

  it("resolves the same person to the same reference", () => {
    const a = attemptFrom(REAL_FAILED_CARD, options);
    const b = attemptFrom({ ...REAL_FAILED_CARD, id: "pay_other" }, options);
    expect(a?.customer).toBe(b?.customer);
  });

  it("prefers the contact, because it identifies a customer across checkouts", () => {
    const withEmailOnly = attemptFrom({ ...REAL_FAILED_CARD, contact: null }, options);
    expect(withEmailOnly?.customer).not.toBe(attemptFrom(REAL_FAILED_CARD, options)?.customer);
  });

  it("still reads a payment that identifies nobody", () => {
    // An anonymous payment is still a real observation about a rail.
    const attempt = attemptFrom({ ...REAL_FAILED_CARD, contact: null, email: null }, options);
    expect(attempt).not.toBeNull();
    expect(attempt?.customer).toContain("rzp_");
  });
});

describe("what it refuses, and what it says about it", () => {
  it("names the reason rather than saying 'not readable'", () => {
    const reasons: string[] = [];
    attemptFrom(
      { ...REAL_FAILED_CARD, method: "cardless_emi" },
      { ...options, onDrop: (r) => reasons.push(r) },
    );
    expect(reasons[0]).toMatch(/cardless_emi/);
  });

  it("drops a method Kairos does not model", () => {
    expect(attemptFrom({ ...REAL_FAILED_CARD, method: "bank_transfer" }, options)).toBeNull();
  });

  it("drops a refund, which is not a failed payment", () => {
    // It succeeded, and something happened afterwards this stream has nothing to say about.
    expect(attemptFrom({ ...REAL_FAILED_CARD, status: "refunded" }, options)).toBeNull();
  });

  it("drops an amount that is not a whole number of paise", () => {
    expect(attemptFrom({ ...REAL_FAILED_CARD, amount: 10.5 }, options)).toBeNull();
    expect(attemptFrom({ ...REAL_FAILED_CARD, amount: -1 }, options)).toBeNull();
    expect(attemptFrom({ ...REAL_FAILED_CARD, amount: "100" }, options)).toBeNull();
  });

  it("drops a payment with no timestamp", () => {
    expect(attemptFrom({ ...REAL_FAILED_CARD, created_at: null }, options)).toBeNull();
  });
});

describe("other methods", () => {
  it("reads a UPI payment, taking the PSP from the VPA handle", () => {
    const attempt = attemptFrom(
      { ...REAL_FAILED_CARD, method: "upi", card: null, vpa: "somebody@okhdfcbank" },
      options,
    );
    expect(attempt?.slice).toEqual({ method: "upi", issuer: "okhdfcbank", instrument: null });
  });

  it("reads a netbanking payment by its bank", () => {
    const attempt = attemptFrom(
      { ...REAL_FAILED_CARD, method: "netbanking", card: null, bank: "SBIN" },
      options,
    );
    expect(attempt?.slice).toEqual({ method: "netbanking", issuer: "sbin", instrument: null });
  });

  it("reads a captured payment as carrying no failure", () => {
    const captured = { ...REAL_FAILED_CARD, status: "captured", error_code: null };
    const attempt = attemptFrom(captured, options);
    expect(attempt?.status).toBe("captured");
    expect(attempt?.failure).toBeNull();
  });
});

describe("the webhook envelope", () => {
  it("finds the payment inside a payment.failed event", () => {
    const event = { event: "payment.failed", payload: { payment: { entity: REAL_FAILED_CARD } } };
    expect(paymentFrom(event)).toBe(REAL_FAILED_CARD);
  });

  it("finds nothing in an event that carries no payment", () => {
    expect(paymentFrom({ event: "settlement.processed", payload: { settlement: {} } })).toBeNull();
    expect(paymentFrom({})).toBeNull();
    expect(paymentFrom(null)).toBeNull();
    expect(paymentFrom("not an object")).toBeNull();
  });
});
