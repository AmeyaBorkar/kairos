/**
 * The two documents: what a run produced, and what the project has agreed it should produce.
 *
 * They are deliberately different types. A {@link Scorecard} is an observation — it has no opinion
 * about whether its numbers are good. A {@link Baseline} is a commitment: the same numbers, plus
 * the band each one is allowed to move within, plus who agreed to it and when. Conflating them
 * would let a run bless itself, which is the whole failure mode a regression gate exists to stop.
 */

import { z } from "zod";
import type { InvariantObservation } from "./invariant.js";
import type { GatedMetric, Observation } from "./metric.js";
import type { JsonValue, Provenance } from "./provenance.js";

export interface Scorecard {
  readonly provenance: Provenance;
  readonly metrics: readonly Observation[];
  readonly invariants: readonly InvariantObservation[];
  /** Wall clock. Recorded on a run, never on a baseline — see {@link Baseline}. */
  readonly elapsedMs: number;
}

export interface Baseline {
  readonly provenance: Provenance;
  /** Date only. A bless is a deliberate act and deserves a date; a clock time would be noise. */
  readonly blessedAt: string;
  readonly metrics: readonly GatedMetric[];
  readonly invariants: readonly InvariantObservation[];
}

// ── Schemas ───────────────────────────────────────────────────────────────────────────────────
//
// The baseline is read from disk and decides whether a build passes. A malformed one must stop the
// build loudly rather than degrade into comparing nothing, so every field is required and unknown
// keys are rejected: a typo in `tolerence` should not silently produce an ungated metric.

const JSON_VALUE: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JSON_VALUE),
    z.record(z.string(), JSON_VALUE),
  ]),
);

const PROVENANCE = z.strictObject({
  profile: z.string().min(1),
  configHash: z.string().regex(/^[0-9a-f]{16}$/, "expected sixteen lowercase hex characters"),
  codeRevision: z.string().min(1),
  node: z.string().min(1),
  config: JSON_VALUE,
});

const DIRECTION = z.enum(["lower-is-better", "higher-is-better", "neutral"]);
const UNIT = z.enum(["paise", "ms", "ratio", "count"]);

const OBSERVATION = z.strictObject({
  id: z.string().min(1),
  value: z.number().finite(),
  direction: DIRECTION,
  unit: UNIT,
  label: z.string().min(1),
});

const GATED_METRIC = OBSERVATION.extend({
  tolerance: z.number().finite().nonnegative().nullable(),
  sd: z.number().finite().nonnegative().nullable(),
  seeds: z.number().int().positive().nullable(),
  note: z.string().nullable(),
});

const INVARIANT = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(["zero", "positive", "true", "exact"]),
  value: z.union([z.number().finite(), z.boolean()]),
  expected: z.number().finite().nullable(),
  label: z.string().min(1),
});

export const SCORECARD = z.strictObject({
  provenance: PROVENANCE,
  metrics: z.array(OBSERVATION),
  invariants: z.array(INVARIANT),
  elapsedMs: z.number().nonnegative(),
});

export const BASELINE = z.strictObject({
  provenance: PROVENANCE,
  blessedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected an ISO date, e.g. 2026-08-26"),
  metrics: z.array(GATED_METRIC),
  invariants: z.array(INVARIANT),
});

/** Parse a baseline, throwing a message a human can act on. */
export function parseBaseline(raw: unknown): Baseline {
  const parsed = BASELINE.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("\n");
    throw new Error(`the baseline document is not valid:\n${issues}`);
  }
  return parsed.data;
}

export function parseScorecard(raw: unknown): Scorecard {
  const parsed = SCORECARD.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("\n");
    throw new Error(`the scorecard document is not valid:\n${issues}`);
  }
  return parsed.data;
}

export interface BlessResult {
  readonly baseline: Baseline;
  /** Metric ids that arrived without a tolerance, so are recorded but not enforced. */
  readonly uncalibrated: readonly string[];
  /** Metric ids in the previous baseline and absent from this run. Dropped, and worth saying so. */
  readonly dropped: readonly string[];
  /** Whether anything but the date actually changed. Lets a bless be a no-op instead of a diff. */
  readonly changed: boolean;
}

/**
 * Fold a run into the baseline it will become.
 *
 * **A bless updates values and never widens a band.** Tolerances, and the standard deviations they
 * were chosen from, are carried across from the previous baseline by id. Recomputing them from the
 * run being blessed would let a metric that drifted set its own gate wider on the way past, and the
 * gate would ratchet open one innocent commit at a time until it caught nothing. Widening is a
 * deliberate edit to the committed file, reviewed like any other change, and the `sd` and `seeds`
 * fields sitting beside the tolerance are what a reviewer checks it against.
 *
 * A metric with no previous entry is recorded with a `null` tolerance and reported as
 * uncalibrated, rather than being given a guess.
 */
export function bless(
  previous: Baseline | null,
  observed: Scorecard,
  blessedAt: string,
): BlessResult {
  const carried = new Map(previous?.metrics.map((m) => [m.id, m]) ?? []);
  const uncalibrated: string[] = [];

  const metrics = observed.metrics.map((observation): GatedMetric => {
    const before = carried.get(observation.id);
    if (before === undefined) {
      uncalibrated.push(observation.id);
      return { ...observation, tolerance: null, sd: null, seeds: null, note: null };
    }
    if (before.tolerance === null) uncalibrated.push(observation.id);
    return {
      ...observation,
      tolerance: before.tolerance,
      sd: before.sd,
      seeds: before.seeds,
      note: before.note,
    };
  });

  const seen = new Set(metrics.map((m) => m.id));
  const dropped = [...carried.keys()].filter((id) => !seen.has(id));

  const baseline: Baseline = {
    provenance: observed.provenance,
    blessedAt,
    metrics,
    invariants: observed.invariants,
  };

  return { baseline, uncalibrated, dropped, changed: differs(previous, baseline) };
}

/**
 * Whether a bless would change anything a reader should see.
 *
 * The date is excluded on purpose. Re-running a bless that produced identical numbers should leave
 * the file untouched, so that every change to the baseline in the history is a change to what the
 * project claims — and `git log docs/results/baseline-quick.json` reads as a list of those.
 */
function differs(previous: Baseline | null, next: Baseline): boolean {
  if (previous === null) return true;
  const strip = (b: Baseline): string =>
    JSON.stringify({ provenance: b.provenance, metrics: b.metrics, invariants: b.invariants });
  return strip(previous) !== strip(next);
}

/** Serialise a baseline the way it is committed: stable key order, trailing newline. */
export function serialiseBaseline(baseline: Baseline): string {
  return `${JSON.stringify(baseline, null, 2)}\n`;
}
