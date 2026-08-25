import { describe, expect, it } from "vitest";
import {
  expectedNetValue,
  isActionKind,
  isContact,
  isWorthDoing,
  type ProposedAction,
} from "./action.js";
import { BINDING_AXES, isBindingAxis, isStopReason, STOP_REASONS } from "./admission.js";
import { type Attempt, isFailure, isResolved, isRetryable } from "./attempt.js";
import { DomainError } from "./brand.js";
import {
  attemptId,
  casualtyId,
  customerRef,
  incidentId,
  mandateId,
  orderId,
} from "./identifiers.js";
import { detectionLatencyMs, type Incident, incidentDurationMs, isActive } from "./incident.js";
import { paise } from "./money.js";
import { slice } from "./slice.js";

describe("DomainError", () => {
  it("prefixes the field so a failure points at its cause", () => {
    const err = new DomainError("budgetPaise", "must be positive");
    expect(err.message).toBe("budgetPaise: must be positive");
    expect(err.field).toBe("budgetPaise");
    expect(err.name).toBe("DomainError");
    expect(err).toBeInstanceOf(Error);
  });
});

describe("identifiers", () => {
  it("accepts well-formed ids", () => {
    expect(attemptId("pay_29QQoUBi66xm2f")).toBe("pay_29QQoUBi66xm2f");
    expect(orderId("order_9A33XWu")).toBe("order_9A33XWu");
    expect(incidentId("inc_01")).toBe("inc_01");
    expect(casualtyId("cas_01")).toBe("cas_01");
    expect(mandateId("mnd_01")).toBe("mnd_01");
  });

  it("rejects empty ids", () => {
    expect(() => attemptId("")).toThrow(DomainError);
  });

  it("requires a customer reference long enough to be a hash, not a phone number", () => {
    expect(() => customerRef("9876543210")).toThrow(DomainError);
    expect(customerRef("a3f9c1e70b4d28617f5c")).toBe("a3f9c1e70b4d28617f5c");
  });
});

describe("attempt predicates", () => {
  const base: Attempt = {
    id: attemptId("pay_1"),
    orderId: orderId("order_1"),
    customer: customerRef("a3f9c1e70b4d28617f5c"),
    amount: paise(499_00),
    slice: slice("upi", "hdfc", "phonepe"),
    status: "captured",
    failure: null,
    at: 1_756_000_000_000,
  };

  it("counts only failures as failures", () => {
    expect(isFailure({ ...base, status: "failed" })).toBe(true);
    expect(isFailure(base)).toBe(false);
    expect(isFailure({ ...base, status: "authorized" })).toBe(false);
  });

  it("excludes unresolved attempts, which are evidence of neither outcome", () => {
    expect(isResolved({ ...base, status: "created" })).toBe(false);
    expect(isResolved({ ...base, status: "failed" })).toBe(true);
    expect(isResolved(base)).toBe(true);
  });

  it("treats only transient and timed failures as retryable", () => {
    expect(isRetryable("transient")).toBe(true);
    expect(isRetryable("timed")).toBe(true);
    expect(isRetryable("customer-action")).toBe(false);
    expect(isRetryable("dead")).toBe(false);
    expect(isRetryable("unknown")).toBe(false);
  });
});

describe("incident", () => {
  const base: Incident = {
    id: incidentId("inc_1"),
    slice: slice("upi", "hdfc"),
    onsetAt: 1_000_000,
    detectedAt: 1_192_000,
    resolvedAt: null,
    state: "open",
    baselineFailureRate: 0.042,
    peakFailureRate: 0.34,
    gatewayDeclaredAt: null,
  };

  it("treats open and clearing as active", () => {
    expect(isActive(base)).toBe(true);
    expect(isActive({ ...base, state: "clearing" })).toBe(true);
    expect(isActive({ ...base, state: "resolved" })).toBe(false);
  });

  it("measures detection latency from onset, not from first observation", () => {
    expect(detectionLatencyMs(base)).toBe(192_000);
  });

  it("never reports negative latency if detection precedes the estimated onset", () => {
    expect(detectionLatencyMs({ ...base, detectedAt: base.onsetAt - 5_000 })).toBe(0);
  });

  it("measures duration to resolution, or to now while still running", () => {
    expect(incidentDurationMs({ ...base, resolvedAt: 3_400_000 }, 9_000_000)).toBe(2_400_000);
    expect(incidentDurationMs(base, 2_500_000)).toBe(1_500_000);
  });
});

describe("action", () => {
  const base: ProposedAction = {
    kind: "contact-sms",
    customer: customerRef("a3f9c1e70b4d28617f5c"),
    casualty: casualtyId("cas_1"),
    incident: null,
    estimatedCost: paise(25),
    expectedValue: paise(499_00),
    successProbability: 0.22,
    rationale: "card expired; fix-link is the only path that can succeed",
  };

  it("recognises the closed action vocabulary and nothing outside it", () => {
    expect(isActionKind("retry")).toBe(true);
    expect(isActionKind("steer")).toBe(true);
    expect(isActionKind("wire-transfer")).toBe(false);
    expect(isActionKind("")).toBe(false);
  });

  it("counts only person-reaching actions against a contact cap", () => {
    expect(isContact("contact-sms")).toBe(true);
    expect(isContact("contact-whatsapp")).toBe(true);
    expect(isContact("contact-email")).toBe(true);
    expect(isContact("retry")).toBe(false);
    expect(isContact("steer")).toBe(false);
    expect(isContact("escalate")).toBe(false);
  });

  it("acts only when probability-weighted return beats cost", () => {
    expect(isWorthDoing(base)).toBe(true);
    expect(isWorthDoing({ ...base, successProbability: 0 })).toBe(false);
    expect(isWorthDoing({ ...base, expectedValue: paise(100), successProbability: 0.1 })).toBe(
      false,
    );
  });

  it("declines at exactly break-even rather than acting for no margin", () => {
    const breakEven: ProposedAction = {
      ...base,
      estimatedCost: paise(100),
      expectedValue: paise(1000),
      successProbability: 0.1,
    };
    expect(expectedNetValue(breakEven)).toBe(0);
    expect(isWorthDoing(breakEven)).toBe(false);
  });

  it("reports the margin, including when negative", () => {
    expect(expectedNetValue(base)).toBeCloseTo(0.22 * 49_900 - 25, 6);
    expect(expectedNetValue({ ...base, successProbability: 0 })).toBe(-25);
  });
});

describe("admission vocabulary", () => {
  it("recognises every axis it publishes", () => {
    for (const axis of BINDING_AXES) expect(isBindingAxis(axis)).toBe(true);
  });

  it("rejects an axis it does not publish", () => {
    // The ledger and the console read this enum. A typo that silently passed would produce a
    // refusal reason nothing downstream knows how to render.
    expect(isBindingAxis("vibes")).toBe(false);
  });

  it("recognises every stop reason it publishes", () => {
    for (const reason of STOP_REASONS) expect(isStopReason(reason)).toBe(true);
    expect(isStopReason("bored")).toBe(false);
  });

  it("keeps the two vocabularies disjoint", () => {
    // A stop reason is terminal and an axis is a moment; conflating them in a query would silently
    // report a permanently dead casualty as one that might succeed later.
    const axes = new Set<string>(BINDING_AXES);
    for (const reason of STOP_REASONS) expect(axes.has(reason)).toBe(false);
  });
});
