import {
  type Casualty,
  casualtyId,
  customerRef,
  type FailureDetail,
  mandateId,
  openCasualty,
  orderId,
  paise,
  slice,
} from "@kairos/domain";
import { FailingLedger, MemoryLedger } from "@kairos/ledger";
import { ManualClock, sealMandate, Terminus } from "@kairos/terminus";
import { MemoryStore } from "throttlekit";
import { describe, expect, it } from "vitest";
import { classify } from "./classify.js";
import { DEFAULT_RECOVERY_CONFIG, type RecoveryConfig } from "./decide.js";
import { RecoveryModel } from "./probability.js";
import type { RailGauge } from "./schedule.js";
import { type CustomerDirectory, MemoryCasualtyStore } from "./store.js";
import {
  classificationOf,
  type ExecuteRequest,
  type ExecuteResult,
  type Executor,
  RecoverWorker,
} from "./worker.js";

const SECRET = "a-secret-that-lives-in-a-vault-not-a-repo";
const AT = Date.UTC(2026, 7, 25, 6, 0, 0);
const DAY = 86_400_000;

const BANK_TIMEOUT: FailureDetail = {
  code: "GATEWAY_ERROR",
  source: "bank",
  step: "payment_authorization",
  reason: "payment_timed_out_at_bank",
  description: "Bank did not respond in time",
};

const CARD_EXPIRED: FailureDetail = {
  code: "BAD_REQUEST_ERROR",
  source: "customer",
  step: "payment_initiation",
  reason: "card_expired",
  description: "The card has expired",
};

function mandate(overrides: Record<string, unknown> = {}) {
  return sealMandate(
    {
      id: mandateId("mnd_recover"),
      merchantId: "acme",
      campaignId: "recovery",
      budgetPaise: paise(500_00),
      maxActionCostPaise: paise(60),
      maxInFlight: 8,
      reservationTtlMs: 60_000,
      contactCap: { limit: 3, windowMs: 7 * DAY },
      quietHours: null,
      allowedActions: ["retry", "contact-sms", "contact-whatsapp", "contact-email"] as const,
      validFrom: AT - DAY,
      validUntil: AT + 90 * DAY,
      killSwitch: false,
      ...overrides,
    },
    SECRET,
  );
}

function casualty(index: number, overrides: Partial<Casualty> = {}): Casualty {
  const failure = overrides.failure === undefined ? BANK_TIMEOUT : overrides.failure;
  const base = openCasualty(
    {
      id: casualtyId(`cas_${index}`),
      kind: "payment-failed",
      customer: customerRef(`cus_${index.toString().padStart(12, "0")}`),
      orderId: orderId(`order_${index}`),
      attemptId: null,
      slice: slice("upi", "hdfc", "gpay"),
      amount: paise(400_00),
      failure,
      retry: "requires-customer",
      occurredAt: AT - DAY,
      ...overrides,
      ...(overrides.failure === undefined ? {} : { failure }),
    },
    classify(failure).recoverability,
  );
  return { ...base, ...overrides, failure, status: base.status, attempts: base.attempts };
}

function gauge(degraded: readonly string[] = []): RailGauge {
  const broken = new Set(degraded);
  return {
    isDegraded: (s) => broken.has(s.issuer ?? ""),
    recoveredAt: () => null,
  };
}

const directory: CustomerDirectory = {
  lookup: () => Promise.resolve({ firstName: "Rohit", token: "token_1", language: "en" }),
};

/** Records every execution and returns whatever the test told it to. */
function executor(
  reply: (request: ExecuteRequest) => ExecuteResult | Promise<ExecuteResult>,
): Executor & { readonly calls: ExecuteRequest[] } {
  const calls: ExecuteRequest[] = [];
  return {
    calls,
    execute: async (request) => {
      calls.push(request);
      return await reply(request);
    },
  };
}

const delivered = (costPaise = 20): ExecuteResult => ({
  outcome: "delivered",
  costPaise,
  externalRef: "sms_1",
  optedOut: false,
});

