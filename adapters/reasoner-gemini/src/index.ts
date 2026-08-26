/**
 * Google Gemini behind the three reasoner ports.
 *
 * Nothing above this package imports anything from it except {@link geminiReasoners} and the config
 * — the recovery worker, the benchmark and the copy generator all hold ports. Swapping provider is a
 * sibling directory.
 */

export {
  CASSETTE,
  type Cassette,
  type CassetteEntry,
  cassetteKey,
  parseCassette,
  type Recorder,
  recording,
  replayable,
  replaying,
  serialiseCassette,
} from "./cassette.js";
export { type ClassifierOptions, classifyBudget, geminiClassifier } from "./classifier.js";
export {
  budgetFor,
  type ComposerOptions,
  geminiComposer,
  parseProposals,
  schemaFor,
} from "./composer.js";
export {
  configFromEnv,
  configFromProcess,
  DEFAULTS,
  describeConfig,
  type GeminiConfig,
} from "./config.js";
export {
  detailsOf,
  errorForResponse,
  type FailureKind,
  GeminiError,
  kindForStatus,
  parseDuration,
  type QuotaViolation,
} from "./errors.js";
export { type ExplainerOptions, explainBudget, geminiExplainer } from "./explainer.js";
export { type Pace, type PacingOptions, pacer } from "./pacing.js";
export { GEMINI_PRICES, type GeminiPrice, priceFor, RUPEES_PER_USD } from "./price.js";
export { estimateTokens } from "./tokens.js";
export { httpTransport, type Transport, type TransportOptions, waitFor } from "./transport.js";
export {
  type FinishReason,
  finishReasonOf,
  type GenerateRequest,
  type GenerateResponse,
  type GenerationConfig,
  type ResponseSchema,
  type ThinkingLevel,
  textOf,
  usageOf,
} from "./wire.js";

import type { Composer, Explainer } from "@kairos/reason";
import type { ResidualClassifier } from "@kairos/recover";
import { geminiClassifier } from "./classifier.js";
import { geminiComposer } from "./composer.js";
import type { GeminiConfig } from "./config.js";
import { geminiExplainer } from "./explainer.js";
import { pacer } from "./pacing.js";
import { type GeminiPrice, priceFor } from "./price.js";
import { httpTransport, type Transport, type TransportOptions } from "./transport.js";

export interface Reasoners {
  readonly composer: Composer;
  readonly explainer: Explainer;
  readonly classifier: ResidualClassifier;
  /** Shared. One pace across all three, because the provider counts them together. */
  readonly transport: Transport;
  readonly price: GeminiPrice;
}

export interface ReasonersOptions {
  readonly config: GeminiConfig;
  /** Substituted by a cassette in every test and every CI run. */
  readonly transport?: Transport;
  readonly fetch?: typeof globalThis.fetch;
  /** Called before each retry, so a long pause has a visible explanation rather than none. */
  readonly onRetry?: NonNullable<TransportOptions["onRetry"]>;
}

/**
 * All three ports, sharing one transport and therefore one pace.
 *
 * Sharing matters: the provider's rate limit is per project and per model, not per port, so three
 * independently-paced clients would each believe they had the whole allowance and together have
 * three times too much of it. The place to enforce a shared bound is the shared object.
 *
 * The price is resolved here rather than lazily, so a model with no price entry fails at
 * construction — before a reservation has been taken against a cost of zero.
 */
export function geminiReasoners(options: ReasonersOptions): Reasoners {
  const { config } = options;
  const price = priceFor(config.model);

  const transport =
    options.transport ??
    httpTransport({
      config,
      pace: pacer({
        requestsPerMinute: config.requestsPerMinute,
        requestsPerDay: config.requestsPerDay,
      }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.onRetry === undefined ? {} : { onRetry: options.onRetry }),
    });

  const shared = {
    transport,
    model: config.model,
    thinkingLevel: config.thinkingLevel,
  } as const;

  return {
    transport,
    price,
    composer: geminiComposer(shared),
    explainer: geminiExplainer(shared),
    classifier: geminiClassifier(shared),
  };
}
