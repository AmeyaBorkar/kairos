import type { FailureDetail, PaymentMethod, RecoverabilityClass } from "@kairos/domain";
import { BASELINE_FAILURES, DEGRADATION_FAILURES, INDIA_PROFILES } from "@kairos/simulator";
import { describe, expect, it } from "vitest";
import { classify, isResidual, ruleIds } from "./classify.js";

const failure = (o: Partial<FailureDetail>): FailureDetail => ({
  code: "BAD_REQUEST_ERROR",
  source: "customer",
  step: "payment_authorization",
  reason: "unmapped_reason_nobody_has_seen",
  description: "",
  ...o,
});

const classOf = (o: Partial<FailureDetail>): RecoverabilityClass =>
  classify(failure(o)).recoverability;

describe("the rule table", () => {
  it("gives every rule a distinct id", () => {
    const ids = ruleIds();
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("normalises the two spellings Razorpay uses for the same cause", () => {
    // `payment_failed_due_to_insufficient_funds` and `insufficient_funds` are the same event
    // reported by different parts of their stack. A table keyed on literals classifies one and
    // silently drops the other into the residual.
    expect(classOf({ reason: "insufficient_funds" })).toBe("timed");
    expect(classOf({ reason: "payment_failed_due_to_insufficient_funds" })).toBe("timed");
    expect(classOf({ reason: "PAYMENT_FAILED_DUE_TO_INSUFFICIENT_FUNDS" })).toBe("timed");
  });

  it("stops on failures no future can fix", () => {
    expect(classOf({ reason: "card_reported_lost_or_stolen" })).toBe("dead");
    expect(classOf({ reason: "international_transaction_not_allowed" })).toBe("dead");
    expect(classOf({ reason: "payment_blocked_by_risk_engine" })).toBe("dead");
  });

  it("asks the customer to fix what only they can fix", () => {
    expect(classOf({ reason: "card_expired" })).toBe("customer-action");
    expect(classOf({ reason: "invalid_vpa" })).toBe("customer-action");
    expect(classOf({ reason: "mandate_revoked_by_customer" })).toBe("customer-action");
  });

  it("waits for money rather than chasing it", () => {
    expect(classOf({ reason: "insufficient_wallet_balance" })).toBe("timed");
    expect(classOf({ reason: "credit_limit_exhausted" })).toBe("timed");
    expect(classOf({ reason: "daily_limit_exceeded" })).toBe("timed");
  });

  it("separates a customer who must change something from one who must simply try again", () => {
    // The distinction the sixth class exists for. Both need the customer; only one has anything
    // to do before paying, and that sets how many times it is reasonable to ask.
    expect(classOf({ reason: "card_expired" })).toBe("customer-action");
    expect(classOf({ reason: "incorrect_otp" })).toBe("customer-retry");
    expect(classOf({ reason: "incorrect_upi_pin" })).toBe("customer-retry");
    expect(classOf({ reason: "payment_cancelled_by_user" })).toBe("customer-retry");
  });

  it("recognises the rails the detector already watches", () => {
    expect(classOf({ reason: "issuer_not_available", source: "bank" })).toBe("transient");
    expect(classOf({ reason: "bank_server_down", source: "bank" })).toBe("transient");
    expect(classOf({ reason: "payment_timed_out_at_bank", source: "bank" })).toBe("transient");
    expect(classOf({ reason: "gateway_technical_error", source: "gateway" })).toBe("transient");
  });

  it("does not confuse an unavailable authentication service with a failed authentication", () => {
    // One is the 3-D Secure service being down, which heals. The other is a customer entering the
    // wrong code, which does not. They differ by two words and want opposite treatments.
    expect(classOf({ reason: "authentication_service_unavailable" })).toBe("transient");
    expect(classOf({ reason: "authentication_failed" })).toBe("customer-retry");
  });

  it("prices a bare bank decline as the ambiguity it is", () => {
    // `payment_declined_by_bank` covers a risk decision, a velocity cap and a soft authorisation
    // failure with one string. Classified as the thing it most often is, at half confidence, so the
    // expected-value gate prices the doubt instead of the table pretending it away.
    const c = classify(failure({ reason: "payment_declined_by_bank", source: "bank" }));
    expect(c.recoverability).toBe("transient");
    expect(c.confidence).toBe(0.5);
    expect(c.source).toBe("table");
  });

  it("prefers the specific rule when a decline is also a risk block", () => {
    expect(classOf({ reason: "declined_by_risk_engine", source: "bank" })).toBe("dead");
  });
});

describe("structural fallbacks", () => {
  it("classifies an error nobody has ever mapped from who broke it and where", () => {
    // The property that matters when Razorpay ships a new code on a Tuesday: the table degrades
    // instead of collapsing, because source and step are still evidence.
    const c = classify(
      failure({
        reason: "some_error_introduced_next_year",
        source: "bank",
        step: "payment_authorization",
        code: "GATEWAY_ERROR",
      }),
    );
    expect(c.recoverability).toBe("transient");
    expect(c.source).toBe("structure");
    expect(c.confidence).toBeLessThan(1);
    expect(isResidual(c)).toBe(false);
  });

  it("trusts a structural answer less than a named one", () => {
    const named = classify(failure({ reason: "issuer_not_available", source: "bank" }));
    const structural = classify(
      failure({ reason: "who_knows", source: "bank", step: "payment_authorization" }),
    );
    expect(structural.confidence).toBeLessThan(named.confidence);
  });

  it("gives up honestly when even the structure says nothing", () => {
    const c = classify(
      failure({ reason: "who_knows", source: "business", step: "payment_capture" }),
    );
    expect(c.recoverability).toBe("unknown");
    expect(c.source).toBe("default");
    expect(isResidual(c)).toBe(true);
  });
});

describe("casualties with no failure to read", () => {
  it("treats an abandoned checkout as a customer who must simply come back", () => {
    const c = classify(null, "checkout-abandoned");
    expect(c.recoverability).toBe("customer-retry");
    expect(isResidual(c)).toBe(false);
  });

  it("treats an overdue invoice as something the customer must act on", () => {
    expect(classify(null, "invoice-overdue").recoverability).toBe("customer-action");
  });
});

describe("against the modelled traffic", () => {
  const everyTemplate = [
    ...Object.values(BASELINE_FAILURES).flat(),
    ...Object.values(DEGRADATION_FAILURES).flat(),
  ];

  /** Failure volume by method: how much of the merchant's *failure* comes from each rail. */
  const failureVolume = new Map<PaymentMethod, number>();
  for (const p of INDIA_PROFILES) {
    const key = p.slice.method;
    failureVolume.set(key, (failureVolume.get(key) ?? 0) + p.share * p.baseFailureRate);
  }

  /** Share of failures falling in each class, weighted by how much failure each method produces. */
  function classMix(table: typeof BASELINE_FAILURES): Map<RecoverabilityClass, number> {
    const totals = new Map<RecoverabilityClass, number>();
    let grand = 0;
    for (const [method, templates] of Object.entries(table)) {
      const methodWeight = failureVolume.get(method as PaymentMethod) ?? 0;
      const sum = templates.reduce((s, t) => s + t.weight, 0);
      for (const t of templates) {
        const w = (methodWeight * t.weight) / sum;
        const c = classify(t.detail).recoverability;
        totals.set(c, (totals.get(c) ?? 0) + w);
        grand += w;
      }
    }
    for (const [c, w] of totals) totals.set(c, w / grand);
    return totals;
  }

  it("classifies every failure the simulator can produce without falling to the residual", () => {
    // If the table cannot name the failures in our own traffic model, no measurement built on it
    // means anything — every casualty would land on the `unknown` ladder and the arm would be
    // measuring its fallback.
    const unclassified = everyTemplate
      .map((t) => ({ reason: t.detail.reason, result: classify(t.detail) }))
      .filter((x) => isResidual(x.result));

    expect(unclassified).toEqual([]);
  });

  it("finds a rail's failures change character completely when it breaks", () => {
    // The measured premise of the whole casualty arm, and the reason a fixed retry ladder wastes
    // most of what it spends. Weighted by how much failure each method actually produces:
    //
    //   healthy rail  — customer-retry 31%, timed 27%, transient 24%, customer-action 12%, dead 6%
    //   broken rail   — transient 100%
    //
    // A retry is a strategy for a quarter of ordinary failures and for all of an outage's. Knowing
    // which situation you are in is worth more than any improvement to the retry schedule itself.
    const healthy = classMix(BASELINE_FAILURES);
    const broken = classMix(DEGRADATION_FAILURES);

    expect(broken.get("transient")).toBeCloseTo(1, 6);
    expect(healthy.get("transient") ?? 0).toBeLessThan(0.3);
    expect((broken.get("transient") ?? 0) / (healthy.get("transient") ?? 1)).toBeGreaterThan(3);
  });

  it("finds the sixth class is the largest one on a healthy rail", () => {
    // The number that justifies adding `customer-retry` rather than folding it into `unknown`:
    // it is not a rounding error at the edge of the taxonomy, it is the single biggest bucket of
    // ordinary failure, and every other class would have described it wrongly.
    const healthy = classMix(BASELINE_FAILURES);
    const ranked = [...healthy.entries()].sort((a, b) => b[1] - a[1]);

    expect(ranked[0]?.[0]).toBe("customer-retry");
    expect(ranked[0]?.[1]).toBeGreaterThan(0.28);
  });

  it("finds almost nothing worth stopping on outright", () => {
    // `dead` is the class that forfeits money, so it should be small and it should be small for
    // named reasons rather than because the table shrugged.
    const healthy = classMix(BASELINE_FAILURES);
    expect(healthy.get("dead") ?? 0).toBeLessThan(0.1);
  });
});