const recovered = (costPaise = 20): ExecuteResult => ({
  outcome: "recovered",
  costPaise,
  externalRef: "pay_1",
  optedOut: false,
});

interface Harness {
  readonly worker: RecoverWorker;
  readonly store: MemoryCasualtyStore;
  readonly terminus: Terminus;
  readonly clock: ManualClock;
  readonly ledger: MemoryLedger;
  readonly executed: ExecuteRequest[];
}

/** An audit sink that starts working and then stops. */
class FlakyLedger {
  readonly inner = new FailingLedger(false);
  #appends = 0;
  failFrom = Number.POSITIVE_INFINITY;

  append(record: Parameters<FailingLedger["append"]>[0]): Promise<void> {
    this.#appends++;
    this.inner.failing = this.#appends >= this.failFrom;
    return this.inner.append(record);
  }

  get appends(): number {
    return this.#appends;
  }
}

function harness(
  options: {
    reply?: (request: ExecuteRequest) => ExecuteResult | Promise<ExecuteResult>;
    mandateOverrides?: Record<string, unknown>;
    config?: Partial<RecoveryConfig>;
    degraded?: readonly string[];
    model?: RecoveryModel;
    directory?: CustomerDirectory;
  } = {},
): Harness {
  const clock = new ManualClock(AT);
  const ledger = new MemoryLedger();
  const terminus = new Terminus({
    mandate: mandate(options.mandateOverrides),
    secret: SECRET,
    store: new MemoryStore(),
    audit: ledger,
    actor: "recover-worker/test",
    clock,
  });
  const store = new MemoryCasualtyStore();
  const exec = executor(options.reply ?? (() => delivered()));

  const worker = new RecoverWorker({
    terminus,
    store,
    directory: options.directory ?? directory,
    gauge: gauge(options.degraded),
    model: options.model ?? trained(0.4),
    executor: exec,
    clock,
    config: {
      ...DEFAULT_RECOVERY_CONFIG,
      controlFraction: 0,
      explorationRate: 0,
      ...options.config,
    },
  });

  return { worker, store, terminus, clock, ledger, executed: exec.calls };
}

function trained(rate: number): RecoveryModel {
  const model = new RecoveryModel();
  const hits = Math.round(rate * 400);
  for (const action of ["retry", "contact-sms", "contact-whatsapp", "contact-email"] as const) {
    for (const recoverability of ["transient", "customer-action", "customer-retry"] as const) {
      for (let i = 0; i < 400; i++) {
        model.observe(
          { action, recoverability, confidence: 1, railHealthy: true, attemptOrdinal: 0 },
          i < hits,
        );
      }
    }
  }
  return model;
}

describe("one pass", () => {
  it("acts on a casualty that is due and worth chasing", async () => {
    const h = harness();
    await h.store.save(casualty(1), AT);

    const report = await h.worker.drain();

    expect(report.considered).toBe(1);
    expect(report.acted).toBe(1);
    expect(h.executed).toHaveLength(1);
    expect(h.executed[0]?.grant.action.customer).toBe(casualty(1).customer);
  });

  it("ignores a casualty that is not due yet", async () => {
    const h = harness();
    await h.store.save(casualty(1), AT + DAY);
    expect((await h.worker.drain()).considered).toBe(0);
  });

  it("resolves the customer's name exactly once, at the boundary", async () => {
    // The PII line. Everything upstream handles a keyed hash; this is the single place a real name
    // is fetched, and it is handed to the executor rather than looked up again downstream.
    let lookups = 0;
    const counting: CustomerDirectory = {
      lookup: () => {
        lookups++;
        return Promise.resolve({ firstName: "Priya", token: null, language: "hi" });
      },
    };
    const h = harness({ directory: counting });
    await h.store.save(casualty(1), AT);
    await h.worker.drain();

    expect(lookups).toBe(1);
    expect(h.executed[0]?.firstName).toBe("Priya");
  });

  it("sends a message addressed impersonally when the directory is unreachable", async () => {
    // A directory that cannot be read costs a first name, not a recovery.
    const broken: CustomerDirectory = { lookup: () => Promise.reject(new Error("down")) };
    const h = harness({ directory: broken });
    await h.store.save(casualty(1), AT);

    expect((await h.worker.drain()).acted).toBe(1);
    expect(h.executed[0]?.firstName).toBeNull();
  });
});

