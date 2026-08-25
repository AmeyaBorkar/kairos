import {
  applyOutcome,
  type Casualty,
  casualtyId,
  customerRef,
  openCasualty,
  orderId,
  paise,
  type QuietHours,
  type RecoverabilityClass,
  type RecoveryAttempt,
  type Slice,
  slice,
  sliceKey,
} from "@kairos/domain";
import { describe, expect, it } from "vitest";
import type { Classification } from "./classify.js";
import {
  DEFAULT_SCHEDULE_CONFIG,
  needsCustomer,
  nextBalanceLikelyMoment,
  type RailGauge,
  schedule,
} from "./schedule.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Monday 25 August 2026, 10:00 IST — a plain weekday morning, nowhere near a salary date. */
const AT = Date.UTC(2026, 7, 25, 4, 30);

const UPI_HDFC = slice("upi", "hdfc", "gpay");

const IST_NIGHT: QuietHours = { startMinute: 21 * 60, endMinute: 8 * 60, offsetMinutes: 330 };

function gauge(degraded: readonly Slice[] = [], recovered = new Map<string, number>()): RailGauge {
  const broken = new Set(degraded.map(sliceKey));
  return {
    isDegraded: (s) => broken.has(sliceKey(s)),
    recoveredAt: (s) => recovered.get(sliceKey(s)) ?? null,
  };
}

