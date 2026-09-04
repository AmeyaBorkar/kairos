/**
 * A minimal Razorpay REST client: the parts Kairos actually calls, and nothing else.
 *
 * ## What is real and what is not
 *
 * The request shapes, authentication, error handling and backoff here are written against
 * Razorpay's published API and are exercised in tests against a stubbed transport.
 *
 * Four of those have now also been exercised against the live API in test mode, by
 * `scripts/probe.mjs`, whose transcript is committed at `docs/razorpay-probe.json`: authentication,
 * request shaping for `/orders` and `/payment_links`, entity parsing, and the mapping of a 4xx to a
 * non-retryable {@link RazorpayError}. A real order and a real payment link came back.
 *
 * The **retry policy has not**, and cannot be by a probe: 429 and 5xx are what exercise it, and a
 * healthy gateway does not produce them on demand. The backoff, the `Retry-After` clamp and the
 * whole-call deadline are therefore still stub-tested only. That boundary is stated rather than
 * implied, because a claim of live integration that dissolves under one question is worth less than
 * an honest account of which half was verified.
 */

/** Everything the client needs to talk to Razorpay. Never logged, never serialised. */
export interface RazorpayCredentials {
  readonly keyId: string;
  readonly keySecret: string;
}

/**
 * The HTTP transport, injected.
 *
 * A port rather than a direct `fetch` call so the retry and backoff logic — the part with the
 * interesting failure modes — can be tested without a network. It matches the shape of `fetch`
 * closely enough that passing `fetch` itself is the production wiring.
 */
export type Transport = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body?: string;
    readonly signal?: AbortSignal;
  },
) => Promise<TransportResponse>;

export interface TransportResponse {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export interface RazorpayClientOptions {
  readonly credentials: RazorpayCredentials;
  readonly transport: Transport;
  readonly baseUrl?: string;
  /** Attempts per call, including the first. */
  readonly maxAttempts?: number;
  /** Base delay for exponential backoff, in milliseconds. */
  readonly backoffMs?: number;
  /** Ceiling on any single backoff, so a stated `Retry-After` cannot park a worker for an hour. */
  readonly maxBackoffMs?: number;
  /** Whole-call deadline, across every attempt. */
  readonly deadlineMs?: number;
  /** Jitter source. Injected so a test can pin the schedule. */
  readonly random?: () => number;
  /** Sleep, injected for the same reason. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * A call that failed in a way the caller has to distinguish.
 *
 * `retryable` is the field that matters: it is the difference between a worker that parks a
 * casualty for an operator and one that spins on a permanently malformed request.
 */
export class RazorpayError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  readonly requestId: string | null;
  readonly code: string | null;