describe("the lease", () => {
  it("stops a second worker acting on a casualty the first is holding", async () => {
    // Terminus's authority is idempotent on its action key, so a crashed worker replays into the
    // same reservation rather than taking a second — but two *live* workers derive the same key and
    // are handed the same grant, and both would send. This is what makes the fleet safe.
    const h = harness();
    await h.store.save(casualty(1), AT);

    const claimed = await h.store.claim(casualtyId("cas_1"), AT, AT + 60_000);
    expect(claimed).toBe(true);

    expect((await h.worker.drain()).considered).toBe(0);
    expect(h.executed).toHaveLength(0);
  });

  it("releases a casualty a dead worker was holding", async () => {
    const h = harness();
    await h.store.save(casualty(1), AT);
    await h.store.claim(casualtyId("cas_1"), AT, AT + 60_000);

    h.clock.set(AT + 61_000);
    expect((await h.worker.drain()).acted).toBe(1);
  });
});

describe("what Terminus refuses", () => {
  it("does nothing at all when the kill switch is engaged", async () => {
    const h = harness({ mandateOverrides: { killSwitch: true } });
    await h.store.save(casualty(1), AT);

    const report = await h.worker.drain();
    expect(report.acted).toBe(0);
    expect(report.refusalsByAxis["kill-switch"]).toBe(1);
    expect(h.executed).toHaveLength(0);
  });

  it("stops chasing one customer once their contact cap is spent", async () => {
    const h = harness({ mandateOverrides: { contactCap: { limit: 2, windowMs: 7 * DAY } } });
    const customer = customerRef("cus_000000000042");

    for (let i = 0; i < 5; i++) {
      await h.store.save(casualty(i, { customer, id: casualtyId(`cas_${i}`) }), AT);
    }

    const report = await h.worker.drain();
    expect(report.acted).toBe(2);
    expect(report.refusalsByAxis["contact-cap"]).toBe(3);
  });

  it("stops when the budget runs out, and says so", async () => {
    const h = harness({ mandateOverrides: { budgetPaise: paise(120) } });
    for (let i = 0; i < 12; i++) await h.store.save(casualty(i), AT);

    const report = await h.worker.drain();
    expect(report.spentPaise).toBeLessThanOrEqual(120);
    expect(report.refusalsByAxis["budget"]).toBeGreaterThan(0);
  });

  it("never touches a casualty whose customer opted out", async () => {
    const h = harness();
    const c = casualty(1);
    await h.store.save({ ...c, status: { ...c.status, optedOut: true } }, AT);

    const report = await h.worker.drain();
    expect(report.acted).toBe(0);
    expect(h.executed).toHaveLength(0);
  });

  it("comes back to a casualty a transient refusal blocked", async () => {
    // A budget refusal while other actions are in flight clears when they reconcile. Reporting it
    // the same way as a terminal one makes a worker give up on a campaign that could still run.
    const h = harness({ mandateOverrides: { budgetPaise: paise(40), maxInFlight: 2 } });
    for (let i = 0; i < 6; i++) await h.store.save(casualty(i), AT);

    await h.worker.drain();
    const rescheduled = h.store.all().filter((c) => c.attempts.length === 0);
    expect(rescheduled.length).toBeGreaterThan(0);
  });
});

