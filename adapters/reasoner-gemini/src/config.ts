/**
 * Where the key comes from, what the defaults are, and why each one is what it is.
 *
 * Read from a record rather than from `process.env` directly, so that configuration is a pure
 * function of its input and a test can exercise every branch without touching the process. The one
 * place the real environment is read is {@link configFromProcess}, and it does nothing else.
 *
 * ## The key is never printed
 *
 * {@link describeConfig} exists so that a run can log what it is about to do, and it returns
 * everything except the secret. That is the same discipline the benchmark's `describe(profile)`
 * follows with the mandate signing key: the way a credential reaches a log file is that somebody
 * serialised the object it lives in, so the object gets a describe function and nothing else is ever
 * serialised.
 */

import { z } from "zod";
import type { ThinkingLevel } from "./wire.js";

export interface GeminiConfig {
  /** Never logged, never serialised, never put in a cassette. */
  readonly apiKey: string;
  readonly model: string;
  /** Overridable so a test, a proxy or a regional endpoint can be pointed at. */
  readonly endpoint: string;
  readonly thinkingLevel: ThinkingLevel;
  readonly requestsPerMinute: number;
  readonly requestsPerDay: number;
  /** Attempts in total, not retries in addition. `1` means never retry. */
  readonly maxAttempts: number;
}

export const DEFAULTS = {
  /**
   * The model the free tier's *daily quota* selects, which is not the one anything else would.
   *
   * Two findings, both from a 429 body rather than a documentation page:
   *
   * 1. `gemini-2.5-flash` — the obvious choice, and the one this file would have carried if it had
   *    been written from memory — answers a new API key with `404: no longer available to new
   *    users. Please update your code to use models/gemini-3.6-flash`.
   * 2. `gemini-3.6-flash`, the model that 404 points at, allows **twenty requests per day** on the
   *    free tier: `GenerateRequestsPerDayPerProjectPerModel-FreeTier = 20`. A hundred and eighty
   *    segments at twenty a day is a nine-day copy library.
   *
   * So the binding constraint is neither the rate nor the price, and picking a model on either
   * would have picked the wrong one. `gemini-3.1-flash-lite` is measured at fifteen requests a
   * minute with a daily allowance large enough to write a whole library in one sitting, costs a
   * third as much per token, and answers in about a fifth of the time. On this workload — three
   * short messages for a described situation, in a named language, under a character budget — the
   * lite model's output was not visibly worse, which is a claim the committed library lets anybody
   * check.
   */
  model: "gemini-3.1-flash-lite",
  endpoint: "https://generativelanguage.googleapis.com/v1beta",
  /**
   * The floor. `"off"` and `"none"` are 400s; `"minimal"` is as little as the API will accept.
   *
   * Copy for one situation is not a reasoning problem, and thinking tokens are billed as output —
   * measured at 751 thinking tokens against 33 of answer on a request for three SMS variants, which
   * also truncated the JSON by exhausting `maxOutputTokens`. Raise this and the same library costs
   * roughly twenty times as much for text nobody has shown is better.
   */
  thinkingLevel: "minimal",
  /**
   * Two under the fifteen measured for this model, because the measurement was a burst and the
   * window it was measured against has an edge somewhere.
   *
   * Being slow costs a build-time job nothing. Being wrong costs it a refusal, and a refused
   * request consumes the day's quota exactly as an answered one does — the burst that measured the
   * fifteen produced sixteen answers and two refusals, and paid for all eighteen.
   */
  requestsPerMinute: 13,
  /**
   * A floor under the free tier's daily allowance, not the allowance itself.
   *
   * Deliberately below whatever the real number is, so that the run stops itself with a message
   * naming the budget rather than being stopped by a provider with a message naming a URL. Where
   * the real ceiling is lower — twenty a day, for `gemini-3.6-flash` — the provider's own 429 stops
   * the run first and says which quota bound it, which is the one case where being told beats
   * guessing.
   */
  requestsPerDay: 500,
  maxAttempts: 4,
} as const satisfies Omit<GeminiConfig, "apiKey">;

const THINKING_LEVELS = ["minimal", "low", "medium", "high"] as const;

/**
 * The message somebody actually needs, on both paths that produce it.
 *
 * Attached at the schema level rather than to `.min(1)`, because a refinement's message covers only
 * the case where a string *arrived* and was empty. The far more common case — the variable is not
 * set at all — is a type error, and it would otherwise read `expected string, received undefined`,
 * which tells a person nothing about where to get a key.
 */
const NEEDS_KEY = "set GOOGLE_API_KEY; get one free at aistudio.google.com/apikey";

const ENV = z.object({
  GOOGLE_API_KEY: z.string({ error: NEEDS_KEY }).min(1, NEEDS_KEY),
  GEMINI_MODEL: z.string().min(1).optional(),
  GEMINI_ENDPOINT: z.url().optional(),
  GEMINI_THINKING_LEVEL: z.enum(THINKING_LEVELS).optional(),
  GEMINI_RPM: z.coerce.number().int().positive().optional(),
  GEMINI_RPD: z.coerce.number().int().positive().optional(),
  GEMINI_MAX_ATTEMPTS: z.coerce.number().int().positive().max(10).optional(),
});

/**
 * Build a configuration from environment variables.
 *
 * Throws with every problem at once rather than the first, because the person reading the message is
 * editing a `.env` file and a second run to discover a second missing variable is a second run they
 * did not need.
 */
export function configFromEnv(env: Record<string, string | undefined>): GeminiConfig {
  const parsed = ENV.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("\n");
    throw new Error(`the Gemini configuration is not usable:\n${issues}`);
  }

  const e = parsed.data;
  return {
    apiKey: e.GOOGLE_API_KEY,
    model: e.GEMINI_MODEL ?? DEFAULTS.model,
    endpoint: e.GEMINI_ENDPOINT ?? DEFAULTS.endpoint,
    thinkingLevel: e.GEMINI_THINKING_LEVEL ?? DEFAULTS.thinkingLevel,
    requestsPerMinute: e.GEMINI_RPM ?? DEFAULTS.requestsPerMinute,
    requestsPerDay: e.GEMINI_RPD ?? DEFAULTS.requestsPerDay,
    maxAttempts: e.GEMINI_MAX_ATTEMPTS ?? DEFAULTS.maxAttempts,
  };
}

/**
 * The same thing, from the real environment, having first loaded `.env` if there is one.
 *
 * `process.loadEnvFile` is Node's own, so a repository that needs exactly one secret does not
 * acquire a dependency to read it. A missing file is not an error: the variables may well be set by
 * a CI secret store, and a build that refuses to run because a local development convenience is
 * absent is a build that fails in the one place it should work.
 */
export function configFromProcess(path = ".env"): GeminiConfig {
  try {
    process.loadEnvFile(path);
  } catch {
    // Either there is no file or it is unreadable. Either way the environment is what it is.
  }
  return configFromEnv(process.env);
}

/** Everything about a configuration except the one field that must never be written down. */
export function describeConfig(config: GeminiConfig): string {
  return [
    `model            ${config.model}`,
    `endpoint         ${config.endpoint}`,
    `thinking         ${config.thinkingLevel}`,
    `pace             ${config.requestsPerMinute}/min, ${config.requestsPerDay}/day`,
    `attempts         up to ${config.maxAttempts}`,
    `api key          ${config.apiKey.length} characters, not shown`,
  ].join("\n");
}
