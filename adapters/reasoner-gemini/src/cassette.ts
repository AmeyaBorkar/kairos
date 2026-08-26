/**
 * Real responses, recorded once, replayed for ever.
 *
 * The problem this solves is specific. Tests that mock a provider verify that the code works against
 * the shape the author *believed* the provider returns, which is exactly the belief that was wrong —
 * every surprise in this adapter came from a real response disagreeing with a reasonable assumption:
 * a part with a `thoughtSignature` and no text, a 200 truncated by thinking tokens, a retry hint in
 * the body where the header should be. A hand-written mock would have reproduced none of them.
 *
 * So the fixtures are recordings. A cassette is captured against the live API once, committed, and
 * replayed by every test and every CI run afterwards. The code under test is the same code; only the
 * socket is gone.
 *
 * ## Small on purpose
 *
 * A cassette holds a handful of *representative* exchanges, including the ugly ones, and not the
 * whole of a library generation. The generated copy is already committed — as a library, validated
 * and indexed — and recording it a second time as raw responses would double the repository's data
 * for no test that could not be written against six.
 *
 * ## A miss is an error
 *
 * Replay never falls through to the network. A test whose prompt changed gets a named failure
 * telling it to re-record, rather than a live call that quietly costs quota, needs a key, and passes
 * on one machine.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { GeminiError } from "./errors.js";
import type { Transport } from "./transport.js";
import { GENERATE_RESPONSE, type GenerateRequest, type GenerateResponse } from "./wire.js";

const ENTRY = z.object({
  /**
   * `sha256(model + canonical request)`, truncated. Recomputed on replay; never trusted.
   *
   * Named `digest` rather than `key`, which is what it was called until a secret scanner flagged
   * the file. It was a false positive — sixteen hex characters next to a field called "key" is what
   * an API credential looks like from the outside — but the fix is the name rather than a
   * suppression: this value is a digest, "key" was the ambiguous word, and an allowlist entry would
   * have weakened the scanner on every file added under that path afterwards.
   */
  digest: z.string().regex(/^[0-9a-f]{16}$/),
  /** What this exchange is, for a human reading the file. Never part of the key. */
  label: z.string(),
  model: z.string().min(1),
  response: GENERATE_RESPONSE,
});

export const CASSETTE = z.object({
  recordedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  note: z.string(),
  entries: z.array(ENTRY),
});

export type Cassette = z.infer<typeof CASSETTE>;
export type CassetteEntry = z.infer<typeof ENTRY>;

export function parseCassette(raw: unknown): Cassette {
  const parsed = CASSETTE.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("\n");
    throw new Error(`the cassette is not valid:\n${issues}`);
  }
  return parsed.data;
}

/**
 * Deterministic JSON, so that reordering a field in a request builder does not silently invalidate
 * every recording.
 *
 * Object keys sorted, array order preserved — array order is meaningful here, since `contents` is a
 * conversation and `parts` is a document. Written locally rather than imported from `@kairos/proof`
 * because a provider adapter depending on the benchmark's measurement package would be a stranger
 * edge in the graph than twelve lines.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
  return `{${entries.join(",")}}`;
}

export function requestDigest(model: string, request: GenerateRequest): string {
  return createHash("sha256")
    .update(`${model}\u0000${canonical(request)}`, "utf8")
    .digest("hex")
    .slice(0, 16);
}

/**
 * A transport that answers only from a cassette.
 *
 * The transport used by every test and by CI. It holds no key, opens no socket, and cannot be
 * made to by any argument it is given.
 */
export function replaying(cassette: Cassette): Transport {
  const byDigest = new Map(cassette.entries.map((entry) => [entry.digest, entry]));
  return {
    call(model, request) {
      const digest = requestDigest(model, request);
      const entry = byDigest.get(digest);
      if (entry === undefined) {
        return Promise.reject(
          new GeminiError(
            `no recording for ${model} ${digest}. The request changed, so the cassette is stale: ` +
              `re-record it rather than reaching for the network. Recorded: ` +
              `${[...byDigest.values()].map((e) => `${e.label} (${e.digest})`).join(", ") || "nothing"}`,
            { kind: "rejected" },
          ),
        );
      }
      return Promise.resolve(entry.response);
    },
  };
}

export interface Recorder extends Transport {
  /** Everything captured so far, ready to serialise. */
  cassette(recordedAt: string, note: string): Cassette;
}

/**
 * A transport that makes the real call and keeps the answer.
 *
 * Used once, by hand, by somebody holding an API key. Labels are supplied by the caller because only
 * the caller knows what an exchange *is* — `"a Hindi SMS for a transient failure"` is worth reading
 * in a diff and a sixteen-character hash is not.
 */
export function recording(inner: Transport, label: (request: GenerateRequest) => string): Recorder {
  const captured = new Map<string, CassetteEntry>();

  return {
    async call(model, request, deadlineMs) {
      const response = await inner.call(model, request, deadlineMs);
      const digest = requestDigest(model, request);
      captured.set(digest, { digest, label: label(request), model, response });
      return response;
    },
    cassette(recordedAt, note) {
      return { recordedAt, note, entries: [...captured.values()] };
    },
  };
}

export function serialiseCassette(cassette: Cassette): string {
  const entries = [...cassette.entries].sort((a, b) => (a.digest < b.digest ? -1 : 1));
  return `${JSON.stringify({ ...cassette, entries }, null, 2)}\n`;
}

/** Round-trip a response through JSON, which is what a cassette does to it. */
export function replayable(response: GenerateResponse): GenerateResponse {
  return GENERATE_RESPONSE.parse(JSON.parse(JSON.stringify(response)));
}
