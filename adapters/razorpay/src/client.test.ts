import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RazorpayClient, RazorpayError, type Transport, type TransportResponse } from "./client.js";
import { memorySeenEvents, verifyWebhook } from "./webhook.js";

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
}

function response(status: number, body: unknown, headers: Record<string, string> = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const payload: TransportResponse = {
    status,
    headers: { get: (name) => lower[name.toLowerCase()] ?? null },
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
  };
  return payload;
}

function recorder(responses: readonly TransportResponse[]) {
  const calls: Call[] = [];
  let index = 0;
  const transport: Transport = (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const next = responses[Math.min(index, responses.length - 1)];
    index++;
    if (next === undefined) throw new Error("no response configured");
    return Promise.resolve(next);
  };
  return { transport, calls, attempts: () => index };
}

function client(responses: readonly TransportResponse[], overrides: Record<string, unknown> = {}) {
  const slept: number[] = [];
  const rec = recorder(responses);
  const built = new RazorpayClient({
    credentials: { keyId: "rzp_test_abc", keySecret: "shhh" },
    transport: rec.transport,
    backoffMs: 100,
    // Pinned so the schedule is a fact rather than a sample.
    random: () => 1,
    sleep: (ms) => {
      slept.push(ms);
      return Promise.resolve();
    },
    ...overrides,
  });
  return { client: built, slept, ...rec };
}

describe("requests", () => {
  it("authenticates with the key pair and asks for JSON", async () => {
    const c = client([response(200, { id: "order_1", status: "created" })]);
    await c.client.createOrder({ amountPaise: 120_000, currency: "INR", receipt: "cas_1" });

    const call = c.calls[0];
    expect(call?.method).toBe("POST");
    expect(call?.url).toBe("https://api.razorpay.com/v1/orders");
    expect(call?.headers["authorization"]).toBe(
      `Basic ${Buffer.from("rzp_test_abc:shhh").toString("base64")}`,
    );
    expect(JSON.parse(call?.body ?? "{}")).toEqual({
      amount: 120_000,
      currency: "INR",
      receipt: "cas_1",
      notes: {},
    });
  });

  it("carries a reference id a duplicate payment link would collide with", async () => {
    // Razorpay's idempotency is per-endpoint rather than one header, so the client uses the natural
    // dedupe field on each. On payment links a duplicate `reference_id` is rejected outright, which
    // is what makes a retry after an ambiguous timeout safe here and merely detectable elsewhere.
    const c = client([response(200, { id: "plink_1" })]);
    await c.client.createPaymentLink({
      amountPaise: 50_000,
      currency: "INR",
      referenceId: "cas_9:1",
      description: "Complete your payment",
      expireBy: Date.UTC(2026, 8, 1),
    });

    const body = JSON.parse(c.calls[0]?.body ?? "{}");
    expect(body.reference_id).toBe("cas_9:1");
    expect(body.expire_by).toBe(Math.floor(Date.UTC(2026, 8, 1) / 1000));
  });
});

