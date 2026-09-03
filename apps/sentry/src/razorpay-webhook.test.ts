import { createHmac } from "node:crypto";
import { mandateId, paise } from "@kairos/domain";
import { ManualClock, sealMandate } from "@kairos/terminus";
import { afterEach, describe, expect, it } from "vitest";
import { createSentry, type Sentry } from "./server.js";

const SECRET = "a-secret-that-lives-in-a-vault-not-a-repo";
const WEBHOOK_SECRET = "webhook-secret-from-the-dashboard";
const PII_KEY = "p".repeat(64);
const DAY = 86_400_000;

/**
 * The kernel's clock is set a long way from real time on purpose.
 *
 * This is what an accelerated demonstration looks like from the inside: sixty times real speed puts
 * the campaign's clock hours ahead within minutes. Anything in this service that measures the
 * outside world has to notice.
 */
const KERNEL_NOW = Date.UTC(2030, 0, 1, 0, 0, 0);

const open: Sentry[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.app.close();
});

function sentry(clockAt = KERNEL_NOW) {
  const built = createSentry({
    mandate: sealMandate(
      {
        id: mandateId("mnd_steer"),
        merchantId: "acme",
        campaignId: "steering",
        budgetPaise: paise(100_000),
        maxActionCostPaise: paise(1),
        maxInFlight: 3,
        reservationTtlMs: 60_000,
        contactCap: { limit: 99, windowMs: DAY },
        quietHours: null,
        allowedActions: ["steer"],
        // Wide, because these tests run the clock at two very different places on purpose.
        validFrom: 0,
        validUntil: Date.UTC(2035, 0, 1),
        killSwitch: false,
      },
      SECRET,
    ),
    secret: SECRET,
    clock: new ManualClock(clockAt),
    razorpayWebhook: { secret: WEBHOOK_SECRET, piiKey: PII_KEY },
  });
  open.push(built);
  return built;
}

/** A `payment.failed` event, stamped now in real seconds, signed the way Razorpay signs. */
function delivery(over: Record<string, unknown> = {}, createdAtMs = Date.now()) {
  const body = JSON.stringify({
    entity: "event",
    event: "payment.failed",
    created_at: Math.floor(createdAtMs / 1000),
    payload: {
      payment: {
        entity: {
          id: `pay_${Math.random().toString(36).slice(2, 12)}`,
          amount: 100,
          currency: "INR",
          status: "failed",
          method: "card",
          card: { network: "Visa", issuer: null, last4: "1111" },
          contact: "+919999999999",
          error_code: "BAD_REQUEST_ERROR",
          error_source: "business",
          error_step: "payment_initiation",
          error_reason: "international_transaction_not_allowed",
          error_description: "domestic cards only",
          created_at: Math.floor(createdAtMs / 1000),
          ...over,
        },
      },
    },
  });
  return {
    body,
    signature: createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex"),
  };
}

const post = (s: Sentry, d: { body: string; signature: string }) =>
  s.app.inject({
    method: "POST",
    url: "/webhooks/razorpay",
    headers: { "content-type": "application/json", "x-razorpay-signature": d.signature },
    payload: d.body,
  });

describe("freshness is measured against the real world", () => {
  it("accepts a delivery stamped now, even with the kernel clock years away", async () => {
    // The regression. Verifying against the campaign's accelerated clock rejected every genuine
    // webhook as stale within seconds of boot, which is what happened to the first real delivery
    // this route ever received. Razorpay stamps created_at in real time; so must the check.
    const response = await post(sentry(), delivery());
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, observed: true });
  });

  it("still refuses one that is genuinely old", async () => {
    const response = await post(sentry(), delivery({}, Date.now() - 60 * 60_000));
    expect(response.json()).toMatchObject({ ok: false, reason: "stale" });
  });
});

