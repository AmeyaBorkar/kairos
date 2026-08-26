/**
 * The {@link Composer} port, over Gemini.
 *
 * Thin, and meant to be. All the judgement lives elsewhere: `@kairos/reason` decides what to ask,
 * the gauntlet decides what is acceptable, Terminus decides whether it may be paid for. What is
 * left here is turning one into a `generateContent` call and the answer back into
 * {@link ProposedCopy}, plus the three ways that can go wrong quietly.
 *
 * ## The three quiet failures
 *
 * 1. **A 200 that is truncated.** `finishReason: "MAX_TOKENS"` comes back with a normal status and
 *    a half-written JSON object. Checked before parsing, because the parse error it produces
 *    otherwise points at a stray brace instead of at the budget.
 * 2. **A 200 with no text at all.** A safety block, or a candidate whose only part is a
 *    `thoughtSignature`. `textOf` returns `null` rather than the empty string so this is a branch
 *    somebody had to write.
 * 3. **Valid JSON that is not what was asked for.** `responseSchema` makes this rare, not
 *    impossible, so the payload is parsed rather than cast.
 *
 * None of the three throws past the caller as an unrecognisable error: each becomes a `GeminiError`
 * with a `kind`, and a segment that fails is a segment the library does not cover — which is an
 * ordinary condition the copy library was designed to have.
 */

import type { ComposeRequest, Composer, ModelResult, ProposedCopy } from "@kairos/reason";
import { composePrompt } from "@kairos/reason";
import { z } from "zod";
import { GeminiError } from "./errors.js";
import { estimateTokens } from "./tokens.js";
import type { Transport } from "./transport.js";
import {
  finishReasonOf,
  type GenerateRequest,
  type ResponseSchema,
  type ThinkingLevel,
  textOf,
  usageOf,
} from "./wire.js";

export interface ComposerOptions {
  readonly transport: Transport;
  readonly model: string;
  readonly thinkingLevel: ThinkingLevel;
  /**
   * How different the three variants are allowed to be from each other.
   *
   * High, and deliberately so. The variants exist to give the exploration bandit something to
   * explore; three rewordings of one sentence are three arms that will converge on the same
   * conversion rate and waste the experiment. Sampling variety is the entire product of this call.
   */
  readonly temperature?: number;
}

const DEFAULT_TEMPERATURE = 1.0;

/**
 * Output budget per variant, by channel.
 *
 * Generous against the actual need — an SMS body is at most 160 characters, or about fifty tokens —
 * because the ceiling is what gets reserved and reconciled, not what gets paid. Being tight here
 * buys nothing and costs a `MAX_TOKENS` truncation, which is a wasted call *and* a wasted quota
 * unit.
 */
const TOKENS_PER_VARIANT = {
  "contact-sms": 200,
  "contact-whatsapp": 260,
  "contact-email": 500,
} as const;

/** Headroom for the JSON scaffolding, and for a model that thinks a little despite being asked not to. */
const OUTPUT_ENVELOPE_TOKENS = 256;

const PROPOSED = z.object({
  variants: z
    .array(z.object({ body: z.string(), subject: z.string().optional() }))
    .min(1, "the model returned no variants"),
});

/**
 * The shape the model must answer in, which differs by channel in one important way.
 *
 * An SMS schema has no `subject` property at all — so a subject line on an SMS is not something the
 * gauntlet has to reject, it is something the model has no way to emit. Enforcing a constraint at
 * the provider where the provider can enforce it leaves the gauntlet guarding the things only we can
 * check.
 */
export function schemaFor(isEmail: boolean, variants: number): ResponseSchema {
  const item: ResponseSchema = {
    type: "OBJECT",
    properties: isEmail
      ? {
          subject: { type: "STRING", description: "At most 60 characters. No placeholders." },
          body: { type: "STRING", description: "Two or three short sentences." },
        }
      : { body: { type: "STRING", description: "The message text, with placeholders." } },
    required: isEmail ? ["subject", "body"] : ["body"],
    ...(isEmail ? { propertyOrdering: ["subject", "body"] } : {}),
  };

  return {
    type: "OBJECT",
    properties: {
      variants: {
        type: "ARRAY",
        items: item,
        description: `Exactly ${variants} genuinely different messages.`,
      },
    },
    required: ["variants"],
  };
}

/** What one compose call would cost at its ceiling, for the reservation taken before it. */
export function budgetFor(request: ComposeRequest): {
  readonly inputTokens: number;
  readonly outputTokens: number;
} {
  const prompt = composePrompt(request);
  const perVariant = TOKENS_PER_VARIANT[request.segment.channel];
  return {
    inputTokens: estimateTokens(prompt.system, prompt.user),
    outputTokens: request.variants * perVariant + OUTPUT_ENVELOPE_TOKENS,
  };
}

export function geminiComposer(options: ComposerOptions): Composer {
  const { transport, model } = options;

  return {
    model,

    async compose(request, deadlineMs): Promise<ModelResult<readonly ProposedCopy[]>> {
      const prompt = composePrompt(request);
      const { outputTokens } = budgetFor(request);
      const isEmail = request.segment.channel === "contact-email";

      const wire: GenerateRequest = {
        systemInstruction: { parts: [{ text: prompt.system }] },
        contents: [{ role: "user", parts: [{ text: prompt.user }] }],
        generationConfig: {
          temperature: options.temperature ?? DEFAULT_TEMPERATURE,
          maxOutputTokens: outputTokens,
          responseMimeType: "application/json",
          responseSchema: schemaFor(isEmail, request.variants),
          thinkingConfig: { thinkingLevel: options.thinkingLevel },
        },
      };

      const response = await transport.call(model, wire, deadlineMs);
      const finish = finishReasonOf(response);

      if (finish === "MAX_TOKENS") {
        throw new GeminiError(
          `${model}: the answer was cut off at ${outputTokens} tokens, so its JSON is incomplete`,
          { kind: "unusable" },
        );
      }
      if (finish !== null && finish !== "STOP") {
        throw new GeminiError(`${model}: generation stopped with ${finish}`, { kind: "unusable" });
      }

      const text = textOf(response);
      if (text === null) {
        throw new GeminiError(`${model}: a candidate with no text in it`, { kind: "unusable" });
      }

      return {
        value: parseProposals(text, isEmail, model),
        usage: usageOf(response),
        model: response.modelVersion ?? model,
      };
    },
  };
}

/**
 * Turn the JSON payload into proposals, normalising the one field that has two spellings for
 * "absent".
 *
 * A model asked for no subject may still answer with `""`, and `""` is not `null` — the gauntlet
 * rejects a subject on an SMS, and rejecting an empty string would be rejecting the model for
 * complying. Whitespace-only collapses to `null` for the same reason; a subject line of three
 * spaces is an absent subject with a formatting accident on top.
 */
export function parseProposals(
  text: string,
  isEmail: boolean,
  model: string,
): readonly ProposedCopy[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error: unknown) {
    throw new GeminiError(`${model}: the answer was not JSON`, { kind: "unusable", cause: error });
  }

  const parsed = PROPOSED.safeParse(raw);
  if (!parsed.success) {
    throw new GeminiError(`${model}: the answer was JSON of the wrong shape`, {
      kind: "unusable",
      cause: parsed.error,
    });
  }

  return parsed.data.variants.map((variant) => {
    const subject = variant.subject?.trim() ?? "";
    return { body: variant.body, subject: isEmail && subject.length > 0 ? subject : null };
  });
}
