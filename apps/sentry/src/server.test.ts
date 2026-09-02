import { mandateId, type PaymentMethod, paise, parseSliceKey } from "@kairos/domain";
import { DEFAULT_STEERING_CONFIG, isHeldOut } from "@kairos/policy";
import { ManualClock, sealMandate } from "@kairos/terminus";
import { afterEach, describe, expect, it } from "vitest";
import { createSentry, type Sentry, type SentryOptions } from "./server.js";

const SECRET = "a-secret-that-lives-in-a-vault-not-a-repo";
const DAY = 86_400_000;
const START = Date.UTC(2026, 7, 25, 12, 0, 0);
const SEQUENCE: readonly PaymentMethod[] = ["upi", "card", "netbanking", "wallet"];

const config = DEFAULT_STEERING_CONFIG;

function mandate(overrides: Record<string, unknown> = {}) {
  return sealMandate(
    {
      id: mandateId("mnd_steer"),
      merchantId: "acme",
      campaignId: "steering",
      budgetPaise: paise(100_000),
      maxActionCostPaise: paise(1),
      maxInFlight: config.maxConcurrentSteers,
      reservationTtlMs: config.maxIncidentDurationMs,
      contactCap: { limit: 99, windowMs: DAY },
      quietHours: null,
      allowedActions: ["steer"] as const,
      validFrom: START - DAY,
      validUntil: START + 30 * DAY,
      killSwitch: false,
      ...overrides,
    },
    SECRET,
  );
}

const open: Sentry[] = [];

function sentry(overrides: Partial<SentryOptions> = {}, mandateOverrides = {}): Sentry {
  const built = createSentry({
    mandate: mandate(mandateOverrides),
    secret: SECRET,
    defaultSequence: SEQUENCE,
    clock: new ManualClock(START),
    tickMs: 1000,
    ...overrides,
  });
  open.push(built);
  return built;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.app.close()));
});

const customer = (i: number): string => `cus_${i.toString().padStart(12, "0")}`;

interface Outcome {
  readonly method: PaymentMethod;
  readonly issuer?: string;
  readonly instrument?: string;
  readonly failed: boolean;
  readonly at: number;
  readonly arm?: "treated" | "control";
}

let sequence = 0;

function batch(outcomes: readonly Outcome[]) {
  return {
    attempts: outcomes.map((o) => {
      sequence++;
      return {
        id: `pay_${sequence}`,
        orderId: `order_${sequence}`,
        customer: customer(sequence % 5000),
        amountPaise: 120_000,
        method: o.method,
        issuer: o.issuer ?? null,
        instrument: o.instrument ?? null,
        status: o.failed ? ("failed" as const) : ("captured" as const),
        at: o.at,
        arm: o.arm ?? null,
      };
    }),
  };
}

/** Feed healthy traffic, then break one rail hard enough that a steer becomes worth making. */
async function drive(s: Sentry, breakSlice: { method: PaymentMethod; issuer: string }) {
  const post = (body: ReturnType<typeof batch>) =>
    s.app.inject({ method: "POST", url: "/outcomes", payload: body });

  let at = START;
  for (let round = 0; round < 40; round++) {
    const outcomes: Outcome[] = [];
    for (let i = 0; i < 60; i++) {
      at += 500;
      outcomes.push({ method: "upi", issuer: "sbi", instrument: "gpay", failed: i % 50 === 0, at });
      outcomes.push({
        method: "card",
        issuer: "icici",
        instrument: "visa",
        failed: i % 9 === 0,
        at,
      });
      outcomes.push({
        method: breakSlice.method,
        issuer: breakSlice.issuer,
        failed: i % 25 === 0,
        at,
      });
      outcomes.push({ method: "wallet", issuer: "paytm", failed: i % 30 === 0, at });
    }
    await post(batch(outcomes));
  }

  for (let round = 0; round < 60; round++) {
    const outcomes: Outcome[] = [];
    for (let i = 0; i < 60; i++) {
      at += 500;
      outcomes.push({ method: "upi", issuer: "sbi", instrument: "gpay", failed: i % 50 === 0, at });
      outcomes.push({
        method: "card",
        issuer: "icici",
        instrument: "visa",
        failed: i % 9 === 0,
        at,
      });
      outcomes.push({
        method: breakSlice.method,
        issuer: breakSlice.issuer,
        failed: i % 10 !== 0,
        at,
        arm: "control",
      });
      outcomes.push({ method: "wallet", issuer: "paytm", failed: i % 30 === 0, at });
    }
    await post(batch(outcomes));
  }

  return at;
}

