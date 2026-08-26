/**
 * The whole question-answering path: retrieve, ask, verify, and refuse.
 *
 * The last of those is the one worth reading. An explanation that fails its honesty check is **not
 * returned as an answer with a warning attached** — it is returned as a failure with the offending
 * figures named. A warning next to fluent prose is read by nobody; an operator looking at an
 * incident at two in the morning will read the sentence and act on it, and the caveat above it is
 * decoration. If the check cannot vouch for the numbers, there is no answer.
 *
 * ## What this does not do
 *
 * It does not spend. There is no Terminus admission here, and that is deliberate rather than an
 * omission: `explain` is called when a human asks a question, about work that has already happened,
 * and it changes nothing. The kernel exists to bound actions that touch money or customers, and an
 * operator reading their own audit log is neither. What it *does* cost is provider tokens, which is
 * a real cost with no bound on it — recorded honestly here rather than solved, because the fix is
 * an admission axis for read-only inference and that is not built.
 */

import type { Explainer, ExplanationRequest, TimelineEntry } from "@kairos/reason";
import { verifyExplanation } from "@kairos/reason";
import { type RecordSource, type RetrievalOptions, retrieve } from "./retrieve.js";

export interface ExplainOptions extends RetrievalOptions {
  readonly source: RecordSource;
  readonly explainer: Explainer;
  /** The bounds in force, already in plain language — see `describeBounds`. */
  readonly bounds: readonly string[];
  /** What the operator asked. Defaults to the general question about the subject. */
  readonly question?: string;
  readonly deadlineMs?: number;
}

export type Explanation =
  | {
      readonly ok: true;
      readonly prose: string;
      readonly timeline: readonly TimelineEntry[];
      readonly truncated: number;
      readonly model: string;
      /** Figures the answer quoted. Every one of them was in a record. */
      readonly cited: readonly string[];
    }
  | {
      readonly ok: false;
      readonly why: "no-records" | "unsupported-figures";
      readonly detail: string;
      readonly timeline: readonly TimelineEntry[];
      /** The prose that was rejected, so a developer can see what the model actually said. */
      readonly rejected: string | null;
    };

const DEFAULT_DEADLINE_MS = 20_000;

export async function explain(options: ExplainOptions): Promise<Explanation> {
  const retrieved = retrieve(options.source, options);

  if (retrieved.timeline.length === 0) {
    // Distinguished from a model failure because it is a different problem with a different fix:
    // the id is wrong, or the chain being read is not the one that recorded it. Asking a model to
    // explain an empty history invites it to invent one.
    return {
      ok: false,
      why: "no-records",
      detail: `nothing in the audit chain has target ${options.target}`,
      timeline: [],
      rejected: null,
    };
  }

  const question = options.question ?? `Why did Kairos treat ${options.target} the way it did?`;
  const request: ExplanationRequest = {
    question,
    subject: options.target,
    timeline: retrieved.timeline,
    bounds: options.bounds,
  };

  const result = await options.explainer.explain(
    request,
    options.deadlineMs ?? DEFAULT_DEADLINE_MS,
  );

  // The question and the subject join the sources: an operator who asks about `cas_9f21` on
  // `2026-08-24` has supplied those tokens, and an answer repeating them is quoting rather than
  // inventing. The bounds join for the same reason — they are what a refusal is explained with.
  const sources = [...retrieved.sources, ...options.bounds, question, options.target];
  const verdict = verifyExplanation(result.value, sources);

  if (!verdict.ok) {
    return {
      ok: false,
      why: "unsupported-figures",
      detail:
        `the answer used ${verdict.unsupported.length} figure(s) that appear in no record: ` +
        verdict.unsupported.join(", "),
      timeline: retrieved.timeline,
      rejected: result.value,
    };
  }

  return {
    ok: true,
    prose: result.value,
    timeline: retrieved.timeline,
    truncated: retrieved.truncated,
    model: result.model,
    cited: verdict.cited,
  };
}