describe("the three things that must be true", () => {
  it("refuses a body nobody signed", async () => {
    const d = delivery();
    const response = await sentry().app.inject({
      method: "POST",
      url: "/webhooks/razorpay",
      headers: { "content-type": "application/json" },
      payload: d.body,
    });
    expect(response.json()).toMatchObject({ ok: false, reason: "missing-signature" });
  });

  it("refuses a signature from the wrong secret", async () => {
    const d = delivery();
    const forged = createHmac("sha256", "not-the-secret").update(d.body).digest("hex");
    const response = await post(sentry(), { body: d.body, signature: forged });
    expect(response.json()).toMatchObject({ ok: false, reason: "bad-signature" });
  });

  it("refuses a body edited after signing", async () => {
    const d = delivery();
    const tampered = d.body.replace('"amount":100', '"amount":999999');
    const response = await post(sentry(), { body: tampered, signature: d.signature });
    expect(response.json()).toMatchObject({ ok: false, reason: "bad-signature" });
  });

  it("refuses the same delivery twice", async () => {
    const s = sentry();
    const d = delivery();
    expect((await post(s, d)).json()).toMatchObject({ ok: true });
    expect((await post(s, d)).json()).toMatchObject({ ok: false, reason: "replayed" });
  });
});

describe("what it does with one it accepts", () => {
  it("reads the slice and the failure Razorpay reported", async () => {
    const body = (await post(sentry(), delivery())).json();
    expect(body.slice).toBe("card||");
    expect(body.failure).toMatchObject({
      source: "business",
      step: "payment_initiation",
      reason: "international_transaction_not_allowed",
    });
  });

  it("shows the observation in /health when the detector runs in real time", async () => {
    // Deliberately a real-time clock, and the reason is worth stating.
    //
    // A webhook is stamped by the outside world, and the rolling window decays what it holds
    // against whatever clock the detector runs on. Under an accelerated demonstration those are
    // different timelines, and an observation from real time is already ancient by the demo's
    // reckoning — so it is accepted, translated and logged, and then decays to nothing before it
    // can be read. That is not a defect to fix here: one detector has one clock, and no merge of
    // two timelines is correct. Real webhooks belong to a real deployment, where speed is one.
    const s = sentry(Date.now());
    await post(s, delivery());
    const health = (await s.app.inject({ method: "GET", url: "/health" })).json();
    expect(health.rails.some((r: { slice: string }) => r.slice.startsWith("card"))).toBe(true);
  });

  it("is accepted but invisible to the window when the two clocks disagree", async () => {
    // The other half of the same fact, asserted so nobody later reads the test above as a promise
    // that an accelerated stack can also serve as a live integration.
    const s = sentry(KERNEL_NOW);
    expect((await post(s, delivery())).json()).toMatchObject({ ok: true, observed: true });
    const health = (await s.app.inject({ method: "GET", url: "/health" })).json();
    expect(health.rails).toHaveLength(0);
  });

  it("lets a captured payment through as a success, not a casualty", async () => {
    const body = (await post(sentry(), delivery({ status: "captured", error_code: null }))).json();
    expect(body).toMatchObject({ observed: true, status: "captured", failure: null });
  });

  it("acknowledges a signed event carrying no payment", async () => {
    const raw = JSON.stringify({
      entity: "event",
      event: "settlement.processed",
      created_at: Math.floor(Date.now() / 1000),
      payload: { settlement: { entity: { id: "setl_1" } } },
    });
    const response = await post(sentry(), {
      body: raw,
      signature: createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex"),
    });
    expect(response.json()).toMatchObject({ ok: true, observed: false });
  });

  it("never lets a contact reach the response", async () => {
    const response = await post(sentry(), delivery());
    expect(response.body).not.toContain("9999999999");
  });
});

describe("the route is absent without credentials", () => {
  it("404s rather than existing and trusting anything", async () => {
    const built = createSentry({
      mandate: sealMandate(
        {
          id: mandateId("mnd_steer"),
          merchantId: "acme",
          campaignId: "steering",
          budgetPaise: paise(100_000),
          maxActionCostPaise: paise(1),
          maxInFlight: 3,
          reservationTtlMs: 60_000,
          contactCap: { limit: 99, windowMs: DAY },
          quietHours: null,
          allowedActions: ["steer"],
          validFrom: KERNEL_NOW - DAY,
          validUntil: KERNEL_NOW + 30 * DAY,
          killSwitch: false,
        },
        SECRET,
      ),
      secret: SECRET,
      clock: new ManualClock(KERNEL_NOW),
    });
    open.push(built);
    const response = await post(built, delivery());
    expect(response.statusCode).toBe(404);
  });
});
