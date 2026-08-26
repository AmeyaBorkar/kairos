/**
 * The {@link Explainer} port, over Gemini.
 *
 * The easiest of the three and the one with the strictest requirement. It is easy because nobody is
 * waiting on a reservation and nothing downstream parses the answer — a human reads it. It is strict
 * because the answer is *about* an audit chain, and an explanation that says something the chain
 * does not is worse than no explanation at all: it launders a guess through a system whose entire
 * claim is that every number is traceable.
 *
 * Which is why the model is given the records rather than a database, and why it is told plainly
 * that "the trail does not show that" is a complete answer. It cannot retrieve, it cannot query, and
 * it cannot reach anything it was not handed. Retrieval and redaction happen before this file, in
 * the caller, on a machine that can read the ledger.
 *
 * The remaining risk is not access, it is *fluency* — a model that has been handed nine records and
 * writes a tenth-sounding sentence. That is a real failure mode and it is not solved here; it is
 * caught by the caller checking that every figure in the prose appears in the records it supplied.
 */

import type { Explainer, ExplanationRequest, ModelResult } from "@kairos/reason";
import { explainPrompt } from "@kairos/reason";
import { GeminiError } from "./errors.js";
import { estimateTokens } from "./tokens.js";
import type { Transport } from "./transport.js";
import {
  finishReasonOf,
  type GenerateRequest,
  type ThinkingLevel,
  textOf,
  usageOf,
} from "./wire.js";

export interface ExplainerOptions {
  readonly transport: Transport;
  readonly model: string;
  readonly thinkingLevel: ThinkingLevel;
  readonly temperature?: number;
}

/**
 * Room for four sentences and no more.
 *
 * The prompt asks for three or four; the ceiling is what makes that a constraint rather than a
 * suggestion. An operator reading this is deciding what to do next, and a page of prose is a page
 * they will skim.
 */
const MAX_OUTPUT_TOKENS = 400;

/** Low. This is recall from a supplied list, and creativity here has another name. */
const DEFAULT_TEMPERATURE = 0.2;

export function geminiExplainer(options: ExplainerOptions): Explainer {
  const { transport, model } = options;

  return {
    model,

    async explain(request: ExplanationRequest, deadlineMs: number): Promise<ModelResult<string>> {
      const prompt = explainPrompt(request);

      const wire: GenerateRequest = {
        systemInstruction: { parts: [{ text: prompt.system }] },
        contents: [{ role: "user", parts: [{ text: prompt.user }] }],
        generationConfig: {
          temperature: options.temperature ?? DEFAULT_TEMPERATURE,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          responseMimeType: "text/plain",
          thinkingConfig: { thinkingLevel: options.thinkingLevel },
        },
      };

      const response = await transport.call(model, wire, deadlineMs);
      const finish = finishReasonOf(response);

      // `MAX_TOKENS` is survivable here in a way it is not for copy: a truncated explanation is
      // still true as far as it goes, and an operator can see that it stops. It is still refused,
      // because a sentence that ends mid-clause reads as a system fault and would send somebody
      // looking for one.
      if (finish !== null && finish !== "STOP") {
        throw new GeminiError(`${model}: generation stopped with ${finish}`, { kind: "unusable" });
      }

      const text = textOf(response);
      if (text === null) {
        throw new GeminiError(`${model}: a candidate with no text in it`, { kind: "unusable" });
      }

      return {
        value: text.trim(),
        usage: usageOf(response),
        model: response.modelVersion ?? model,
      };
    },
  };
}

/** What one explanation would cost at its ceiling, for the reservation taken before it. */
export function explainBudget(request: ExplanationRequest): {
  readonly inputTokens: number;
  readonly outputTokens: number;
} {
  const prompt = explainPrompt(request);
  return {
    inputTokens: estimateTokens(prompt.system, prompt.user),
    outputTokens: MAX_OUTPUT_TOKENS,
  };
}