  constructor(
    message: string,
    status: number,
    retryable: boolean,
    requestId: string | null,
    code: string | null = null,
  ) {
    super(message);
    this.name = "RazorpayError";
    this.status = status;
    this.retryable = retryable;
    this.requestId = requestId;
    this.code = code;
  }
}

const DEFAULTS = {
  baseUrl: "https://api.razorpay.com/v1",
  maxAttempts: 4,
  backoffMs: 250,
  maxBackoffMs: 20_000,
  deadlineMs: 15_000,
} as const;

export interface CreateOrderRequest {
  readonly amountPaise: number;
  readonly currency: string;
  /**
   * The merchant's own reference, and the only dedupe Razorpay offers on this endpoint.
   *
   * Razorpay's idempotency story is per-endpoint rather than a single header, so the client uses
   * the natural field on each: `receipt` here, `reference_id` on payment links. Where an endpoint
   * offers nothing, the ledger's grant id is what makes a duplicate detectable after the fact
   * rather than preventable before it — which is the honest position, not a claim of exactly-once.
   */
  readonly receipt: string;
  readonly notes?: Readonly<Record<string, string>>;
}

export interface CreatePaymentLinkRequest {
  readonly amountPaise: number;
  readonly currency: string;
  /** Unique per link. Razorpay rejects a duplicate, which is what makes a retry safe here. */
  readonly referenceId: string;
  readonly description: string;
  readonly expireBy?: number;
  readonly notes?: Readonly<Record<string, string>>;
}

/** Just enough of Razorpay's responses to record and reconcile. */
export interface RazorpayEntity {
  readonly id: string;
  readonly status?: string;
  readonly [key: string]: unknown;
}

export class RazorpayClient {
  readonly #credentials: RazorpayCredentials;
  readonly #transport: Transport;
  readonly #baseUrl: string;
  readonly #maxAttempts: number;
  readonly #backoffMs: number;
  readonly #maxBackoffMs: number;
  readonly #deadlineMs: number;
  readonly #random: () => number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: RazorpayClientOptions) {
    this.#credentials = options.credentials;
    this.#transport = options.transport;
    this.#baseUrl = options.baseUrl ?? DEFAULTS.baseUrl;
    this.#maxAttempts = options.maxAttempts ?? DEFAULTS.maxAttempts;
    this.#backoffMs = options.backoffMs ?? DEFAULTS.backoffMs;
    this.#maxBackoffMs = options.maxBackoffMs ?? DEFAULTS.maxBackoffMs;
    this.#deadlineMs = options.deadlineMs ?? DEFAULTS.deadlineMs;
    this.#random = options.random ?? Math.random;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  createOrder(request: CreateOrderRequest): Promise<RazorpayEntity> {
    return this.#call("POST", "/orders", {
      amount: request.amountPaise,
      currency: request.currency,
      receipt: request.receipt,
      notes: request.notes ?? {},
    });
  }

  createPaymentLink(request: CreatePaymentLinkRequest): Promise<RazorpayEntity> {
    return this.#call("POST", "/payment_links", {
      amount: request.amountPaise,
      currency: request.currency,
      reference_id: request.referenceId,
      description: request.description,
      ...(request.expireBy === undefined ? {} : { expire_by: Math.floor(request.expireBy / 1000) }),
      notes: request.notes ?? {},
    });
  }

  fetchPayment(paymentId: string): Promise<RazorpayEntity> {
    return this.#call("GET", `/payments/${encodeURIComponent(paymentId)}`);
  }

  /**
   * One call, with bounded retries.
   *
   * The retry policy is the whole point of this method, and its rules are:
   *
   * - **429 and 5xx are retried**, because they say nothing about whether the request was
   *   acceptable. A stated `Retry-After` is honoured, and clamped, because a gateway asking for an
   *   hour would otherwise park a worker holding a Terminus reservation until its TTL expired.
   * - **4xx is not retried.** A malformed request is malformed on the second attempt too, and
   *   spinning on one is how a worker burns a rate limit it did not need to touch.
   * - **A whole-call deadline bounds every attempt together**, so a sequence of slow retries cannot
   *   outlive the reservation that authorised it. That is the failure mode Terminus counts as an
   *   orphan, and it is the one this exists to prevent.
   */
  async #call(method: string, path: string, body?: unknown): Promise<RazorpayEntity> {
    const url = `${this.#baseUrl}${path}`;
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const startedAt = Date.now();

    let lastError: RazorpayError | null = null;

    for (let attempt = 1; attempt <= this.#maxAttempts; attempt++) {
      const remaining = this.#deadlineMs - (Date.now() - startedAt);
      if (remaining <= 0) break;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), remaining);

      let response: TransportResponse;
      try {
        response = await this.#transport(url, {
          method,
          headers: this.#headers(encoded !== undefined),
          ...(encoded === undefined ? {} : { body: encoded }),
          signal: controller.signal,
        });
      } catch (cause) {
        // A transport that threw is a network fault, which says nothing about the request.
        lastError = new RazorpayError(
          `transport failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          0,
          true,
          null,
        );
        clearTimeout(timer);
        if (attempt < this.#maxAttempts) await this.#backoff(attempt, null);
        continue;
      } finally {
        clearTimeout(timer);
      }

      const requestId = response.headers.get("x-razorpay-request-id");
      const text = await response.text();

      if (response.status >= 200 && response.status < 300) {
        return parseEntity(text, requestId);
      }

      const retryable = response.status === 429 || response.status >= 500;
      lastError = new RazorpayError(
        `Razorpay returned ${response.status}`,
        response.status,
        retryable,
        requestId,
        errorCodeOf(text),
      );

      if (!retryable) throw lastError;
      if (attempt < this.#maxAttempts) {
        await this.#backoff(attempt, response.headers.get("retry-after"));
      }
    }

    throw (
      lastError ??
      new RazorpayError(`no attempt completed within ${this.#deadlineMs}ms`, 0, true, null)
    );
  }

  #headers(hasBody: boolean): Record<string, string> {
    const basic = Buffer.from(
      `${this.#credentials.keyId}:${this.#credentials.keySecret}`,
      "utf8",
    ).toString("base64");
    return {
      authorization: `Basic ${basic}`,
      accept: "application/json",
      "user-agent": "kairos/0.1",
      ...(hasBody ? { "content-type": "application/json" } : {}),
    };
  }

  /** Exponential with full jitter, honouring a stated `Retry-After` but never trusting it blindly. */
  async #backoff(attempt: number, retryAfter: string | null): Promise<void> {
    const stated = retryAfter === null ? Number.NaN : Number(retryAfter) * 1000;
    const exponential = this.#backoffMs * 2 ** (attempt - 1);
    const target = Number.isFinite(stated) && stated > 0 ? stated : exponential;
    // Full jitter rather than a fixed delay: a fleet backing off in lockstep re-creates the
    // thundering herd that caused the 429 in the first place.
    await this.#sleep(Math.min(this.#maxBackoffMs, Math.round(target * this.#random())));
  }
}

function parseEntity(text: string, requestId: string | null): RazorpayEntity {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RazorpayError("Razorpay returned a body that is not JSON", 200, false, requestId);
  }
  if (typeof parsed !== "object" || parsed === null || !("id" in parsed)) {
    throw new RazorpayError("Razorpay returned an entity with no id", 200, false, requestId);
  }
  return parsed as RazorpayEntity;
}

/** Razorpay nests its machine-readable code at `error.code`. Absent is not an error. */
function errorCodeOf(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || !("error" in parsed)) return null;
    const error = (parsed as { error: unknown }).error;
    if (typeof error !== "object" || error === null || !("code" in error)) return null;
    const code = (error as { code: unknown }).code;
    return typeof code === "string" ? code : null;
  } catch {
    return null;
  }
}
