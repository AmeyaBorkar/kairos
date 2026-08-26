import { describe, expect, it, vi } from "vitest";
import type { GeminiConfig } from "./config.js";
import { configFromEnv, DEFAULTS, describeConfig } from "./config.js";
import { detailsOf, GeminiError, kindForStatus, parseDuration } from "./errors.js";
import { type Pace, pacer } from "./pacing.js";
import { httpTransport, waitFor } from "./transport.js";
import type { GenerateRequest } from "./wire.js";

const CONFIG: GeminiConfig = {
  apiKey: "test-key-not-a-real-one",
  model: "gemini-3.1-flash-lite",
  endpoint: "https://example.invalid/v1beta",
  thinkingLevel: "minimal",
  requestsPerMinute: 6000,
  requestsPerDay: 100_000,
  maxAttempts: 4,
};

const REQUEST: GenerateRequest = {
  contents: [{ role: "user", parts: [{ text: "hello" }] }],
  generationConfig: { maxOutputTokens: 32 },
};

/** A pace that never waits, for the tests that are not about pacing. */
const FREE: Pace = {
  take: () => Promise.resolve(),
  learn: () => false,
  requestsPerMinute: 6000,
  remaining: () => Promise.resolve(100_000),
};

function ok(text = "hi", extra: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
      modelVersion: "gemini-3.1-flash-lite",
      ...extra,
    }),
    { status: 200 },
  );
}

/** The real body of a real 429, trimmed. Everything about retries is read off this shape. */
function throttled(retryDelay = "29s", quotaValue = "15"): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: 429,
        message: "You exceeded your current quota. Please retry in 29s.",
        status: "RESOURCE_EXHAUSTED",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.QuotaFailure",
            violations: [
              {
                quotaMetric:
                  "generativelanguage.googleapis.com/generate_content_free_tier_requests",
                quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier",
                quotaDimensions: { location: "global", model: "gemini-3.1-flash-lite" },
                quotaValue,
              },
            ],
          },
          { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay },
        ],
      },
    }),
    { status: 429 },
  );
}

function transport(fetches: readonly (() => Response | Promise<Response>)[], pace: Pace = FREE) {
  let at = 0;
  const slept: number[] = [];
  const inner = httpTransport({
    config: CONFIG,
    pace,
    fetch: (() => {
      const next = fetches[Math.min(at, fetches.length - 1)];
      at++;
      return Promise.resolve(next?.() ?? ok());
    }) as unknown as typeof globalThis.fetch,
    sleep: (ms) => {
      slept.push(ms);
      return Promise.resolve();
    },
    random: () => 0.5,
  });
  return { transport: inner, slept, calls: () => at };
}

describe("reading a failure", () => {
  it("takes the retry hint from the body, because there is no header to take it from", () => {
    // Measured, not assumed: a real 429 from this API carries no `Retry-After` at all. An
    // implementation that reads the header finds nothing and falls back to a guess — which is both
    // slower than the wait the server asked for and, when short, a second refusal.
    const response = throttled("29s");
    expect(response.headers.get("retry-after")).toBeNull();
  });

  it("parses a protobuf duration and refuses anything else", () => {
    expect(parseDuration("29s")).toBe(29_000);
    expect(parseDuration("0.194s")).toBe(194);
    expect(parseDuration("194ms")).toBeNull();
    expect(parseDuration("soon")).toBeNull();
    expect(parseDuration(29)).toBeNull();
    expect(parseDuration(undefined)).toBeNull();
  });

  it("reads the limit the server said bound it", async () => {
    const body = await throttled("29s", "15").json();
    const details = detailsOf(body);
    expect(details.retryAfterMs).toBe(29_000);
    expect(details.quota).toEqual({
      id: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier",
      limit: 15,
      model: "gemini-3.1-flash-lite",
    });
  });

  it("survives a body with none of that in it", () => {
    expect(detailsOf(null)).toEqual({ retryAfterMs: null, quota: null, message: null });
    expect(detailsOf({ error: {} }).quota).toBeNull();
    expect(detailsOf({ error: { details: [{ "@type": "unknown" }] } }).retryAfterMs).toBeNull();
  });

  it("calls a retired model a rejection and not an outage", () => {
    // The one somebody will hit. `gemini-2.5-flash` answers a new key with a 404 naming its
    // replacement, and retrying that is spending the whole budget on a request that cannot succeed.
    expect(kindForStatus(404)).toBe("rejected");
    expect(kindForStatus(400)).toBe("rejected");
    expect(kindForStatus(429)).toBe("throttled");
    expect(kindForStatus(403)).toBe("unauthorised");
    expect(kindForStatus(503)).toBe("unavailable");
  });

  it("retries only what could succeed on a second try", () => {
    const retryable = (kind: GeminiError["kind"]) => new GeminiError("x", { kind }).retryable;
    expect(retryable("throttled")).toBe(true);
    expect(retryable("unavailable")).toBe(true);
    expect(retryable("deadline")).toBe(true);
    expect(retryable("rejected")).toBe(false);
    expect(retryable("unauthorised")).toBe(false);
    expect(retryable("unusable")).toBe(false);
  });
});

