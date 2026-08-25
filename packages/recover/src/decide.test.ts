import {
  type ActionKind,
  type Casualty,
  casualtyId,
  customerRef,
  openCasualty,
  orderId,
  paise,
  type RecoverabilityClass,
  slice,
} from "@kairos/domain";
import { describe, expect, it } from "vitest";
import type { Classification } from "./classify.js";
import {
  DEFAULT_RECOVERY_CONFIG,
  decide,
  type RecoveryConfig,
  worstActionCostPaise,
} from "./decide.js";
import { RecoveryModel } from "./probability.js";

const AT = Date.UTC(2026, 7, 25, 4, 30);

/** Both off by default, so a test about economics is not perturbed by a detour or a holdout. */
const config: RecoveryConfig = {
  ...DEFAULT_RECOVERY_CONFIG,
  explorationRate: 0,
  controlFraction: 0,
};

function casualty(index: number, overrides: Partial<Casualty> = {}): Casualty {
  const base = openCasualty(
    {
      id: casualtyId(`cas_${index}`),
      kind: "payment-failed",
      customer: customerRef(`cus_${index.toString().padStart(12, "0")}`),
      orderId: orderId(`order_${index}`),
      attemptId: null,
      slice: slice("upi", "hdfc", "gpay"),
      amount: paise(120_000),
      failure: {
        code: "GATEWAY_ERROR",
        source: "bank",
        step: "payment_authorization",
        reason: "payment_timed_out_at_bank",
        description: "",
      },
      retry: "autonomous",
      occurredAt: AT,
    },
    "transient",
  );
  return { ...base, ...overrides };
}

const classification = (
  recoverability: RecoverabilityClass,
  confidence = 1,
  rule = "test-rule",
): Classification => ({ recoverability, rule, source: "table", confidence });

/** A model that has learned a definite rate for each action. */
function trainedWith(rates: Partial<Record<ActionKind, number>>): RecoveryModel {
  const model = new RecoveryModel();
  for (const [action, rate] of Object.entries(rates) as [ActionKind, number][]) {
    const hits = Math.round(rate * 400);
    for (let i = 0; i < 400; i++) {
      model.observe(
        {
          action,
          recoverability: "customer-action",
          confidence: 1,
          railHealthy: true,
          attemptOrdinal: 0,
        },
        i < hits,
      );
    }
  }
  return model;
}

/** A model that has learned the same definite rate for every action. */
function trained(rate: number): RecoveryModel {
  return trainedWith({
    retry: rate,
    "contact-sms": rate,
    "contact-whatsapp": rate,
    "contact-email": rate,
  });
}

/**
 * The order value at which one channel stops paying for itself, derived from the config.
 *
 * Computed rather than hard-coded so the assertions below are about the decision rule and not about
 * a number that would go stale the moment a price moved.
 */
function breakEvenPaise(
  kind: ActionKind,
  probability: number,
  contactsRecent: number,
  c: RecoveryConfig = config,
): number {
  const price = c.prices.find((p) => p.kind === kind);
  if (price === undefined) throw new Error(`no price for ${kind}`);
  const nuisance = price.optOutRate * (1 + c.optOutEscalation * contactsRecent) * c.optOutCostPaise;
  return (price.sendPaise + nuisance + c.minExpectedNetPaise) / (probability * c.margin);
}

describe("what is even on the table", () => {
  it("retries silently rather than messaging about a payment it can re-run", () => {
    // Spending money and goodwill to tell somebody about a charge the system can simply repeat.
    const d = decide(
      casualty(1, { retry: "autonomous" }),
      classification("transient"),
      trained(0.4),
      true,
      0,
      config,
    );
    expect(d.act).toBe(true);
    if (d.act) expect(d.action.kind).toBe("retry");
  });

  it("falls back to a message when there is nothing to charge again", () => {
    // The finding that reshapes the arm. Knowing the rail has healed is worth nothing if charging
    // again means asking the customer for a PIN.
    const d = decide(
      casualty(2, { retry: "requires-customer" }),
      classification("transient"),
      trained(0.4),
      true,
      0,
      config,
    );
    expect(d.act).toBe(true);
    if (d.act) expect(d.action.kind.startsWith("contact-")).toBe(true);
  });

  it("never proposes anything for a dead failure", () => {
    const d = decide(casualty(3), classification("dead"), trained(0.9), true, 0, config);
    expect(d.act).toBe(false);
  });

  it("never proposes anything for money that already arrived", () => {
    const recovered = casualty(4);
    const d = decide(
      { ...recovered, status: { ...recovered.status, recovered: true } },
      classification("transient"),
      trained(0.9),
      true,
      0,
      config,
    );
    expect(d.act).toBe(false);
    if (!d.act) expect(d.reason).toMatch(/already succeeded/);
  });
});

