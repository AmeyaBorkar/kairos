import {
  type FailureDetail,
  isRecoverabilityClass,
  type RecoverabilityClass,
} from "@kairos/domain";
import { type Classification, isResidual } from "./classify.js";

/**
 * What a model is allowed to see about a failure it is being asked to classify.
 *
 * Everything here is a gateway error code, not a person. No name, no phone number, no email, no
 * amount — the classification question does not need them, and a field that is never assembled
 * cannot be exfiltrated by a prompt that asks for it.
 *
 * `untrustedDescription` is named the way it is so that a future prompt builder cannot treat it as
 * ordinary text by accident. It is free-form prose written by a gateway, relayed through Razorpay,
 * and in the general case influenced by data an attacker controls.
 */
export interface ResidualInput {
  readonly code: string;
  readonly source: string;
  readonly step: string;
  readonly reason: string;
  /** Delimited and labelled as data by any prompt that carries it. Never concatenated as instruction. */
  readonly untrustedDescription: string;
}

/**
 * A classifier for failures the rule table could not name.
 *
 * Deliberately a port with a string return rather than a typed one. The implementation is a
 * language model, and a model returns text; pretending otherwise at the type level would move the
 * validation somewhere less obvious than the boundary it belongs at.
 */
export interface ResidualClassifier {
  readonly name: string;
  /** Resolve within `deadlineMs`. Rejecting, timing out, and answering nonsense are all handled. */
  classify(input: ResidualInput, deadlineMs: number): Promise<string>;
}

/**
 * How much a model-sourced classification is trusted.
 *
 * Half. Not tuned — chosen to be visibly less than the weakest deterministic rule and visibly more
 * than knowing nothing, so the discount is legible rather than precise. It flows into the recovery
 * probability, which flows into the expected-value gate, which is what actually decides whether any
 * money is spent.
 */
export const MODEL_CONFIDENCE = 0.5;

export interface ResidualOptions {
  readonly classifier: ResidualClassifier;
  /** How long the model gets before its answer stops being worth waiting for. */
  readonly deadlineMs: number;
}

/**
 * Ask a model about a failure the table could not classify, and accept the answer only if it is one
 * of the six words it was allowed to say.
 *
 * ## What a successful prompt injection buys an attacker
 *
 * Stated plainly, because "the model never gates money" is a claim that deserves an accounting.
 *
 * The model is consulted **only** for a failure that fell through every rule, and its output is
 * parsed into a closed enum — anything else is discarded. So the most it can do is move one
 * casualty from the `unknown` ladder (one cheap contact, then stop) to another class's ladder. The
 * largest such move is to `customer-action`, which is worth at most two additional messages. Those
 * messages are still subject to the per-customer contact cap, the campaign budget, the quiet-hours
 * window, and the expected-value gate — none of which the model can see, let alone influence.
 *
 * And the gate is where the discount lands: a model-sourced class carries {@link MODEL_CONFIDENCE},
 * which shrinks the recovery probability toward the population base rate, which lowers the expected
 * return, which means a marginal casualty the table would have chased is one the model's guess will
 * not. Uncertainty about the cause becomes reluctance to spend, through the ordinary machinery.
 *
 * The worst outcome of a successful injection remains a badly-targeted SMS, not a solvency event.
 *
 * ## Failure is not an error
 *
 * A model that is slow, unreachable, or talking nonsense produces the deterministic classification
 * unchanged. There is no path in which the recovery arm stops working because an inference endpoint
 * did (P2). That is also why this returns the original rather than throwing.
 */
export async function refineResidual(
  deterministic: Classification,
  failure: FailureDetail,
  options: ResidualOptions,
): Promise<Classification> {
  if (!isResidual(deterministic)) return deterministic;

  const input: ResidualInput = {
    code: failure.code,
    source: failure.source,
    step: failure.step,
    reason: failure.reason,
    untrustedDescription: failure.description,
  };

  let raw: string;
  try {
    raw = await withDeadline(
      options.classifier.classify(input, options.deadlineMs),
      options.deadlineMs,
    );
  } catch {
    return deterministic;
  }

  const accepted = acceptModelClass(raw);
  if (accepted === null) return deterministic;

  return {
    recoverability: accepted,
    rule: `model:${options.classifier.name}`,
    source: "model",
    confidence: MODEL_CONFIDENCE,
  };
}

/**
 * Parse a model's answer into the closed enum, or reject it.
 *
 * Tolerant of whitespace and case and nothing else. Not tolerant of a sentence containing the right
 * word, because "this is definitely not transient" contains `transient`, and a substring match is
 * how a validator becomes a vulnerability.
 */
export function acceptModelClass(raw: unknown): RecoverabilityClass | null {
  if (typeof raw !== "string") return null;
  const candidate = raw.trim().toLowerCase();
  return isRecoverabilityClass(candidate) ? candidate : null;
}

/**
 * A deadline the caller can rely on even when the callee ignores its own.
 *
 * An adapter that promises to respect `deadlineMs` and then hangs would otherwise stall a worker
 * holding a Terminus reservation, and a reservation held past its TTL is how a bounded spend
 * becomes an orphan. Belt and braces, on the side where the cost of being wrong is highest.
 */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`residual classifier exceeded ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