describe("POST /outcomes", () => {
  it("accepts a well-formed batch", async () => {
    const s = sentry();
    const response = await s.app.inject({
      method: "POST",
      url: "/outcomes",
      payload: batch([
        { method: "upi", issuer: "hdfc", instrument: "gpay", failed: false, at: START },
      ]),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().accepted).toBe(1);
  });

  it("rejects a batch it cannot understand rather than coercing it", async () => {
    // An outcome stream that is not the shape we expect is evidence about the integration, not
    // about the rails. Accepting it would put a slice in the detector nothing else can reason about.
    const s = sentry();
    const response = await s.app.inject({
      method: "POST",
      url: "/outcomes",
      payload: { attempts: [{ id: "pay_1", method: "crypto", status: "captured", at: START }] },
    });

    expect(response.statusCode).toBe(400);
  });

  it("refuses a customer reference short enough to be a raw phone number", async () => {
    // A structural guard against a bare identifier reaching the ledger or a model prompt.
    const s = sentry();
    const payload = batch([{ method: "upi", issuer: "hdfc", failed: false, at: START }]);
    payload.attempts[0] = { ...payload.attempts[0], customer: "+919876543210" } as never;

    const response = await s.app.inject({ method: "POST", url: "/outcomes", payload });
    expect(response.statusCode).toBe(400);
  });

  it("caps how much one request can carry", async () => {
    const s = sentry();
    const many = Array.from({ length: 1001 }, () => ({
      method: "upi" as const,
      issuer: "hdfc",
      failed: false,
      at: START,
    }));
    const response = await s.app.inject({
      method: "POST",
      url: "/outcomes",
      payload: batch(many),
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("GET /plan — the hot path", () => {
  it("returns the merchant's own configuration when nothing is in force", async () => {
    const s = sentry();
    const response = await s.app.inject({ method: "GET", url: `/plan/${customer(1)}` });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.steered).toBe(false);
    expect(body.checkout.display.sequence).toEqual(SEQUENCE);
  });

  it("falls back rather than failing on a reference it cannot parse", async () => {
    // The single most important production property in the system: the failure mode of a
    // payment-health tool must never be "no payments".
    const s = sentry();
    const response = await s.app.inject({ method: "GET", url: "/plan/short" });

    expect(response.statusCode).toBe(200);
    expect(response.json().checkout.display.sequence).toEqual(SEQUENCE);
    expect(response.json().reason).toMatch(/unrecognised/);
  });

  it("falls back when the plan takes longer than its budget", async () => {
    const clock = new ManualClock(START);
    const s = sentry({ clock, planBudgetMs: 0 });
    // Any elapsed time at all blows a zero budget, which is what a stalled hot path looks like.
    const original = clock.now.bind(clock);
    let calls = 0;
    clock.now = () => (calls++ === 0 ? original() : original() + 5000);

    const response = await s.app.inject({ method: "GET", url: `/plan/${customer(1)}` });
    expect(response.statusCode).toBe(200);
    expect(response.json().reason).toMatch(/budget/);
    expect(response.json().steered).toBe(false);
  });

  it("steers a treated customer and leaves a control customer alone", async () => {
    const s = sentry();
    await drive(s, { method: "netbanking", issuer: "hdfc" });

    const directives = s.directives();
    expect(directives.length).toBeGreaterThan(0);
    const incident = directives[0]?.incident;
    if (incident === undefined) throw new Error("expected a steer");

    const treated = findCustomer((c) => !isHeldOut(c as never, incident, config.holdoutFraction));
    const control = findCustomer((c) => isHeldOut(c as never, incident, config.holdoutFraction));

    const treatedBody = (await s.app.inject({ method: "GET", url: `/plan/${treated}` })).json();
    const controlBody = (await s.app.inject({ method: "GET", url: `/plan/${control}` })).json();

    expect(treatedBody.steered).toBe(true);
    expect(controlBody.steered).toBe(false);
    expect(controlBody.checkout.display.sequence).toEqual(SEQUENCE);
  });

  it("gives a control customer exactly what no Kairos at all would give them", async () => {
    const s = sentry();
    await drive(s, { method: "netbanking", issuer: "hdfc" });
    const incident = s.directives()[0]?.incident;
    if (incident === undefined) throw new Error("expected a steer");

    const control = findCustomer((c) => isHeldOut(c as never, incident, config.holdoutFraction));
    const body = (await s.app.inject({ method: "GET", url: `/plan/${control}` })).json();
    const cold = (await sentry().app.inject({ method: "GET", url: `/plan/${control}` })).json();

    expect(body.checkout.display.sequence).toEqual(cold.checkout.display.sequence);
    expect(body.checkout.display.hide).toBeUndefined();
  });
});

describe("GET /health", () => {
  it("reports rails, incidents and steers", async () => {
    const s = sentry();
    await drive(s, { method: "netbanking", issuer: "hdfc" });

    const body = (await s.app.inject({ method: "GET", url: "/health" })).json();
    expect(body.rails.length).toBeGreaterThan(0);
    expect(body.incidents.length).toBeGreaterThan(0);
    expect(body.steering.length).toBeGreaterThan(0);
    expect(body.steering[0].reason).toBeTypeOf("string");
  });

  it("names the binding axis on every decision it recorded", async () => {
    const s = sentry();
    await drive(s, { method: "netbanking", issuer: "hdfc" });
    const body = (await s.app.inject({ method: "GET", url: "/ledger" })).json();

    expect(body.verification.valid).toBe(true);
    expect(body.recent.length).toBeGreaterThan(0);
  });
});

describe("bounds", () => {
  it("steers nothing at all when the kill switch is engaged", async () => {
    const s = sentry({}, { killSwitch: true });
    await drive(s, { method: "netbanking", issuer: "hdfc" });

    expect(s.directives()).toEqual([]);
    const body = (await s.app.inject({ method: "GET", url: `/plan/${customer(1)}` })).json();
    expect(body.steered).toBe(false);
  });

  it("hands every steer back when it shuts down", async () => {
    // A steer is a held reservation, so a clean shutdown returns them rather than leaving checkouts
    // rearranged until the TTL catches up.
    const s = sentry();
    await drive(s, { method: "netbanking", issuer: "hdfc" });
    expect(s.directives().length).toBeGreaterThan(0);

    await s.app.close();
    open.splice(open.indexOf(s), 1);
    expect(s.directives()).toEqual([]);
  });
});

describe("POST /plan — a checkout in any language", () => {
  const plan = (s: Sentry, payload: unknown) =>
    s.app.inject({ method: "POST", url: "/plan", payload: payload as never });

  it("answers with the merchant's own sequence when nothing is in force", async () => {
    const s = sentry();
    const response = await plan(s, { customer: customer(1) });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.steered).toBe(false);
    expect(body.sequence).toEqual(SEQUENCE);
    expect(body.suppress).toEqual([]);
    expect(body.demote).toEqual([]);
    expect(body.checkout.display.sequence).toEqual(SEQUENCE);
  });

  it("plans against the method set this page offers, not the one the service was started with", async () => {
    // The reason this endpoint takes a body at all. A merchant has more than one checkout, and the
    // method list is a property of the page rather than of the deployment.
    const s = sentry();
    const body = (await plan(s, { customer: customer(1), sequence: ["card", "upi"] })).json();

    expect(body.sequence).toEqual(["card", "upi"]);
    expect(body.checkout.display.sequence).toEqual(["card", "upi"]);
  });

  it("gives the same decision as the path form for the same customer", async () => {
    const s = sentry();
    await drive(s, { method: "netbanking", issuer: "hdfc" });
    const incident = s.directives()[0]?.incident;
    if (incident === undefined) throw new Error("expected a steer");
    const treated = findCustomer((c) => !isHeldOut(c as never, incident, config.holdoutFraction));

    const posted = (await plan(s, { customer: treated })).json();
    const got = (await s.app.inject({ method: "GET", url: `/plan/${treated}` })).json();

    expect(posted.steered).toBe(true);
    expect(posted).toEqual(got);
  });

  it("states the arm, so a caller can echo it back without knowing what a holdout is", async () => {
    const s = sentry();
    await drive(s, { method: "netbanking", issuer: "hdfc" });
    const incident = s.directives()[0]?.incident;
    if (incident === undefined) throw new Error("expected a steer");

    const treated = findCustomer((c) => !isHeldOut(c as never, incident, config.holdoutFraction));
    const control = findCustomer((c) => isHeldOut(c as never, incident, config.holdoutFraction));

    const treatedBody = (await plan(s, { customer: treated })).json();
    const controlBody = (await plan(s, { customer: control })).json();

    expect(treatedBody.arm).toBe("treated");
    expect(controlBody.arm).toBe("control");
    expect(controlBody.heldOutOf).toContain(incident);
    // The arm the response names is exactly the one `POST /outcomes` accepts, so the round trip is
    // a copy rather than a translation.
    const echo = await s.app.inject({
      method: "POST",
      url: "/outcomes",
      payload: {
        attempts: [
          {
            id: "pay_echo",
            orderId: "order_echo",
            customer: control,
            amountPaise: 100,
            method: "upi",
            status: "captured",
            at: START,
            arm: controlBody.arm,
          },
        ],
      },
    });
    expect(echo.json().accepted).toBe(1);
  });

  it("reports a suppression in vocabulary no gateway owns, agreeing with the one that does", async () => {
    const s = sentry();
    await drive(s, { method: "netbanking", issuer: "hdfc" });
    const incident = s.directives()[0]?.incident;
    if (incident === undefined) throw new Error("expected a steer");
    const treated = findCustomer((c) => !isHeldOut(c as never, incident, config.holdoutFraction));

    const body = (await plan(s, { customer: treated })).json();
    const suppressed = body.suppress as {
      key: string;
      method: string;
      issuer: string | null;
      instrument: string | null;
    }[];

    expect(suppressed.length + body.demote.length).toBeGreaterThan(0);
    for (const s_ of suppressed) {
      // Round-trips: the key is the slice and the fields are the slice, and neither is derived by
      // the caller from the other.
      expect(parseSliceKey(s_.key)).toEqual({
        method: s_.method,
        issuer: s_.issuer,
        instrument: s_.instrument,
      });
    }
    // Whatever was suppressed is hidden in the Razorpay config too, unless it could not be
    // expressed there at all — in which case it is named in the diagnostics rather than lost.
    const hidden = (body.checkout.display.hide ?? []).length;
    expect(hidden + body.diagnostics.length).toBe(suppressed.length);
  });

  it("answers a body it cannot parse with a page rather than an error", async () => {
    // The hot path is total. An integration bug must be visible in `reason` and invisible to the
    // customer, because the failure mode of a payment-health tool must never be "no payments".
    const s = sentry();
    for (const payload of [
      {},
      { customer: "short" },
      { customer: customer(1), sequence: ["cash"] },
    ]) {
      const response = await plan(s, payload);
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.steered).toBe(false);
      expect(body.sequence).toEqual(SEQUENCE);
      expect(body.checkout.display.sequence).toEqual(SEQUENCE);
      expect(body.reason).toMatch(/invalid request|unrecognised/);
    }
  });

  it("tells the caller how long the answer keeps", async () => {
    const s = sentry({ tickMs: 4000 });
    expect((await plan(s, { customer: customer(1) })).json().maxAgeMs).toBe(4000);
  });
});

function findCustomer(predicate: (customer: string) => boolean): string {
  for (let i = 0; i < 5000; i++) {
    const c = customer(i);
    if (predicate(c)) return c;
  }
  throw new Error("no matching customer");
}