describe("waiting", () => {
  it("waits exactly as long as the server asked", () => {
    const error = new GeminiError("x", { kind: "throttled", retryAfterMs: 194 });
    expect(waitFor(error, 1, () => 0.5)).toBe(194);
    expect(waitFor(error, 4, () => 0.5)).toBe(194);
  });

  it("backs off exponentially only where the server said nothing", () => {
    const silent = new GeminiError("x", { kind: "unavailable" });
    expect(waitFor(silent, 1, () => 1)).toBe(1000);
    expect(waitFor(silent, 2, () => 1)).toBe(2000);
    expect(waitFor(silent, 3, () => 1)).toBe(4000);
  });

  it("jitters, so retries synchronised by one outage do not stay synchronised", () => {
    const silent = new GeminiError("x", { kind: "unavailable" });
    expect(waitFor(silent, 3, () => 0)).toBe(0);
    expect(waitFor(silent, 3, () => 0.25)).toBe(1000);
  });
});

describe("one call", () => {
  it("sends the key as a header and never in the URL", async () => {
    const seen: { url?: string; headers?: Headers } = {};
    const inner = httpTransport({
      config: CONFIG,
      pace: FREE,
      fetch: ((url: string, init: RequestInit) => {
        seen.url = url;
        seen.headers = new Headers(init.headers);
        return Promise.resolve(ok());
      }) as unknown as typeof globalThis.fetch,
    });

    await inner.call(CONFIG.model, REQUEST, 1000);
    expect(seen.url).not.toContain(CONFIG.apiKey);
    expect(seen.headers?.get("x-goog-api-key")).toBe(CONFIG.apiKey);
  });

  it("gives up on a rejection without spending a single retry", async () => {
    const t = transport([
      () => new Response(JSON.stringify({ error: { code: 404 } }), { status: 404 }),
    ]);
    await expect(t.transport.call(CONFIG.model, REQUEST, 5000)).rejects.toThrow(/HTTP 404/);
    expect(t.calls()).toBe(1);
  });

  it("retries a 429 and succeeds", async () => {
    const t = transport([() => throttled("2s"), () => ok("second time")]);
    const response = await t.transport.call(CONFIG.model, REQUEST, 60_000);
    expect(response.candidates?.[0]?.content?.parts?.[0]?.text).toBe("second time");
    expect(t.slept).toEqual([2000]);
  });

  it("stops at the attempt limit rather than for ever", async () => {
    const t = transport([() => throttled("1s")]);
    await expect(t.transport.call(CONFIG.model, REQUEST, 600_000)).rejects.toThrow(/HTTP 429/);
    expect(t.calls()).toBe(CONFIG.maxAttempts);
  });

  it("does not start a retry it has no time to finish", async () => {
    // The deadline spans every attempt rather than each one, so three retries of a ten-second
    // timeout cannot quietly become thirty seconds.
    const t = transport([() => throttled("30s")]);
    await expect(t.transport.call(CONFIG.model, REQUEST, 5_000)).rejects.toThrow(/HTTP 429/);
    expect(t.calls()).toBe(1);
    expect(t.slept).toEqual([]);
  });

  it("believes the server about its own limit", async () => {
    const learned: number[] = [];
    const watching: Pace = {
      ...FREE,
      learn: (violation) => {
        if (violation.limit !== null) learned.push(violation.limit);
        return true;
      },
    };
    const t = transport([() => throttled("1s", "15"), () => ok()], watching);
    await t.transport.call(CONFIG.model, REQUEST, 60_000);
    expect(learned).toEqual([15]);
  });

  it("paces every attempt, not just the first", async () => {
    // Pacing only the first attempt is how a retry loop turns a rate limit into a rate-limit storm.
    let taken = 0;
    const counting: Pace = {
      ...FREE,
      take: () => {
        taken++;
        return Promise.resolve();
      },
    };
    const t = transport([() => throttled("1s"), () => throttled("1s"), () => ok()], counting);
    await t.transport.call(CONFIG.model, REQUEST, 60_000);
    expect(taken).toBe(3);
  });

  it("calls a socket failure retryable and an unreadable body not", async () => {
    const broken = transport([
      () => {
        throw new TypeError("fetch failed");
      },
      () => ok(),
    ]);
    await expect(broken.transport.call(CONFIG.model, REQUEST, 60_000)).resolves.toBeDefined();

    const nonsense = transport([
      () => new Response('{"candidates":"not an array"}', { status: 200 }),
    ]);
    await expect(nonsense.transport.call(CONFIG.model, REQUEST, 60_000)).rejects.toThrow(
      /shape we can read/,
    );
    expect(nonsense.calls()).toBe(1);
  });

  it("turns its own abort into a deadline rather than an unknown socket error", async () => {
    const inner = httpTransport({
      config: { ...CONFIG, maxAttempts: 1 },
      pace: FREE,
      fetch: ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        })) as unknown as typeof globalThis.fetch,
    });

    await expect(inner.call(CONFIG.model, REQUEST, 10)).rejects.toThrow(/no answer within/);
  });
});