describe("reconciliation", () => {
  it("settles what an action actually cost, not what it reserved", async () => {
    // The worst-case sizer reserves the mandate's ceiling; a one-segment SMS costs a third of it.
    // The difference is released rather than spent, which is what keeps a lifetime budget usable.
    const h = harness({ reply: () => delivered(20) });
    await h.store.save(casualty(1), AT);
    await h.worker.drain();

    const snapshot = await h.terminus.snapshot();
    expect(snapshot.settledPaise).toBe(20);
    expect(snapshot.committedPaise).toBe(0);
  });

  it("hands the authority back when the action throws", async () => {
    // Nothing was spent, but the reservation is still held, and a held reservation refuses other
    // workers on the concurrency axis until its TTL expires.
    const h = harness({
      reply: () => {
        throw new Error("the messaging provider returned 503");
      },
    });
    await h.store.save(casualty(1), AT);

    const report = await h.worker.drain();
    expect(report.acted).toBe(0);
    expect(report.refusalsByAxis["execution"]).toBe(1);

    const snapshot = await h.terminus.snapshot();
    expect(snapshot.committedPaise).toBe(0);
    expect(snapshot.settledPaise).toBe(0);
  });

  it("leaves nothing in flight after a pass, whatever happened", async () => {
    const h = harness({
      reply: (request) => {
        if (request.casualty.id.endsWith("3")) throw new Error("boom");
        return delivered();
      },
    });
    for (let i = 0; i < 8; i++) await h.store.save(casualty(i), AT);

    await h.worker.drain();
    const snapshot = await h.terminus.snapshot();
    expect(snapshot.inFlight).toBe(0);
    expect(snapshot.orphanCount).toBe(0);
  });

  it("writes every decision to the ledger, allowed or not", async () => {
    const h = harness({ mandateOverrides: { contactCap: { limit: 1, windowMs: 7 * DAY } } });
    const customer = customerRef("cus_000000000042");
    for (let i = 0; i < 3; i++) {
      await h.store.save(casualty(i, { customer, id: casualtyId(`cas_${i}`) }), AT);
    }
    await h.worker.drain();

    expect(h.ledger.verify().valid).toBe(true);
    expect(h.ledger.countByBinding()["contact-cap"]).toBe(2);
    // The allowed decision is recorded too, so the ledger answers "what did it do" as well as
    // "why did it not".
    expect(h.ledger.where((r) => r.allowed && r.action === "contact-email").length).toBeGreaterThan(
      0,
    );
  });
});

describe("after the action", () => {
  it("closes a casualty that recovered", async () => {
    const h = harness({ reply: () => recovered() });
    await h.store.save(casualty(1), AT);
    await h.worker.drain();

    const after = await h.store.get(casualtyId("cas_1"));
    expect(after?.status.recovered).toBe(true);
    expect((await h.worker.drain()).considered).toBe(0);
  });

  it("stops chasing a customer who asked it to", async () => {
    const h = harness({
      reply: () => ({ ...delivered(), optedOut: true }),
    });
    await h.store.save(casualty(1), AT);
    await h.worker.drain();

    const after = await h.store.get(casualtyId("cas_1"));
    expect(after?.status.optedOut).toBe(true);
    expect((await h.worker.drain()).considered).toBe(0);
  });

  it("teaches the model what actually happened", async () => {
    const model = trained(0.4);
    const h = harness({ model, reply: () => recovered() });
    const before = model.observations();

    await h.store.save(casualty(1), AT);
    await h.worker.drain();

    expect(model.observations()).toBeGreaterThan(before);
  });

  it("walks the ladder and then leaves the customer alone", async () => {
    const h = harness({
      reply: () => delivered(),
      mandateOverrides: { contactCap: { limit: 9, windowMs: 7 * DAY } },
    });
    await h.store.save(casualty(1, { failure: CARD_EXPIRED }), AT);

    let sent = 0;
    for (let day = 0; day < 12; day++) {
      h.clock.set(AT + day * DAY);
      sent += (await h.worker.drain()).acted;
    }

    // Three rungs, and then nothing however long the harness keeps asking.
    expect(sent).toBe(3);
  });
});

