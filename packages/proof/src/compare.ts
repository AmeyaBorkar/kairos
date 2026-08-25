/**
 * A run, judged against what the project claims.
 *
 * The judgement has two halves that behave differently on purpose, and the difference is the whole
 * design:
 *
 * - **Invariants are absolute.** They are checked always. "The audit chain verified" and "spend
 *   never exceeded the budget" are true of a run whatever experiment produced it, so changing the
 *   harness does not excuse them.
 * - **Metrics are relative.** A latency measured at 400 attempts a minute says nothing about a run
 *   at 200. When the configuration changes, the bands are not merely stale, they are *meaningless*,
 *   and comparing anyway would report a regression where somebody asked a different question.
 *
 * So a config-hash mismatch stops the metric comparison and leaves the invariants running. It still
 * fails the build — a baseline that no longer describes the experiment proves nothing, and letting
 * it slide would leave commits in the history where the gate was green and vacuous — but it fails
 * with its own reason and its own remedy, which is to re-bless rather than to go looking for a
 * performance bug that does not exist.
 */

import { checkInvariant, type InvariantCheck, type InvariantObservation } from "./invariant.js";
import { classify, fails, type GatedMetric, type Observation, type Outcome } from "./metric.js";
import type { Baseline, Scorecard } from "./scorecard.js";

export interface MetricVerdict {
  readonly id: string;
  readonly outcome: Outcome;
  /** Absent when the metric is new. */
  readonly baseline: GatedMetric | null;
  /** Absent when the metric has disappeared from the run. */
  readonly observed: Observation | null;
  /** Observed minus baseline. `null` when one side is missing. */
  readonly delta: number | null;
}

export interface InvariantVerdict {
  readonly observed: InvariantObservation;
  readonly check: InvariantCheck;
}

export interface Verdict {
  /** Whether the two runs asked the same question. False stops the metric comparison. */
  readonly comparable: boolean;
  /** Why they are not comparable, phrased with its remedy. `null` when they are. */
  readonly incomparableReason: string | null;
  /** Non-fatal observations worth printing — a Node version mismatch, uncalibrated metrics. */
  readonly advisories: readonly string[];
  readonly metrics: readonly MetricVerdict[];
  readonly invariants: readonly InvariantVerdict[];
  readonly failed: boolean;
}

/**
 * Node's major version, which is recorded and advised on but never gated.
 *
 * Floating-point results can differ in the last place between V8 releases, and a long simulation
 * can amplify that into a visibly different number. Rather than pretend otherwise, the bench job
 * pins one version, the baseline records the version it was blessed on, and a mismatch is printed
 * beside a regression so that "it only fails on Node 24" is the first thing a reader considers
 * instead of the last.
 */
function major(version: string): string {
  return /^v?(\d+)/.exec(version)?.[1] ?? version;
}

export function compare(baseline: Baseline, observed: Scorecard): Verdict {
  const advisories: string[] = [];
  const comparable = baseline.provenance.configHash === observed.provenance.configHash;

  const incomparableReason = comparable
    ? null
    : `the experiment changed: this run is configured as ${observed.provenance.configHash}, ` +
      `the baseline was blessed against ${baseline.provenance.configHash}. Metrics measured under ` +
      "different configurations are not comparable, so only the invariants were checked. Re-bless " +
      "with `pnpm bench:bless` and review the new numbers in the diff.";

  if (major(baseline.provenance.node) !== major(observed.provenance.node)) {
    advisories.push(
      `blessed on Node ${baseline.provenance.node}, running on ${observed.provenance.node}. ` +
        "Floating-point results can differ between V8 releases; pin the bench job if this recurs.",
    );
  }

  const invariants = observed.invariants.map((o) => ({ observed: o, check: checkInvariant(o) }));

  // Every invariant the baseline knows about must still be reported. One vanishing is the same
  // failure as one breaking: nothing is checking it any more.
  const reported = new Set(observed.invariants.map((i) => i.id));
  for (const expected of baseline.invariants) {
    if (reported.has(expected.id)) continue;
    invariants.push({
      observed: expected,
      check: {
        ok: false,
        reason: "the baseline expects this invariant and the run did not report it",
      },
    });
  }

  const metrics = comparable ? compareMetrics(baseline.metrics, observed.metrics) : [];

  const uncalibrated = metrics.filter((m) => m.outcome === "ungated" || m.outcome === "unexpected");
  if (uncalibrated.length > 0) {
    advisories.push(
      `${uncalibrated.length} metric${uncalibrated.length === 1 ? " has" : "s have"} no tolerance ` +
        `and ${uncalibrated.length === 1 ? "is" : "are"} reported without being enforced: ` +
        `${uncalibrated.map((m) => m.id).join(", ")}. Run \`pnpm bench:variance\` and set one.`,
    );
  }

  const failed =
    !comparable || invariants.some((i) => !i.check.ok) || metrics.some((m) => fails(m.outcome));

  return { comparable, incomparableReason, advisories, metrics, invariants, failed };
}

function compareMetrics(
  expected: readonly GatedMetric[],
  actual: readonly Observation[],
): MetricVerdict[] {
  const byId = new Map(actual.map((o) => [o.id, o]));
  const verdicts: MetricVerdict[] = [];

  for (const metric of expected) {
    const observed = byId.get(metric.id);
    if (observed === undefined) {
      verdicts.push({
        id: metric.id,
        outcome: "missing",
        baseline: metric,
        observed: null,
        delta: null,
      });
      continue;
    }
    byId.delete(metric.id);
    verdicts.push({
      id: metric.id,
      outcome: classify(metric, observed),
      baseline: metric,
      observed,
      delta: observed.value - metric.value,
    });
  }

  // Whatever is left is new. Reported, never fatal: adding a measurement should not break a build.
  for (const observed of byId.values()) {
    verdicts.push({
      id: observed.id,
      outcome: "unexpected",
      baseline: null,
      observed,
      delta: null,
    });
  }

  return verdicts;
}
