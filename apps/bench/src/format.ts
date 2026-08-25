import type { CurveResult, ThresholdResult } from "./experiment.js";

function seconds(ms: number | null): string {
  return ms === null ? "—" : `${(ms / 1000).toFixed(0)}s`;
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