describe("retrying", () => {
  it("retries a 429 and honours the delay it was asked for", async () => {
    const c = client([
      response(429, { error: { code: "RATE_LIMIT" } }, { "retry-after": "2" }),
      response(200, { id: "order_1" }),
    ]);

    const entity = await c.client.createOrder({
      amountPaise: 1000,
      currency: "INR",
      receipt: "r",
    });

    expect(entity.id).toBe("order_1");
    expect(c.attempts()).toBe(2);
    expect(c.slept).toEqual([2000]);
  });

  it("clamps a delay long enough to outlive the reservation that authorised the call", async () => {
    // A gateway asking for an hour would otherwise park a worker holding Terminus authority until
    // its TTL expired, and a reservation that outlives its action is exactly the orphan the ledger
    // counts and the harness asserts to be zero.
    const c = client(
      [response(429, {}, { "retry-after": "3600" }), response(200, { id: "order_1" })],
      { maxBackoffMs: 5_000 },
    );

    await c.client.createOrder({ amountPaise: 1000, currency: "INR", receipt: "r" });
    expect(c.slept).toEqual([5_000]);
  });

  it("backs off exponentially when no delay is stated", async () => {
    const c = client([response(503, {}), response(503, {}), response(200, { id: "order_1" })]);
    await c.client.createOrder({ amountPaise: 1000, currency: "INR", receipt: "r" });
    expect(c.slept).toEqual([100, 200]);
  });

  it("does not retry a request that was wrong the first time", async () => {
    // A malformed request is malformed on the second attempt too, and spinning on one is how a
    // worker burns a rate limit it never needed to touch.
    const c = client([response(400, { error: { code: "BAD_REQUEST_ERROR" } })]);

    await expect(
      c.client.createOrder({ amountPaise: -1, currency: "INR", receipt: "r" }),
    ).rejects.toThrow(RazorpayError);
    expect(c.attempts()).toBe(1);
  });

  it("reports whether the caller should try again, and Razorpay's own request id", async () => {
    const c = client([
      response(400, { error: { code: "BAD_REQUEST_ERROR" } }, { "x-razorpay-request-id": "req_7" }),
    ]);

    const error = await c.client
      .createOrder({ amountPaise: 1, currency: "INR", receipt: "r" })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RazorpayError);
    if (!(error instanceof RazorpayError)) return;
    expect(error.retryable).toBe(false);
    expect(error.status).toBe(400);
    expect(error.requestId).toBe("req_7");
    expect(error.code).toBe("BAD_REQUEST_ERROR");
  });

  it("gives up after its attempt budget rather than for ever", async () => {
    const c = client([response(503, {})], { maxAttempts: 3 });
    await expect(
      c.client.createOrder({ amountPaise: 1, currency: "INR", receipt: "r" }),
    ).rejects.toThrow(/503/);
    expect(c.attempts()).toBe(3);
  });

  it("treats a transport that threw as a network fault worth retrying", async () => {
    let calls = 0;
    const transport: Transport = () => {
      calls++;
      if (calls === 1) return Promise.reject(new Error("ECONNRESET"));
      return Promise.resolve(response(200, { id: "order_1" }));
    };
    const built = new RazorpayClient({
      credentials: { keyId: "k", keySecret: "s" },
      transport,
      random: () => 1,
      sleep: () => Promise.resolve(),
    });

    const entity = await built.createOrder({ amountPaise: 1, currency: "INR", receipt: "r" });
    expect(entity.id).toBe("order_1");
    expect(calls).toBe(2);
  });

  it("refuses a success body it cannot make sense of", async () => {
    const c = client([response(200, "<html>maintenance</html>")]);
    await expect(
      c.client.createOrder({ amountPaise: 1, currency: "INR", receipt: "r" }),
    ).rejects.toThrow(/not JSON/);
  });

  it("refuses a success body with no entity id to record", async () => {
    const c = client([response(200, { status: "created" })]);
    await expect(c.client.fetchPayment("pay_1")).rejects.toThrow(/no id/);
  });
});