function casualty(overrides: Partial<Casualty> = {}): Casualty {
  const base = openCasualty(
    {
      id: casualtyId("cas_1"),
      kind: "payment-failed",
      customer: customerRef("cus_000000000001"),
      orderId: orderId("order_1"),
      attemptId: null,
      slice: UPI_HDFC,
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
  rule = "test-rule",
): Classification => ({ recoverability, rule, source: "table", confidence: 1 });

const attempt = (o: Partial<RecoveryAttempt> = {}): RecoveryAttempt => ({
  kind: "retry",
  at: AT + MINUTE,
  outcome: "declined-soft",
  costPaise: paise(0),
  externalRef: null,
  ...o,
});

const run = (
  c: Casualty,
  klass: RecoverabilityClass,
  now: number,
  g: RailGauge = gauge(),
  quiet: QuietHours | null = null,
) => schedule(c, classification(klass), now, g, quiet);

describe("stopping", () => {
  it("stops on everything that is terminal", () => {
    const recovered = { ...casualty(), status: { ...casualty().status, recovered: true } };
    const optedOut = { ...casualty(), status: { ...casualty().status, optedOut: true } };
    const disputed = { ...casualty(), status: { ...casualty().status, disputed: true } };

    expect(run(recovered, "transient", AT).dueAt).toBeNull();
    expect(run(optedOut, "transient", AT).dueAt).toBeNull();
    expect(run(disputed, "transient", AT).dueAt).toBeNull();
    expect(run(casualty(), "dead", AT).dueAt).toBeNull();
  });

  it("says why in a sentence a merchant can read", () => {
    expect(run(casualty(), "dead", AT).reason).toMatch(/cannot be recovered/);
  });
});

describe("transient — waiting for the rail", () => {
  it("polls rather than firing while the rail is still broken", () => {
    const s = run(casualty(), "transient", AT + MINUTE, gauge([UPI_HDFC]));
    expect(s.trigger).toBe("rail-recovery");
    expect(s.dueAt).toBe(AT + MINUTE + DEFAULT_SCHEDULE_CONFIG.railRecheckMs);
  });

  it("fires on the recovery edge, once the rail has held", () => {
    // The `kairos` case in one assertion. Not +1h, not +24h: the moment the thing that broke stops
    // being broken, plus long enough to be sure it stopped.
    const healedAt = AT + 20 * MINUTE;
    const s = run(
      casualty(),
      "transient",
      healedAt + MINUTE,
      gauge([], new Map([[sliceKey(UPI_HDFC), healedAt]])),
    );

    expect(s.trigger).toBe("rail-recovery");
    expect(s.dueAt).toBe(healedAt + DEFAULT_SCHEDULE_CONFIG.railSettleMs);
  });

  it("does not stampede a gateway that came back one second ago", () => {
    // Every casualty waiting on a rail becomes due at the same instant it clears. The settle delay
    // is a queue-shaped concern, not a second copy of the detector's hysteresis.
    const healedAt = AT + 20 * MINUTE;
    const s = run(
      casualty(),
      "transient",
      healedAt,
      gauge([], new Map([[sliceKey(UPI_HDFC), healedAt]])),
    );
    expect(s.dueAt).toBeGreaterThan(healedAt);
  });

  it("acts at once when the rail is healthy and was never seen to break", () => {
    // Classified transient from an error code rather than from an incident, so there is no edge to
    // wait for and waiting would be waiting for nothing.
    const s = run(casualty(), "transient", AT + MINUTE, gauge());
    expect(s.trigger).toBe("immediate");
    expect(s.dueAt).toBe(AT + MINUTE);
  });

  it("stops calling it transient once the rail has been down all afternoon", () => {
    // A rail down for six hours is not having a transient problem, whatever the error code said.
    const late = AT + DEFAULT_SCHEDULE_CONFIG.railPatienceMs + MINUTE;
    const s = run(casualty(), "transient", late, gauge([UPI_HDFC]));
    expect(s.trigger).toBe("immediate");
    expect(s.reason).toMatch(/too long/);
  });

  it("spends the ladder and stops", () => {
    let c = casualty();
    for (let i = 0; i < DEFAULT_SCHEDULE_CONFIG.maxRetries; i++) {
      c = applyOutcome(c, attempt({ at: AT + i * HOUR }));
    }
    expect(run(c, "transient", AT + 10 * HOUR).dueAt).toBeNull();
  });

  it("keeps a minimum gap between two attempts on the same casualty", () => {
    const c = applyOutcome(casualty(), attempt({ at: AT + 5 * MINUTE }));
    const s = run(c, "transient", AT + 6 * MINUTE, gauge());
    expect(s.dueAt).toBe(AT + 5 * MINUTE + DEFAULT_SCHEDULE_CONFIG.minBackoffMs);
  });
});

describe("timed — waiting for money", () => {
  it("aims at a salary date rather than at a fixed offset", () => {
    // The other half of scheduling on the cause. A retry at +24h from 25 August lands on the 26th,
    // which is not a moment anyone is more likely to have money than the day before.
    const s = run(casualty(), "timed", AT);
    expect(s.trigger).toBe("balance-likely");

    const due = new Date((s.dueAt ?? 0) + DEFAULT_SCHEDULE_CONFIG.offsetMinutes * MINUTE);
    expect(due.getUTCDate()).toBe(31);
    expect(due.getUTCHours()).toBe(DEFAULT_SCHEDULE_CONFIG.balanceLikelyHourLocal);
  });

  it("rolls into the next month when the salary dates have passed", () => {
    const afterTheSeventh = Date.UTC(2026, 8, 8, 4, 30);
    const s = run(casualty({ occurredAt: afterTheSeventh }), "timed", afterTheSeventh);
    const due = new Date((s.dueAt ?? 0) + DEFAULT_SCHEDULE_CONFIG.offsetMinutes * MINUTE);
    expect(due.getUTCMonth()).toBe(8);
    expect(due.getUTCDate()).toBe(30);
  });

  it("gives up when the money has not arrived in a month", () => {
    const c = casualty();
    const late = AT + DEFAULT_SCHEDULE_CONFIG.balancePatienceMs + DAY;
    expect(run(c, "timed", late).dueAt).toBeNull();
  });

  it("never proposes a moment in the past", () => {
    for (const day of [1, 2, 7, 15, 28, 30, 31]) {
      const at = Date.UTC(2026, 0, day, 12, 0);
      expect(nextBalanceLikelyMoment(at, DEFAULT_SCHEDULE_CONFIG)).toBeGreaterThan(at);
    }
  });

  it("falls back to the horizon rather than lying when no day qualifies", () => {
    const config = {
      ...DEFAULT_SCHEDULE_CONFIG,
      balanceLikelyDaysOfMonth: [],
      includeLastDayOfMonth: false,
    };
    expect(nextBalanceLikelyMoment(AT, config)).toBe(AT + config.balancePatienceMs);
  });
});

describe("customer-action — a bounded ladder", () => {
  it("walks the rungs and then stops", () => {
    const ladder = DEFAULT_SCHEDULE_CONFIG.contactLadderMs;
    let c = casualty({ retry: "requires-customer" });

    for (const [rung, offset] of ladder.entries()) {
      const s = run(c, "customer-action", AT + offset + HOUR);
      expect(s.dueAt).not.toBeNull();
      expect(s.reason).toMatch(new RegExp(`rung ${rung + 1} of ${ladder.length}`));
      c = applyOutcome(c, attempt({ kind: "contact-sms", outcome: "delivered", at: AT + offset }));
    }

    expect(run(c, "customer-action", AT + 10 * DAY).dueAt).toBeNull();
  });
});

describe("customer-retry — exactly one ask", () => {
  it("asks once and never again", () => {
    // The difference between a recovery system and a nuisance, and the reason the sixth class is
    // not folded into customer-action.
    const first = run(casualty({ retry: "requires-customer" }), "customer-retry", AT + HOUR);
    expect(first.dueAt).not.toBeNull();

    const asked = applyOutcome(
      casualty({ retry: "requires-customer" }),
      attempt({ kind: "contact-sms", outcome: "delivered", at: AT + HOUR }),
    );
    expect(run(asked, "customer-retry", AT + 3 * DAY).dueAt).toBeNull();
  });

  it("treats an unclassifiable failure the same way", () => {
    const asked = applyOutcome(
      casualty({ retry: "requires-customer" }),
      attempt({ kind: "contact-email", outcome: "delivered", at: AT + HOUR }),
    );
    expect(run(asked, "unknown", AT + 3 * DAY).dueAt).toBeNull();
  });
});

describe("the spontaneous window", () => {
  it("lets a customer come back unprompted before spending anything on them", () => {
    // Some of these people were already reaching for another card. A nudge sent ninety seconds
    // after a cancelled payment is largely paid for by recoveries that would have happened anyway,
    // and the harness's control arm is what turns that from an opinion into a number.
    const s = run(casualty({ retry: "requires-customer" }), "customer-retry", AT + MINUTE);
    expect(s.trigger).toBe("spontaneous-window");
    expect(s.dueAt).toBe(AT + DEFAULT_SCHEDULE_CONFIG.spontaneousWindowMs);
  });

  it("does not delay a retry nobody will notice", () => {
    // A silent charge against a token disturbs no one, so there is nothing to wait out. The window
    // exists to avoid wasting a *message*, not to avoid acting.
    const s = run(casualty({ retry: "autonomous" }), "transient", AT + MINUTE, gauge());
    expect(s.dueAt).toBe(AT + MINUTE);
  });

  it("applies once, not before every rung", () => {
    const c = applyOutcome(
      casualty({ retry: "requires-customer" }),
      attempt({ kind: "contact-sms", outcome: "delivered", at: AT + HOUR }),
    );
    const s = run(c, "customer-action", AT + DAY + HOUR);
    expect(s.trigger).toBe("ladder");
  });
});

describe("quiet hours", () => {
  it("arrives at the end of the window instead of waking a worker at three in the morning", () => {
    // Terminus refuses a contact inside the window regardless, so this is not the bound. It is the
    // difference between a worker that wakes, is refused, and requeues, and one that simply waits.
    const night = Date.UTC(2026, 7, 24, 20, 0); // 01:30 IST
    const c = casualty({ retry: "requires-customer", occurredAt: night - HOUR });
    const s = run(c, "customer-retry", night, gauge(), IST_NIGHT);

    const due = new Date((s.dueAt ?? 0) + 330 * MINUTE);
    expect(due.getUTCHours()).toBe(8);
    expect(s.reason).toMatch(/do-not-disturb/);
  });

  it("leaves a silent retry alone at three in the morning", () => {
    // A retry against a token is a server-to-server call. Deferring it would cost the merchant the
    // recovery edge for the sake of a customer who is asleep and unaffected either way.
    const night = Date.UTC(2026, 7, 24, 20, 0);
    const c = casualty({ retry: "autonomous", occurredAt: night - HOUR });
    const s = run(c, "transient", night, gauge(), IST_NIGHT);
    expect(s.dueAt).toBe(night);
  });
});

describe("needsCustomer", () => {
  it("is true for every class a bare retry cannot fix", () => {
    for (const klass of ["customer-action", "customer-retry", "unknown", "dead"] as const) {
      expect(needsCustomer(casualty({ retry: "autonomous" }), classification(klass))).toBe(true);
    }
  });

  it("is true for a retryable class with nothing to retry against", () => {
    // The finding that reshapes the arm: knowing the rail has healed is worth nothing if charging
    // again means asking the customer for a PIN.
    expect(
      needsCustomer(casualty({ retry: "requires-customer" }), classification("transient")),
    ).toBe(true);
    expect(needsCustomer(casualty({ retry: "autonomous" }), classification("transient"))).toBe(
      false,
    );
  });
});
