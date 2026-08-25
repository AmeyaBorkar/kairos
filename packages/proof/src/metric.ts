/**
 * A number the project claims, and how far it may move before the claim is a different one.
 *
 * Every benchmark in this repository is seeded, so a run is reproducible bit-for-bit: the same
 * configuration produces the same numbers for ever. That makes an exact snapshot tempting and
 * wrong. A change that consumes randomness differently — one extra draw, a loop reordered, a
 * refactor that touches nothing anybody cares about — does not make the system worse. It draws a
 * *new sample* from the same distribution. Gating on exact equality would fire on every one of
 * those, and a gate that fires on innocent changes is re-blessed without being read, which is the
 * same as not having a gate.
 *
 * So each metric carries a tolerance, and the tolerance is not a guess. It is chosen from the
 * measured seed-to-seed spread of that metric at fixed code — see `variance.ts` and
 * `docs/results/variance.txt`. A tolerance of three standard deviations means an innocent re-roll
 * passes about 997 times in 1,000, and anything larger is a real effect rather than the dice.
 *
 * What must *never* move at all does not live here. See {@link file://./invariant.ts}.
 */

import { formatINR, paise } from "@kairos/domain";

/** Which way is worse. Decides whether a move beyond tolerance fails the build. */
export type Direction = "lower-is-better" | "higher-is-better" | "neutral";

/**
 * `ratio` is a proportion and prints as a percentage; `rate` is a bare number that happens to be
 * small — false alarms per hour, a skill score — and prints as itself. Rendering 0.14 alarms an
 * hour as "14%" would be a unit error in a report about unit errors.
 */
export type Unit = "paise" | "ms" | "ratio" | "rate" | "count";

/** A number a harness produced. What the scorecard emits. */
export interface Observation {
  readonly id: string;
  readonly value: number;
  readonly direction: Direction;
  readonly unit: Unit;
  /** What this is, for somebody reading a failing build who has never opened the harness. */
  readonly label: string;
}

/** An observation that has been blessed, and so has a band around it. */
export interface GatedMetric extends Observation {
  /**
   * How far {@link Observation.value} may move before it means something, in the metric's own unit.
   *
   * `null` means nobody has calibrated this metric yet. It is reported and not enforced, because
   * failing a build on a band nobody chose would teach people to widen bands.
   */
  readonly tolerance: number | null;
  /** Seed-to-seed standard deviation the tolerance was chosen from. Informational. */
  readonly sd: number | null;
  /** How many seeds measured that spread. A tolerance from two seeds is not evidence. */
  readonly seeds: number | null;
  readonly note: string | null;
}

export type Outcome =
  /** Inside the band. */
  | "held"
  /** Moved the wrong way, beyond the band. The only outcome that fails a build. */
  | "regressed"
  /** Moved the right way, beyond the band. Re-bless, after checking the harness still measures. */
  | "improved"
  /** A `neutral` metric moved. Descriptive, so there is no wrong way for it to go. */
  | "drifted"
  /** No tolerance chosen. Reported, not enforced. */
  | "ungated"
  /** In the baseline, absent from the run. The harness stopped measuring something. */
  | "missing"
  /** In the run, absent from the baseline. A new metric, awaiting a tolerance. */
  | "unexpected";

/**
 * Where an observation falls against its baseline.
 *
 * The comparison is `>` rather than `>=` on purpose: a move of exactly the tolerance is inside the
 * band. The tolerance is a round number chosen by a human from a noisy standard deviation, and
 * treating its last digit as decisive would be pretending to a precision it does not have.
 */
export function classify(baseline: GatedMetric, observed: Observation): Outcome {
  if (baseline.tolerance === null) return "ungated";

  const delta = observed.value - baseline.value;
  if (Math.abs(delta) <= baseline.tolerance) return "held";
  if (baseline.direction === "neutral") return "drifted";

  const worse = baseline.direction === "lower-is-better" ? delta > 0 : delta < 0;
  return worse ? "regressed" : "improved";
}

/** Whether an outcome should stop a build. */
export function fails(outcome: Outcome): boolean {
  return outcome === "regressed" || outcome === "missing";
}

const MS = 1_000;
const MINUTE_MS = 60 * MS;

/**
 * Indian digit grouping for plain counts — last three digits, then pairs.
 *
 * Hand-rolled rather than delegated to `toLocaleString`, whose output depends on the runtime's ICU
 * build: a report that reads differently on a CI runner than on a laptop is a report people stop
 * trusting. This matches {@link formatINR} so the two never disagree in the same table.
 */
function grouped(n: number): string {
  const negative = n < 0;
  const digits = Math.abs(Math.round(n)).toString();
  const body =
    digits.length <= 3
      ? digits
      : `${digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${digits.slice(-3)}`;
  return `${negative ? "−" : ""}${body}`;
}

/**
 * Render a value for a human.
 *
 * Throws on a value that is not a safe integer number of paise, rather than printing `₹NaN`. A
 * metric that has gone non-finite is a defect in the harness, and a gate that quietly prints it is
 * worse than one that stops.
 */
export function formatValue(value: number, unit: Unit): string {
  switch (unit) {
    case "paise":
      return formatINR(paise(Math.round(value), "metric"));
    case "ms":
      if (Math.abs(value) < MS) return `${Math.round(value)}ms`;
      if (Math.abs(value) < MINUTE_MS) return `${(value / MS).toFixed(1)}s`;
      return `${(value / MINUTE_MS).toFixed(1)}min`;
    case "ratio":
      return `${(value * 100).toFixed(2)}%`;
    case "rate":
      return value.toFixed(3);
    case "count":
      return grouped(value);
  }
}

/**
 * A change, in the unit a reader can act on.
 *
 * Ratios move in percentage *points*, not percent, because "the loss rate improved by 12%" is
 * ambiguous in a way that costs arguments.
 */
export function formatDelta(delta: number, unit: Unit): string {
  const sign = delta > 0 ? "+" : delta < 0 ? "−" : "±";
  const magnitude = Math.abs(delta);
  if (unit === "ratio") return `${sign}${(magnitude * 100).toFixed(2)}pp`;
  return `${sign}${formatValue(magnitude, unit)}`;
}

/**
 * A tolerance as a share of the value it guards, for the report.
 *
 * Absolute tolerances are what the arithmetic uses — they come from a standard deviation, which has
 * units — but "±1.2s on 8.4s" is easier to judge as "±14%".
 */
export function toleranceShare(metric: GatedMetric): number | null {
  if (metric.tolerance === null || metric.value === 0) return null;
  return metric.tolerance / Math.abs(metric.value);
}
