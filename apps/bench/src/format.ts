import { formatINR, paise } from "@kairos/domain";
import type { CurveResult, ThresholdResult } from "./experiment.js";
import type { ArmResult, MixRow, SpendSweep, TailRow, TerminusArmResult } from "./spend.js";

function seconds(ms: number | null): string {
  return ms === null ? "—" : `${(ms / 1000).toFixed(0)}s`;
}

/** Render a plain paise count as rupees, revalidating the integer invariant on the way through. */
function inr(amount: number): string {
  return formatINR(paise(amount));
}

function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(0)}%`;
}

function pad(text: string, width: number, align: "left" | "right" = "left"): string {
  return align === "left" ? text.padEnd(width) : text.padStart(width);
}

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const aligned = (cells: readonly string[]): string =>
    cells.map((c, i) => pad(c, widths[i] ?? 0, i === 0 ? "left" : "right")).join("  ");

  return [aligned(headers), widths.map((w) => "─".repeat(w)).join("  "), ...rows.map(aligned)].join(
    "\n",
  );
}

/**
 * The headline table: what each threshold costs in false alarms and buys in detection speed.
 *
 * Both columns are reported for every row. A detection latency without its false-alarm rate is
 * meaningless — any detector can be made instant by alarming constantly.
 */
export function formatCurve(result: CurveResult): string {
  const rows = result.thresholds.map((t) => [
    t.threshold.toFixed(0),
    t.falseAlarmsPerHour.toFixed(2),
    `${t.totalFalseAlarms}`,
    percent(t.overallDetectionRate),
    seconds(t.overallMedianLatencyMs),
  ]);

  return table(["threshold", "false alarms/hr", "count", "detected", "median latency"], rows);
}

/** Per-scenario breakdown at one operating point, including the cases that go badly. */
export function formatScenarios(t: ThresholdResult): string {
  const rows = t.scenarios.map((s) => [
    s.scenario,
    percent(s.detectionRate),
    seconds(s.medianLatencyMs),
    seconds(s.p90LatencyMs),
    seconds(s.medianOnsetErrorMs),
    percent(s.rightAltitudeRate),
  ]);

  return table(["scenario", "detected", "median", "p90", "onset err", "right slice"], rows);
}

/**
 * Pick an operating point: fastest median detection among thresholds that stay under the
 * false-alarm budget.
 *
 * Stated as a budget rather than a preference because the cost of a false alarm here is real —
 * steering customers off a healthy rail causes exactly the loss the system exists to prevent.
 */
export function recommend(
  result: CurveResult,
  maxFalseAlarmsPerHour: number,
): ThresholdResult | null {
  const affordable = result.thresholds.filter((t) => t.falseAlarmsPerHour <= maxFalseAlarmsPerHour);
  if (affordable.length === 0) return null;

  return affordable.reduce((best, t) => {
    const bestLatency = best.overallMedianLatencyMs ?? Number.POSITIVE_INFINITY;
    const latency = t.overallMedianLatencyMs ?? Number.POSITIVE_INFINITY;
    if (t.overallDetectionRate > best.overallDetectionRate + 0.05) return t;
    if (best.overallDetectionRate > t.overallDetectionRate + 0.05) return best;
    return latency < bestLatency ? t : best;
  });
}

/**
 * Overspend against worker count — the table the kernel exists to produce.
 *
 * Worker count is the independent variable because it is the one a deployment changes without
 * thinking about it. Read down the naive column and the overspend grows with the fleet; read down
 * the kernel's and it does not, because the only term that multiplies the residual is the in-flight
 * cap, which is a mandate field rather than a deployment detail.
 */
export function formatSpendSweep(sweep: SpendSweep): string {
  const rows: string[][] = [];

  for (const workers of sweep.workerCounts) {
    const naive = sweep.naive.find((r) => r.workers === workers);
    if (naive !== undefined) rows.push(spendRow(naive));
    for (const result of sweep.terminus.filter((r) => r.workers === workers)) {
      rows.push(spendRow(result));
    }
  }

  return table(["workers  arm", "spent", "over", "bound", "sent", "used", "over cap"], rows);
}

function spendRow(result: ArmResult): string[] {
  return [
    `${result.workers.toString().padStart(3)}  ${result.arm}`,
    inr(result.spentPaise),
    result.overspendPaise === 0 ? "—" : inr(result.overspendPaise),
    result.boundPaise === null ? "unbounded" : inr(result.boundPaise),
    `${result.actionsTaken}`,
    percent(result.utilisation),
    `${result.capViolations}`,
  ];
}

/** What each reservation strategy bought and what it cost, at one worker count. */
export function formatSizers(results: readonly TerminusArmResult[]): string {
  const rows = results.map((r) => [
    r.sizer,
    inr(r.minReservationPaise),
    inr(r.spentPaise),
    `${r.actionsTaken}`,
    percent(r.utilisation),
    r.overspendPaise === 0 ? "—" : inr(r.overspendPaise),
    r.boundPaise === null ? "unbounded" : inr(r.boundPaise),
  ]);

  return table(["sizer", "min reserve", "spent", "sent", "used", "over", "bound"], rows);
}

/**
 * The tail comparison: does a smaller reservation get more work done as the budget tightens?
 *
 * This is the table that settles whether learning the reservation earns its place. The honest way
 * to read it is down the `lift` column — anything that rounds to zero means the machinery is
 * buying nothing that reserving the worst case did not already provide.
 */
export function formatTail(rows: readonly TailRow[]): string {
  const formatted = rows.map((r) => [
    inr(r.budgetPaise),
    r.sizer,
    `${r.actionsTaken}`,
    inr(r.spentPaise),
    r.overspendPaise === 0 ? "—" : inr(r.overspendPaise),
    `${r.liftOverWorstCase >= 0 ? "+" : ""}${(r.liftOverWorstCase * 100).toFixed(1)}%`,
  ]);

  return table(["budget", "sizer", "sent", "spent", "over", "lift"], formatted);
}

/**
 * Lift against the share of messages that cost the ceiling.
 *
 * Read this together with `formatTail`. If the learner never pulls meaningfully ahead of reserving
 * the worst case in either table, it is machinery for its own sake and the write-up should say so.
 */
export function formatMix(rows: readonly MixRow[]): string {
  const formatted = rows.map((r) => [
    percent(r.devanagariShare),
    r.sizer,
    inr(r.minReservationPaise),
    `${r.actionsTaken}`,
    r.overspendPaise === 0 ? "—" : inr(r.overspendPaise),
    `${r.liftOverWorstCase >= 0 ? "+" : ""}${(r.liftOverWorstCase * 100).toFixed(1)}%`,
  ]);

  return table(["3-seg share", "sizer", "min reserve", "sent", "over", "lift"], formatted);
}