describe("classificationOf", () => {
  it("re-derives what the table already knows", () => {
    const c = casualty(1, { failure: CARD_EXPIRED });
    const derived = classificationOf(c);
    expect(derived.recoverability).toBe("customer-action");
    expect(derived.source).toBe("table");
  });

  it("recognises a class only a model could have chosen", () => {
    // The table returns `unknown` and the casualty says `timed`. That disagreement is the record
    // that a model refined this one — reconstructed rather than carried as a fourth field that
    // could drift out of step with the class beside it.
    const residual: FailureDetail = {
      code: "SERVER_ERROR",
      source: "business",
      step: "payment_capture",
      reason: "an_error_from_the_future",
      description: "",
    };
    const c = casualty(1, { failure: residual });
    const refined = { ...c, status: { ...c.status, recoverability: "timed" as const } };

    const derived = classificationOf(refined);
    expect(derived.recoverability).toBe("timed");
    expect(derived.source).toBe("model");
    expect(derived.confidence).toBeLessThan(1);
  });

  it("prefers the table when a stored class contradicts a named rule", () => {
    // Stale data, not a refinement. The model never had a vote on a failure the table can name.
    const c = casualty(1, { failure: CARD_EXPIRED });
    const wrong = { ...c, status: { ...c.status, recoverability: "transient" as const } };
    expect(classificationOf(wrong).recoverability).toBe("customer-action");
  });
});

describe("the recovery control arm", () => {
  it("leaves its casualties alone for good", async () => {
    const h = harness({ config: { controlFraction: 1 } });
    for (let i = 0; i < 20; i++) await h.store.save(casualty(i), AT);

    const report = await h.worker.drain();
    expect(report.acted).toBe(0);
    expect(h.executed).toEqual([]);

    // And never becomes due again — a control that gets chased tomorrow is not a control.
    h.clock.set(AT + 30 * DAY);
    expect((await h.worker.drain()).considered).toBe(0);
  });
});

describe("when the money moves and the record does not", () => {
  it("books the spend once, finishes the pass, and strands nothing", async () => {
    // Settlement throws when the money has already moved and the ledger write failed — the one
    // place in the system that fails loud rather than closed, because a spend nobody can explain is
    // exactly the state the ledger exists to prevent. What must not happen is that one unrecorded
    // settlement takes down the pass: every other casualty in the batch is unaffected, and
    // re-settling would book the money twice.
    const clock = new ManualClock(AT);
    const flaky = new FlakyLedger();
    const terminus = new Terminus({
      mandate: mandate(),
      secret: SECRET,
      store: new MemoryStore(),
      audit: flaky,
      actor: "recover-worker/test",
      clock,
    });
    const store = new MemoryCasualtyStore();
    const worker = new RecoverWorker({
      terminus,
      store,
      directory,
      gauge: gauge(),
      model: trained(0.4),
      executor: executor(() => delivered(20)),
      clock,
      config: { ...DEFAULT_RECOVERY_CONFIG, controlFraction: 0, explorationRate: 0 },
    });

    for (let i = 0; i < 4; i++) await store.save(casualty(i), AT);

    // The first casualty's admission is recorded; its settlement record is the one that fails.
    flaky.failFrom = 2;
    const report = await worker.drain();
    flaky.failFrom = Number.POSITIVE_INFINITY;

    // The pass ran to the end of the batch rather than aborting on the throw, and the money that
    // moved was booked exactly once — re-settling would have booked it twice.
    expect(report.claimed).toBe(4);
    expect(report.acted).toBe(1);
    const snapshot = await terminus.snapshot();
    expect(snapshot.settledPaise).toBe(20);
    expect(snapshot.committedPaise).toBe(0);
    expect(snapshot.inFlight).toBe(0);

    // The ledger stayed down, so every later casualty was refused before acting. That is the other
    // half of P8 and the opposite disposition: settlement fails loud because the money has already
    // moved, admission fails closed because it has not.
    expect(report.refusalsByAxis["audit"]).toBe(3);
  });
});
