/**
 * Google's vocabulary, and the only file in this repository allowed to know it.
 *
 * Everything above this line speaks in {@link Prompt}s and {@link Usage}; everything below speaks in
 * `generateContent`, `usageMetadata` and `finishReason`. That boundary is the entire justification
 * for an adapter — swapping Gemini for Groq is a new file beside this one, not a change anywhere
 * else.
 *
 * ## Parsed, not cast
 *
 * The response is validated rather than trusted. Not because Google is unreliable but because the
 * fields we depend on are *conditionally present*: `thoughtsTokenCount` appears only when the model
 * thought, `cachedContentTokenCount` only when something was cached, and a `part` can carry a
 * `thoughtSignature` and no `text` at all. Code written against a single observed response reads
 * `parts[0].text` and gets `undefined` the first time the model returns a signature part first.
 *
 * The schema is deliberately non-strict about *extra* fields — a provider adding one is not an
 * error, and a validator that treats it as one turns somebody else's Tuesday release into our
 * outage. It is strict about the fields we price and parse.
 */

import type { Usage } from "@kairos/reason";
import { z } from "zod";

/** What we ask for. Deliberately a narrow slice of what the API accepts. */
export interface GenerateRequest {
  readonly systemInstruction?: { readonly parts: readonly { readonly text: string }[] };
  readonly contents: readonly {
    readonly role: "user" | "model";
    readonly parts: readonly { readonly text: string }[];
  }[];
  readonly generationConfig: GenerationConfig;
}

export interface GenerationConfig {
  readonly temperature?: number;
  readonly maxOutputTokens: number;
  /**
   * How the answer is framed.
   *
   * `"text/x.enum"` is the one worth knowing about: paired with a `STRING` schema carrying an
   * `enum`, the provider itself constrains the answer to a closed list — so a classifier gets two
   * independent barriers against a model that would rather write a sentence, and the cheaper one
   * runs on somebody else's machine.
   */
  readonly responseMimeType?: "application/json" | "text/plain" | "text/x.enum";
  readonly responseSchema?: ResponseSchema;
  /**
   * How hard the model is allowed to think.
   *
   * A Gemini-3 concept, and not the same knob as Gemini 2.5's `thinkingBudget` — which this API
   * rejects with a 400 rather than ignoring. Measured on `gemini-3.6-flash`: with no thinking
   * config at all, a request for three SMS variants spent **751 thinking tokens against 33 of
   * output** and hit `MAX_TOKENS` mid-JSON. At `"minimal"` it spent none and finished.
   *
   * Thinking is billed as output. Leaving this unset is therefore not a neutral default: it is a
   * roughly twentyfold price increase on a task whose whole design is that it fits in a free tier.
   */
  readonly thinkingConfig?: { readonly thinkingLevel: ThinkingLevel };
}

/** Values the API accepts. `"off"` and `"none"` are 400s — the floor is `"minimal"`. */
export type ThinkingLevel = "minimal" | "low" | "medium" | "high";

/**
 * The subset of OpenAPI schema the API accepts, with its own type spelling.
 *
 * Upper-case type names because that is what the wire wants; `zod`'s JSON-schema output would need
 * translating, and hand-writing two schemas for two shapes is less machinery than a translator with
 * its own failure modes.
 */
export interface ResponseSchema {
  readonly type: "OBJECT" | "ARRAY" | "STRING" | "NUMBER" | "BOOLEAN";
  readonly properties?: Readonly<Record<string, ResponseSchema>>;
  readonly items?: ResponseSchema;
  readonly required?: readonly string[];
  /** A closed answer set. Only meaningful on a `STRING`. */
  readonly enum?: readonly string[];
  readonly description?: string;
  readonly propertyOrdering?: readonly string[];
}

/**
 * Why generation stopped.
 *
 * `STOP` is the only one that means the answer is complete. `MAX_TOKENS` is the dangerous one: the
 * response body is well-formed HTTP with a 200 status and a *truncated* payload, so JSON parsing
 * fails somewhere unhelpful unless the reason is checked first. Observed in the wild on the first
 * probe, from thinking tokens rather than long output.
 */
const FINISH_REASON = z.enum([
  "STOP",
  "MAX_TOKENS",
  "SAFETY",
  "RECITATION",
  "PROHIBITED_CONTENT",
  "SPII",
  "MALFORMED_FUNCTION_CALL",
  "BLOCKLIST",
  "IMAGE_SAFETY",
  "LANGUAGE",
  "OTHER",
]);

export type FinishReason = z.infer<typeof FINISH_REASON>;

const PART = z.looseObject({ text: z.string().optional() });

const CANDIDATE = z.looseObject({
  content: z.looseObject({ parts: z.array(PART).optional() }).optional(),
  // Absent on a candidate that was still streaming; we do not stream, but a missing reason is not
  // worth failing a whole library generation over, so it is optional and treated as unfinished.
  finishReason: FINISH_REASON.optional(),
});

const USAGE_METADATA = z.looseObject({
  promptTokenCount: z.number().int().nonnegative().optional(),
  candidatesTokenCount: z.number().int().nonnegative().optional(),
  /** Present only when the model thought. Billed as output — see {@link usageOf}. */
  thoughtsTokenCount: z.number().int().nonnegative().optional(),
  /** Present only on a cache hit. Absent is not zero-cost; it is "nothing was cached". */
  cachedContentTokenCount: z.number().int().nonnegative().optional(),
  totalTokenCount: z.number().int().nonnegative().optional(),
});

export const GENERATE_RESPONSE = z.looseObject({
  candidates: z.array(CANDIDATE).optional(),
  usageMetadata: USAGE_METADATA.optional(),
  /** The version that actually served the request, which is not always the alias asked for. */
  modelVersion: z.string().optional(),
  promptFeedback: z.looseObject({ blockReason: z.string().optional() }).optional(),
});

export type GenerateResponse = z.infer<typeof GENERATE_RESPONSE>;

/**
 * What the call consumed, in the units Terminus settles against.
 *
 * **Thinking tokens are output tokens.** They are billed at the output rate and reported in a
 * separate field, so anything that prices `candidatesTokenCount` alone under-reports — by 23× on
 * the probe that produced this comment. A cost model that is wrong in the cheap direction is worse
 * than no cost model, because it survives review.
 */
export function usageOf(response: GenerateResponse): Usage {
  const meta = response.usageMetadata;
  const thoughts = meta?.thoughtsTokenCount ?? 0;
  const answer = meta?.candidatesTokenCount ?? 0;
  return {
    inputTokens: meta?.promptTokenCount ?? 0,
    outputTokens: answer + thoughts,
    cachedInputTokens: meta?.cachedContentTokenCount ?? 0,
  };
}

/**
 * The text of the first candidate, or `null` where there is none.
 *
 * Joins every part rather than taking the first, because a part may carry a `thoughtSignature` and
 * no text at all — the first probe's response had exactly that shape — and indexing into `parts[0]`
 * would read `undefined` as an empty answer instead of as a bug.
 */
export function textOf(response: GenerateResponse): string | null {
  const parts = response.candidates?.[0]?.content?.parts;
  if (parts === undefined) return null;
  const text = parts.map((part) => part.text ?? "").join("");
  return text.length === 0 ? null : text;
}

export function finishReasonOf(response: GenerateResponse): FinishReason | null {
  return response.candidates?.[0]?.finishReason ?? null;
}