describe("webhook verification", () => {
  const secret = "whsec_test";
  const now = Date.UTC(2026, 7, 25, 12, 0, 0);

  const body = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      event: "payment.captured",
      created_at: Math.floor(now / 1000),
      payload: { payment: { entity: { id: "pay_abc", status: "captured" } } },
      ...overrides,
    });

  const sign = (raw: string) => createHmac("sha256", secret).update(raw, "utf8").digest("hex");

  const clock = () => now;

  const options = () => ({
    secret,
    toleranceMs: 5 * 60_000,
    // The same clock the verifier uses. Handing the table `Date.now()` while the verifier runs on
    // an injected clock expires every entry the instant it is written, and the replay check
    // silently stops checking anything.
    seen: memorySeenEvents(clock),
    now: clock,
  });

  it("accepts a webhook Razorpay actually signed", async () => {
    const raw = body();
    const verdict = await verifyWebhook(raw, sign(raw), options());
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.event).toBe("payment.captured");
  });

  it("verifies the bytes that were sent, not a re-serialisation of them", async () => {
    // The whole point. `JSON.parse` then `JSON.stringify` does not reproduce key order, unicode
    // escapes or number formatting, so a verifier that re-serialises rejects legitimate webhooks in
    // a way that looks like a signature problem — and the usual fix for that is to stop verifying.
    const raw = `{"created_at":${Math.floor(now / 1000)},"event":"payment.captured","payload":{"payment":{"entity":{"id":"pay_\\u0061bc"}}}}`;
    const verdict = await verifyWebhook(raw, sign(raw), options());
    expect(verdict.ok).toBe(true);
  });

  it("rejects a forged or absent signature", async () => {
    const raw = body();
    expect(await verifyWebhook(raw, null, options())).toEqual({
      ok: false,
      reason: "missing-signature",
    });
    expect(await verifyWebhook(raw, "00".repeat(32), options())).toEqual({
      ok: false,
      reason: "bad-signature",
    });
    expect(await verifyWebhook(raw, "not-hex-at-all", options())).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });

  it("rejects a signature of the wrong length rather than throwing", async () => {
    // `timingSafeEqual` throws on a length mismatch, and a verifier that throws is a verifier
    // somebody wraps in a try/catch that returns true.
    const raw = body();
    expect(await verifyWebhook(raw, "ab", options())).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });

  it("rejects a correctly-signed event that arrives a week late", async () => {
    const stale = body({ created_at: Math.floor((now - 7 * 86_400_000) / 1000) });
    const verdict = await verifyWebhook(stale, sign(stale), options());
    expect(verdict).toEqual({ ok: false, reason: "stale" });
  });

  it("keeps its entries on the clock it was given, not the wall clock", async () => {
    // Regression. The table once purged against `Date.now()` while the verifier ran on an injected
    // clock set to a different moment, so every id it recorded was already expired by the next
    // call — a deduplication table that silently deduplicated nothing, and passed its own tests
    // whenever the two clocks happened to agree.
    const table = memorySeenEvents(clock);
    expect(await table.remember("evt_1", now + 60_000)).toBe(true);
    expect(await table.remember("evt_1", now + 60_000)).toBe(false);

    const wallClock = memorySeenEvents();
    expect(await wallClock.remember("evt_2", now + 60_000)).toBe(true);
  });

  it("processes a redelivered event exactly once", async () => {
    const raw = body();
    const shared = options();
    expect((await verifyWebhook(raw, sign(raw), shared)).ok).toBe(true);
    expect(await verifyWebhook(raw, sign(raw), shared)).toEqual({
      ok: false,
      reason: "replayed",
    });
  });

  it("derives the deduplication id from signed fields only", async () => {
    // An id an attacker can choose is an id an attacker can use to make one replay look like a
    // hundred distinct events. Razorpay puts an id in a delivery header; only the body is signed.
    const shared = options();
    const first = body();
    expect((await verifyWebhook(first, sign(first), shared)).ok).toBe(true);

    const different = body({
      payload: { payment: { entity: { id: "pay_other", status: "captured" } } },
    });
    expect((await verifyWebhook(different, sign(different), shared)).ok).toBe(true);
  });

  it("rejects a body it cannot read even when the signature is right", async () => {
    const raw = "not json";
    expect(await verifyWebhook(raw, sign(raw), options())).toEqual({
      ok: false,
      reason: "malformed-body",
    });

    const noEntity = JSON.stringify({ event: "payment.captured", created_at: 1 });
    expect(await verifyWebhook(noEntity, sign(noEntity), options())).toEqual({
      ok: false,
      reason: "missing-event-id",
    });
  });
});
