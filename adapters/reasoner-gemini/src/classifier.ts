/**
 * The `ResidualClassifier` port, over Gemini.
 *
 * The one port on the money path. {@link Composer} runs at build time and {@link Explainer} runs
 * when a human is waiting; this one runs inside a held Terminus reservation, so every millisecond it
 * spends is a millisecond a bounded spend is in flight. Hence the tight defaults, and hence the fact
 * that it answers with one word: the shortest useful answer is also the cheapest and the fastest.
 *
 * ## What it is allowed to be wrong about
 *
 * Everything, and that is by design rather than by resignation. `refineResidual` consults this only
 * for a failure that fell through every deterministic rule, parses the answer into a closed enum,
 * discards anything else, and discounts what survives by `MODEL_CONFIDENCE` before it reaches the
 * expected-value gate. A wrong answer moves one casualty between recovery ladders at half
 * confidence. A hostile answer does the same thing, because there is nothing else the output can
 * express.
 */

import type { ClassifyRequest, Usage } from "@kairos/reason";
import { CLASSES, classifyPrompt } from "@kairos/reason";
import type { ResidualClassifier, ResidualInput } from "@kairos/recover";
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

export interface ClassifierOptions {
  readonly transport: Transport;
  readonly model: string;
  readonly thinkingLevel: ThinkingLevel;
  /**
   * Told what it costs, after every call.
   *
   * A callback rather than a return value because the port's signature is `Promise<string>` and was
   * designed that way before this adapter existed — the classifier's consumer wants a word, not an
   * invoice. But an inference call that nobody settles is the unbounded channel of spend that
   * putting `reason` in the action vocabulary was meant to close, so the cost has to leave here by
   * some door. This is the door.
   */
  readonly onUsage?: (usage: Usage, model: string) => void;
}

/**
 * One word, plus room for the model to be briefly wrong before the enum catches it.
 *
 * Small on purpose: the answer space is six words, and a ceiling that permits a paragraph is a
 * ceiling that pays for one.
 */
const MAX_OUTPUT_TOKENS = 32;

/** Deterministic. There is a right answer, and sampling for variety would only find wrong ones. */
const TEMPERATURE = 0;

export function geminiClassifier(options: ClassifierOptions): ResidualClassifier {
  const { transport, model } = options;

  return {
    name: `gemini:${model}`,

    async classify(input: ResidualInput, deadlineMs: number): Promise<string> {
      // The assignment is the compatibility check. `ResidualInput` lives in `@kairos/recover` and
      // `ClassifyRequest` in `@kairos/reason`, which do not depend on each other; if either drifts,
      // this line stops compiling rather than silently sending a prompt with a field missing.
      const request: ClassifyRequest = input;
      const prompt = classifyPrompt(request);

      const wire: GenerateRequest = {
        systemInstruction: { parts: [{ text: prompt.system }] },
        contents: [{ role: "user", parts: [{ text: prompt.user }] }],
        generationConfig: {
          temperature: TEMPERATURE,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          responseMimeType: "text/x.enum",
          // The closed list, enforced by the provider as well as by us. Two independent barriers
          // against the same failure, and the cheap one runs first.
          responseSchema: { type: "STRING", enum: [...CLASSES] },
          thinkingConfig: { thinkingLevel: options.thinkingLevel },
        },
      };

      const response = await transport.call(model, wire, deadlineMs);
      options.onUsage?.(usageOf(response), response.modelVersion ?? model);

      const finish = finishReasonOf(response);
      if (finish !== null && finish !== "STOP") {
        throw new GeminiError(`${model}: generation stopped with ${finish}`, { kind: "unusable" });
      }

      const text = textOf(response);
      if (text === null) {
        throw new GeminiError(`${model}: a candidate with no text in it`, { kind: "unusable" });
      }
      // Returned raw. `acceptModelClass` is the validator, it already exists, and it is tested where
      // it lives; re-implementing the check here would create a second definition of "acceptable"
      // that could drift from the first.
      return text;
    },
  };
}

/** What one classification would cost at its ceiling, for the reservation taken before it. */
export function classifyBudget(request: ClassifyRequest): {
  readonly inputTokens: number;
  readonly outputTokens: number;
} {
  const prompt = classifyPrompt(request);
  return {
    inputTokens: estimateTokens(prompt.system, prompt.user),
    outputTokens: MAX_OUTPUT_TOKENS,
  };
}
