/**
 * One call to the model, bounded four ways.
 *
 * A build-time job that talks to somebody else's server can fail in four independent ways, and each
 * needs its own bound or it becomes unbounded:
 *
 * 1. **Too fast** — the free tier's rate. Bounded by the pacer, which waits.
 * 2. **Too many** — the free tier's day. Bounded by the pacer, which stops.
 * 3. **Too slow** — a request that never returns. Bounded by a deadline that spans *every* attempt,
 *    not each one, so three retries of a ten-second timeout cannot quietly become thirty seconds.
 * 4. **Too often** — a retry loop against a failure that will never succeed. Bounded by an attempt
 *    count and by refusing to retry anything the server told us not to.
 *
 * {@link Transport} is the seam everything above is written against. It takes a request in Google's
 * vocabulary and returns a response in it; the cassette, the ports and the tests all substitute for
 * it without any of them knowing what an `AbortController` is.
 */

import type { GeminiConfig } from "./config.js";
import { errorForResponse, GeminiError } from "./errors.js";
import type { Pace } from "./pacing.js";
import { GENERATE_RESPONSE, type GenerateRequest, type GenerateResponse } from "./wire.js";

export interface Transport {
  /** Resolves with a parsed response, or throws a {@link GeminiError}. Never returns a failure. */
  call(model: string, request: GenerateRequest, deadlineMs: number): Promise<GenerateResponse>;
}

export interface TransportOptions {
  readonly config: GeminiConfig;
  readonly pace: Pace;
  /** Injected so tests need no network and no listening socket. */
  readonly fetch?: typeof globalThis.fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /** Jitter source. Injected so a test's backoff is a number rather than a distribution. */
  readonly random?: () => number;
  /** Called before each attempt after the first. The one hook a CLI needs to explain a long pause. */
  readonly onRetry?: (attempt: number, waitMs: number, error: GeminiError) => void;
}

/** First backoff step, doubling per attempt. Only ever used when the server declined to say. */
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

const defaultSleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

export function httpTransport(options: TransportOptions): Transport {
  const { config, pace } = options;
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;

  async function attempt(
    model: string,
    request: GenerateRequest,
    budgetMs: number,
  ): Promise<GenerateResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budgetMs);

    try {
      const response = await doFetch(`${config.endpoint}/models/${model}:generateContent`, {
        method: "POST",
        headers: {
          // A header, not a query parameter. The same key in a URL ends up in access logs, in
          // referrers, and in the shell history of anyone who copies the command.
          "x-goog-api-key": config.apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw errorForResponse(response.status, body, model);

      const parsed = GENERATE_RESPONSE.safeParse(body);
      if (!parsed.success) {
        throw new GeminiError(`${model}: the response did not have the shape we can read`, {
          kind: "unusable",
          status: response.status,
          cause: parsed.error,
        });
      }
      return parsed.data;
    } catch (error: unknown) {
      if (error instanceof GeminiError) throw error;
      // An abort is our own deadline firing, and it is the one failure whose cause we already know.
      if (error instanceof Error && error.name === "AbortError") {
        throw new GeminiError(`${model}: no answer within ${budgetMs}ms`, {
          kind: "deadline",
          cause: error,
        });
      }
      // Everything else here is the socket: DNS, TLS, a connection reset. Retryable, all of it.
      throw new GeminiError(`${model}: ${error instanceof Error ? error.message : String(error)}`, {
        kind: "unavailable",
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async call(model, request, deadlineMs) {
      const deadlineAt = now() + deadlineMs;
      let last: GeminiError | null = null;

      for (let n = 1; n <= config.maxAttempts; n++) {
        // Paced inside the loop: a retry is a request like any other and counts against both the
        // rate and the day. Pacing only the first attempt is how a retry loop turns a rate limit
        // into a rate-limit storm.
        await pace.take(model);

        const remaining = deadlineAt - now();
        if (remaining <= 0) {
          throw (
            last ??
            new GeminiError(`${model}: out of time before the call was made`, {
              kind: "deadline",
            })
          );
        }

        try {
          return await attempt(model, request, remaining);
        } catch (error: unknown) {
          if (!(error instanceof GeminiError)) throw error;
          last = error;

          // A 429 carries the limit that bound it. Believing the server over our own configuration
          // is the only way a pacer set from a documentation page ever becomes correct.
          if (error.quota !== null) pace.learn(error.quota);

          if (!error.retryable || n === config.maxAttempts) throw error;

          const wait = waitFor(error, n, random);
          if (now() + wait >= deadlineAt) throw error;
          options.onRetry?.(n, wait, error);
          await sleep(wait);
        }
      }

      /* c8 ignore next -- the loop either returns or throws; this is the type-checker's share. */
      throw last ?? new GeminiError(`${model}: no attempt was made`, { kind: "unavailable" });
    },
  };
}

/**
 * How long to wait before trying again.
 *
 * The server's own hint wins whenever there is one, exactly. This matters more than it looks: the
 * API sends **no `Retry-After` header**, so an implementation that reads the header finds nothing
 * and falls back to a guess — and the guess is both slower than the wait actually needed (`0.194s`,
 * observed) and, when it is shorter, a second refusal.
 *
 * Where the server said nothing, exponential backoff with full jitter. Jitter rather than a flat
 * doubling because retries that were synchronised by one outage stay synchronised through every
 * subsequent one, and a thundering herd of three is still a herd.
 */
export function waitFor(error: GeminiError, attempt: number, random: () => number): number {
  if (error.retryAfterMs !== null) return error.retryAfterMs;
  const ceiling = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempt - 1));
  return Math.round(ceiling * random());
}