describe("the gate, and where it actually binds", () => {
  it("agrees with the break-even the prices imply, on both sides of it", () => {
    const model = trained(0.2);
    // Email is the cheapest channel, so it is the last one to stop clearing and therefore the one
    // that sets whether anything at all is worth doing.
    const threshold = breakEvenPaise("contact-email", 0.2, 0);

    const below = casualty(5, {
      retry: "requires-customer",
      amount: paise(Math.floor(threshold * 0.8)),
    });
    const above = casualty(6, {
      retry: "requires-customer",
      amount: paise(Math.ceil(threshold * 1.2)),
    });

    expect(decide(below, classification("customer-action"), model, true, 0, config).act).toBe(
      false,
    );
    expect(decide(above, classification("customer-action"), model, true, 0, config).act).toBe(true);
  });

  it("costs an order of magnitude more to send than the postage suggests", () => {
    // The finding. On Indian message prices an SMS pays for its own postage on any order above
    // about three rupees, so a gate priced on postage alone approves chasing everybody and is not a
    // gate at all. Pricing the chance of losing consent moves the bar roughly fifteen-fold.
    const postageOnly = { ...config, optOutCostPaise: 0, minExpectedNetPaise: 0 };
    const bare = breakEvenPaise("contact-sms", 0.2, 0, postageOnly);
    const real = breakEvenPaise("contact-sms", 0.2, 0);

    expect(bare).toBeLessThan(400);
    expect(real / bare).toBeGreaterThan(10);
  });

  it("picks the cheapest channel while it has no reason to prefer another", () => {
    // Not a flaw, but worth pinning down because it is the behaviour that makes exploration
    // necessary. With no evidence that any channel converts better, every comparison is decided by
    // price alone, so email wins forever and the others are never observed.
    const model = trained(0.2);
    const d = decide(
      casualty(8, { retry: "requires-customer", amount: paise(400_00) }),
      classification("customer-action"),
      model,
      true,
      0,
      config,
    );
    expect(d.act).toBe(true);
    if (d.act) expect(d.action.kind).toBe("contact-email");
  });

  it("moves to a cheaper channel before it stops entirely", () => {
    // What the escalating opt-out risk produces is not a cliff. Given a model that has learned SMS
    // converts better than email, a fresh customer is worth the expensive channel and one who has
    // had several messages is worth only the cheap one — long before either is worth nothing.
    const model = trainedWith({
      "contact-sms": 0.3,
      "contact-whatsapp": 0.22,
      "contact-email": 0.15,
    });
    const c = casualty(9, { retry: "requires-customer", amount: paise(100_00) });

    const fresh = decide(c, classification("customer-action"), model, true, 0, config);
    const weary = decide(c, classification("customer-action"), model, true, 5, config);

    expect(fresh.act).toBe(true);
    expect(weary.act).toBe(true);
    if (!fresh.act || !weary.act) return;

    expect(fresh.action.kind).toBe("contact-sms");
    expect(weary.action.kind).toBe("contact-email");
  });

  it("eventually stops even the cheapest channel", () => {
    const model = trained(0.2);
    const c = casualty(10, { retry: "requires-customer", amount: paise(30_00) });
    expect(decide(c, classification("customer-action"), model, true, 0, config).act).toBe(true);
    expect(decide(c, classification("customer-action"), model, true, 20, config).act).toBe(false);
  });

  it("passes an uncertain classification's doubt straight into the decision", () => {
    // Nothing here special-cases confidence. It moves the probability, the probability moves the
    // expected value, and a marginal casualty stops clearing the bar.
    const model = new RecoveryModel();
    for (let i = 0; i < 400; i++) {
      for (const action of ["contact-sms", "contact-whatsapp", "contact-email"] as const) {
        const f = { action, confidence: 1, railHealthy: true, attemptOrdinal: 0 };
        model.observe({ ...f, recoverability: "customer-action" }, i < 120);
        model.observe({ ...f, recoverability: "unknown" }, i < 8);
      }
    }

    const certainP = model.probability({
      action: "contact-email",
      recoverability: "customer-action",
      confidence: 1,
      railHealthy: true,
      attemptOrdinal: 0,
    });
    const doubtedP = model.probability({
      action: "contact-email",
      recoverability: "customer-action",
      confidence: 0.3,
      railHealthy: true,
      attemptOrdinal: 0,
    });
    expect(doubtedP).toBeLessThan(certainP);

    // Sized to sit between the two break-evens, so only the doubt separates them.
    const amount = Math.round(
      (breakEvenPaise("contact-email", certainP, 0) +
        breakEvenPaise("contact-email", doubtedP, 0)) /
        2,
    );
    const c = casualty(11, { retry: "requires-customer", amount: paise(amount) });

    expect(decide(c, classification("customer-action", 1), model, true, 0, config).act).toBe(true);
    expect(decide(c, classification("customer-action", 0.3), model, true, 0, config).act).toBe(
      false,
    );
  });
});

