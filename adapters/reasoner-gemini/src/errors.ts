/**
 * What went wrong, whether trying again would help, and how long to wait.
 *
 * Every constant in this file was read off a real response rather than a documentation page. That
 * matters most for one of them: **the API sends no `Retry-After` header.** A retry loop written the
 * obvious way reads that header, finds `null`, and falls back to a guessed backoff — which is both
 * slower than the wait the server asked for and, when the guess is short, a second 429. The real
 * hint is a `google.rpc.RetryInfo` in the error body, and it is exact.
 *
 * ## What a 429 also tells you
 *
 * The `QuotaFailure` detail names the limit that bound and its value — `quotaValue: "15"` for
 * `GenerateRequestsPerMinutePerProjectPerModel-FreeTier`. So a refusal is not only a setback, it is
 * a measurement: the pacer can be corrected from what the server said rather than from a number
 * somebody typed into a config file last year. See {@link file://./pacing.ts}.
 */

import { z } from "zod";

/** Where the failure came from, which is what decides whether to try again. */
export type FailureKind =
  /** Rate or quota. Retryable, and the server usually says exactly when. */
  | "throttled"
  /** 5xx, a socket error, a DNS failure. Retryable. */
  | "unavailable"
  /** The deadline passed. Retryable in principle; the caller decides whether it has time. */
  | "deadline"
  /** 400, 404, a retired model, a malformed schema. Retrying is just a slower way to fail. */
  | "rejected"
  /** 401/403. A human has to do something. */
  | "unauthorised"
  /** A 200 whose body we could not use: truncated JSON, a safety block, no text at all. */
  | "unusable";

export class GeminiError extends Error {
  readonly kind: FailureKind;
  readonly status: number | null;
  /** What the server asked us to wait, where it said. Never invented — see {@link retryDelayOf}. */
  readonly retryAfterMs: number | null;
  /** The limit that bound, where a `QuotaFailure` named one. */
  readonly quota: QuotaViolation | null;

  constructor(
    message: string,
    options: {
      kind: FailureKind;
      status?: number | null;
      retryAfterMs?: number | null;
      quota?: QuotaViolation | null;
      cause?: unknown;
    },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "GeminiError";
    this.kind = options.kind;
    this.status = options.status ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.quota = options.quota ?? null;
  }

  /** Whether another attempt could plausibly succeed without anybody changing anything. */
  get retryable(): boolean {
    return this.kind === "throttled" || this.kind === "unavailable" || this.kind === "deadline";
  }
}

export interface QuotaViolation {
  /** e.g. `GenerateRequestsPerMinutePerProjectPerModel-FreeTier`. */
  readonly id: string;
  /** The limit's value, where the server stated one. */
  readonly limit: number | null;
  readonly model: string | null;
}

const RETRY_INFO = "type.googleapis.com/google.rpc.RetryInfo";
const QUOTA_FAILURE = "type.googleapis.com/google.rpc.QuotaFailure";

const ERROR_BODY = z.looseObject({
  error: z
    .looseObject({
      code: z.number().int().optional(),
      message: z.string().optional(),
      status: z.string().optional(),
      details: z.array(z.looseObject({ "@type": z.string().optional() })).optional(),
    })
    .optional(),
});

/**
 * A `google.protobuf.Duration` as JSON: a decimal number of seconds with an `s` suffix.
 *
 * Observed as both `"29s"` and sub-second values. Anything else is treated as absent rather than
 * guessed at, because a misparsed delay is worse than no delay — it would produce a retry storm
 * with a plausible-looking wait in front of it.
 */
const DURATION = /^(\d+(?:\.\d+)?)s$/;

export function parseDuration(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const match = DURATION.exec(raw.trim());
  if (match === null) return null;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) ? Math.ceil(seconds * 1000) : null;
}

interface Details {
  readonly retryAfterMs: number | null;
  readonly quota: QuotaViolation | null;
  readonly message: string | null;
}

/** Pull the retry hint and the bound quota out of an error body, tolerating any of it being absent. */
export function detailsOf(body: unknown): Details {
  const parsed = ERROR_BODY.safeParse(body);
  if (!parsed.success) return { retryAfterMs: null, quota: null, message: null };

  const error = parsed.data.error;
  let retryAfterMs: number | null = null;
  let quota: QuotaViolation | null = null;

  for (const detail of error?.details ?? []) {
    const type = detail["@type"];
    if (type === RETRY_INFO) {
      retryAfterMs = parseDuration((detail as { retryDelay?: unknown }).retryDelay);
    } else if (type === QUOTA_FAILURE) {
      quota = firstViolation(detail);
    }
  }

  return { retryAfterMs, quota, message: error?.message ?? null };
}

const VIOLATIONS = z.looseObject({
  violations: z
    .array(
      z.looseObject({
        quotaId: z.string().optional(),
        quotaValue: z.string().optional(),
        quotaDimensions: z.looseObject({ model: z.string().optional() }).optional(),
      }),
    )
    .optional(),
});

function firstViolation(detail: unknown): QuotaViolation | null {
  const parsed = VIOLATIONS.safeParse(detail);
  const violation = parsed.success ? parsed.data.violations?.[0] : undefined;
  if (violation === undefined) return null;

  const limit = Number(violation.quotaValue);
  return {
    id: violation.quotaId ?? "unknown",
    limit: violation.quotaValue !== undefined && Number.isInteger(limit) ? limit : null,
    model: violation.quotaDimensions?.model ?? null,
  };
}

/**
 * Turn an HTTP status into a verdict about retrying.
 *
 * 404 is `rejected` rather than `unavailable` on purpose, and it is the one somebody will hit: a
 * retired model returns 404 with a message naming its replacement, and treating that as a transient
 * outage would spend the whole retry budget on a request that can never succeed. Kairos's first
 * probe hit exactly this — `gemini-2.5-flash` is 404 for a new key.
 */
export function kindForStatus(status: number): FailureKind {
  if (status === 429) return "throttled";
  if (status === 401 || status === 403) return "unauthorised";
  if (status >= 500) return "unavailable";
  return "rejected";
}

/** Build the error for a non-2xx response, carrying whatever the body was willing to tell us. */
export function errorForResponse(status: number, body: unknown, model: string): GeminiError {
  const { retryAfterMs, quota, message } = detailsOf(body);
  const kind = kindForStatus(status);
  const summary = message === null ? `HTTP ${status}` : `HTTP ${status}: ${message}`;
  return new GeminiError(`${model}: ${summary}`, { kind, status, retryAfterMs, quota });
}