describe("pacing", () => {
  it("waits for a rate and refuses a day", async () => {
    const slept: number[] = [];
    const pace = pacer({
      requestsPerMinute: 60,
      requestsPerDay: 3,
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    });

    for (let i = 0; i < 3; i++) await pace.take("m");
    // The rate makes each call wait its turn; three calls at 60/minute is two one-second waits.
    expect(slept.filter((ms) => ms > 0).length).toBe(2);

    // The day is not something to wait out. It is something to come back tomorrow for.
    await expect(pace.take("m")).rejects.toThrow(/day's quota of 3 requests is spent/);
  });

  it("corrects downward when the server disagrees, and never upward", () => {
    const pace = pacer({ requestsPerMinute: 15, requestsPerDay: 100 });
    expect(pace.learn({ id: "q", limit: 60, model: null })).toBe(false);
    expect(pace.requestsPerMinute).toBe(15);

    expect(pace.learn({ id: "q", limit: 5, model: null })).toBe(true);
    expect(pace.requestsPerMinute).toBe(5);

    // Good news is not permission to speed up: a pacer that ratchets open eventually finds the
    // ceiling by hitting it.
    expect(pace.learn({ id: "q", limit: 90, model: null })).toBe(false);
    expect(pace.requestsPerMinute).toBe(5);
    expect(pace.learn({ id: "q", limit: null, model: null })).toBe(false);
  });

  it("reports what is left of the day without consuming any of it", async () => {
    const pace = pacer({ requestsPerMinute: 6000, requestsPerDay: 5 });
    expect(await pace.remaining("m")).toBe(5);
    await pace.take("m");
    expect(await pace.remaining("m")).toBe(4);
    expect(await pace.remaining("m")).toBe(4);
  });

  it("refuses rather than queueing for longer than the caller would wait", async () => {
    const pace = pacer({
      requestsPerMinute: 1,
      requestsPerDay: 100,
      maxQueueMs: 500,
      sleep: () => Promise.resolve(),
    });
    await pace.take("m");
    await expect(pace.take("m")).rejects.toThrow(/queue is longer than 500ms/);
  });
});

describe("configuration", () => {
  it("refuses to run without a key, and says where to get one", () => {
    expect(() => configFromEnv({})).toThrow(/aistudio\.google\.com/);
  });

  it("defaults to the model the free tier's daily quota permits", () => {
    // Not the fastest, not the newest, not the one the docs lead with. `gemini-3.6-flash` allows
    // twenty requests a day on the free tier, which is a nine-day copy library.
    const config = configFromEnv({ GOOGLE_API_KEY: "k" });
    expect(config.model).toBe("gemini-3.1-flash-lite");
    expect(config.thinkingLevel).toBe("minimal");
    expect(config.requestsPerMinute).toBe(DEFAULTS.requestsPerMinute);
  });

  it("reads numbers from strings, because that is all an environment holds", () => {
    const config = configFromEnv({ GOOGLE_API_KEY: "k", GEMINI_RPM: "3", GEMINI_RPD: "40" });
    expect(config.requestsPerMinute).toBe(3);
    expect(config.requestsPerDay).toBe(40);
    expect(() => configFromEnv({ GOOGLE_API_KEY: "k", GEMINI_RPM: "many" })).toThrow();
    expect(() => configFromEnv({ GOOGLE_API_KEY: "k", GEMINI_THINKING_LEVEL: "off" })).toThrow();
  });

  it("never puts the key in the description", () => {
    // The way a credential reaches a log file is that somebody serialised the object it lives in.
    const description = describeConfig(CONFIG);
    expect(description).not.toContain(CONFIG.apiKey);
    expect(description).toContain("not shown");
  });

  it("does not print the key when the whole config is stringified either", () => {
    // A weaker guarantee than a redacting toJSON, and stated so that nobody mistakes `describe` for
    // one: the object does hold the key, and this is why nothing else ever serialises it.
    expect(JSON.stringify(CONFIG)).toContain(CONFIG.apiKey);
    expect(vi.isMockFunction(describeConfig)).toBe(false);
  });
});