describe("what reaches Terminus", () => {
  it("reports the true money cost, not the priced-in opt-out risk", () => {
    // The budget must reconcile against money that actually leaves the account. A reservation held
    // for a cost nobody ever pays is a campaign that runs out of authority with money still in it.
    const d = decide(
      casualty(12, { retry: "requires-customer", amount: paise(400_00) }),
      classification("customer-action"),
      trained(0.3),
      true,
      0,
      config,
    );

    expect(d.act).toBe(true);
    if (!d.act) return;
    const price = config.prices.find((p) => p.kind === d.action.kind);
    expect(d.action.estimatedCost).toBe(price?.sendPaise);
    expect(d.action.expectedValue).toBe(Math.round(400_00 * config.margin));
    expect(d.expectedNetPaise).toBeLessThan(
      d.probability * d.action.expectedValue - d.action.estimatedCost,
    );
  });

  it("writes a rationale a merchant can read", () => {
    const d = decide(
      casualty(13, { retry: "requires-customer", amount: paise(400_00) }),
      classification("customer-action", 1, "card-expired"),
      trained(0.3),
      true,
      0,
      config,
    );
    expect(d.act).toBe(true);
    if (d.act) expect(d.action.rationale).toMatch(/card-expired \(customer-action\), p=0\.\d+/);
  });

  it("prices the worst any action can cost, for checking a mandate covers it", () => {
    expect(worstActionCostPaise(config)).toBe(60);
  });
});

describe("the recovery control arm", () => {
  it("leaves a stable tenth of casualties entirely alone", () => {
    // Open question 11. Some of these customers come back unprompted, and without a population
    // nobody touched, "we recovered 18%" is a number with no denominator.
    const withControl = { ...config, controlFraction: 0.1 };
    const model = trained(0.5);

    let controls = 0;
    for (let i = 0; i < 4000; i++) {
      const d = decide(
        casualty(i, { retry: "requires-customer", amount: paise(400_00) }),
        classification("customer-action"),
        model,
        true,
        0,
        withControl,
      );
      if (!d.act && d.reason.includes("control")) controls++;
    }

    expect(controls / 4000).toBeGreaterThan(0.085);
    expect(controls / 4000).toBeLessThan(0.115);
  });

  it("assigns the same casualty to the same arm every time it is asked", () => {
    const withControl = { ...config, controlFraction: 0.5 };
    const model = trained(0.5);
    const c = casualty(77, { retry: "requires-customer", amount: paise(400_00) });

    const first = decide(c, classification("customer-action"), model, true, 0, withControl);
    for (let i = 0; i < 20; i++) {
      expect(decide(c, classification("customer-action"), model, true, 0, withControl).act).toBe(
        first.act,
      );
    }
  });
});

describe("exploration", () => {
  it("tries the channels the model does not favour, at roughly the configured rate", () => {
    // Without this the cheapest channel wins every cold-start comparison, collects all the
    // evidence, and the rest are never observed — a model that is right about the one thing it
    // ever does.
    const exploring = { ...config, explorationRate: 0.1 };
    const model = trained(0.4);

    let explored = 0;
    const chosen = new Set<string>();
    for (let i = 0; i < 3000; i++) {
      const d = decide(
        casualty(i, { retry: "requires-customer", amount: paise(400_00) }),
        classification("customer-action"),
        model,
        true,
        0,
        exploring,
      );
      if (d.act) {
        chosen.add(d.action.kind);
        if (d.exploring) explored++;
      }
    }

    expect(explored / 3000).toBeGreaterThan(0.085);
    expect(explored / 3000).toBeLessThan(0.115);
    expect(chosen.size).toBe(3);
  });

  it("never explores into an action that does not clear the gate", () => {
    // Learning is paid for out of spending the merchant had already agreed was worthwhile.
    const exploring = { ...config, explorationRate: 0.9 };
    const model = trained(0.4);

    for (let i = 0; i < 200; i++) {
      const d = decide(
        casualty(1000 + i, { retry: "requires-customer", amount: paise(45_00) }),
        classification("customer-action"),
        model,
        true,
        0,
        exploring,
      );
      if (d.act) expect(d.expectedNetPaise).toBeGreaterThan(exploring.minExpectedNetPaise);
    }
  });

  it("is off when it is configured off", () => {
    const model = trained(0.4);
    for (let i = 0; i < 200; i++) {
      const d = decide(
        casualty(i, { retry: "requires-customer", amount: paise(400_00) }),
        classification("customer-action"),
        model,
        true,
        0,
        config,
      );
      if (d.act) expect(d.exploring).toBe(false);
    }
  });
});

describe("rail health reaches the decision", () => {
  it("declines on a broken rail what it would take on a healed one", () => {
    const model = new RecoveryModel();
    const f = {
      action: "retry" as const,
      recoverability: "transient" as const,
      confidence: 1,
      attemptOrdinal: 0,
    };
    for (let i = 0; i < 500; i++) {
      model.observe({ ...f, railHealthy: true }, i < 300);
      model.observe({ ...f, railHealthy: false }, i < 5);
    }

    const c = casualty(30, { retry: "autonomous", amount: paise(50_00) });
    expect(decide(c, classification("transient"), model, true, 0, config).act).toBe(true);
    expect(decide(c, classification("transient"), model, false, 0, config).act).toBe(false);
  });
});
