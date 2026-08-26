/**
 * The interfaces an inference provider satisfies, and nothing about any particular one.
 *
 * Three narrow ports rather than one wide one, because they are consumed in three different places
 * at three different times and only one of them is on a path that matters for latency:
 *
 * - {@link Composer} runs **at build time**, not at send time. It is called about a hundred and
 *   eighty times, once, to write the copy library — and then never again until somebody regenerates
 *   it. Nothing in the recovery worker holds a reference to it.
 * - `ResidualClassifier` — declared in `@kairos/recover`, where its consumer is — runs inside a held
 *   Terminus reservation, which is the one place a slow model costs something real.
 * - {@link Explainer} runs when a human asks a question, so seconds are free.
 *
 * The asymmetry of leaving `ResidualClassifier` where it already lives is deliberate. It was written,
 * documented and tested against its consumer before this package existed, and moving a working port
 * for the symmetry of having all three in one file would be churn dressed as tidiness.
 */

import type { Usage } from "./price.js";
import type { CopySegment } from "./segment.js";

/**
 * What came back, and what it cost.
 *
 * Usage travels with the value rather than being fetched separately, because a caller that has to
 * remember to ask for the cost is a caller that will one day forget, and Terminus reconciles against
 * this. There is no path that returns a value without saying what it consumed.
 */
export interface ModelResult<T> {
  readonly value: T;
  readonly usage: Usage;
  /** Exactly as the provider names it, for the ledger and the library's provenance. */
  readonly model: string;
}

/** Copy as it comes back from a model: text, unvalidated, not yet a variant. */
export interface ProposedCopy {
  readonly body: string;
  /** Present only for email. The gauntlet rejects it in either direction. */
  readonly subject: string | null;
}

export interface ComposeRequest {
  readonly segment: CopySegment;
  /**
   * How many alternatives to write.
   *
   * More than one because the exploration bandit needs something to explore. Asking for three in a
   * single call rather than making three calls is most of why this integration fits inside a free
   * tier's daily quota.
   */
  readonly variants: number;
  /** Characters one segment holds in this language — the budget the copy has to live inside. */
  readonly charactersPerSegment: number;
}

export interface Composer {
  readonly model: string;
  compose(
    request: ComposeRequest,
    deadlineMs: number,
  ): Promise<ModelResult<readonly ProposedCopy[]>>;
}

/**
 * One thing that happened, already retrieved and already redacted.
 *
 * Flat strings rather than an `AuditRecord`, so this package does not depend on the ledger and so
 * that redaction is a step somebody had to perform rather than a property somebody hoped for. What
 * reaches a provider is what a caller deliberately put in these fields.
 */
export interface TimelineEntry {
  readonly at: string;
  readonly actor: string;
  readonly action: string;
  readonly allowed: boolean;
  readonly reason: string;
  /** Which limit bound, where one did. The field that turns a refusal into an explanation. */
  readonly binding: string | null;
}

export interface ExplanationRequest {
  /** What the operator asked, or the default question for the subject. */
  readonly question: string;
  /** What the subject is, in a form safe to publish — an id, never a person. */
  readonly subject: string;
  readonly timeline: readonly TimelineEntry[];
  /** The bounds in force, in plain language, so the answer can cite the one that bound. */
  readonly bounds: readonly string[];
}

export interface Explainer {
  readonly model: string;
  explain(request: ExplanationRequest, deadlineMs: number): Promise<ModelResult<string>>;
}
