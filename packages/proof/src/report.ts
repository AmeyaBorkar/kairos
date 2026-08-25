/**
 * What a failing build shows.
 *
 * The audience is somebody who has just had a pull request go red and has not opened the harness.
 * They need three things in the first screen: which claim broke, by how much, and whether that is a
 * lot. Everything here is arranged around those, which is why each row carries the tolerance it
 * blew through — a report that says a number moved without saying how far it was allowed to move
 * makes the reader go and find the baseline file, and most will just re-run the job instead.
 *
 * Plain ASCII markers rather than colour: this is read in a GitHub Actions log, in a terminal
 * without a TTY, and in a pasted screenshot.
 */

import type { MetricVerdict, Verdict } from "./compare.js";
import { formatDelta, formatValue, type Outcome, toleranceShare } from "./metric.js";

const MARK: Record<Outcome, string> = {
  held: "  ok  ",
  regressed: " FAIL ",
  improved: " up   ",
  drifted: " drift",
  ungated: " —    ",
  missing: " GONE ",
  unexpected: " new  ",
};

/** Ordered worst-first, so the reason the build is red is the first thing on the screen. */
const SEVERITY: Record<Outcome, number> = {
  missing: 0,
  regressed: 1,
  drifted: 2,
  improved: 3,
  unexpected: 4,
  ungated: 5,
  held: 6,
};

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function padStart(text: string, width: number): string {
  return text.length >= width ? text : " ".repeat(width - text.length) + text;
}

function metricRow(verdict: MetricVerdict): readonly string[] {
  const { baseline, observed, delta, outcome } = verdict;
  const unit = observed?.unit ?? baseline?.unit ?? "count";

  const band = (() => {
    if (baseline === null) return "not yet gated";
    if (baseline.tolerance === null) return "not yet gated";
    const share = toleranceShare(baseline);
    const absolute = `±${formatValue(baseline.tolerance, unit)}`;
    return share === null ? absolute : `${absolute} (${(share * 100).toFixed(0)}%)`;
  })();

  return [
    MARK[outcome],
    verdict.id,
    baseline === null ? "—" : formatValue(baseline.value, unit),
    observed === null ? "—" : formatValue(observed.value, unit),
    delta === null ? "—" : formatDelta(delta, unit),
    band,
  ];
}

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) return "";
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => (row[i] ?? "").length)),
  );
  // Left-align the marker, name and band; right-align every number so magnitudes line up.
  const alignRight = new Set([2, 3, 4]);
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, i) =>
        alignRight.has(i) ? padStart(cell, widths[i] ?? 0) : pad(cell, widths[i] ?? 0),
      )
      .join("  ")
      .trimEnd();

  return [line(headers), widths.map((w) => "─".repeat(w)).join("  "), ...rows.map(line)].join("\n");
}

export function renderVerdict(verdict: Verdict): string {
  const out: string[] = [];

  out.push("Bench regression gate");
  out.push("═".repeat(78));

  if (verdict.incomparableReason !== null) {
    out.push("");
    out.push(`INCOMPARABLE — ${verdict.incomparableReason}`);
  }

  const broken = verdict.invariants.filter((i) => !i.check.ok);
  out.push("");
  out.push(
    broken.length === 0
      ? `Invariants — all ${verdict.invariants.length} held.`
      : `Invariants — ${broken.length} of ${verdict.invariants.length} BROKEN.`,
  );
  for (const { observed, check } of broken) {
    out.push(`  FAIL  ${observed.id}: ${check.reason}`);
    out.push(`        ${observed.label}`);
  }

  if (verdict.comparable) {
    const sorted = [...verdict.metrics].sort(
      (a, b) => SEVERITY[a.outcome] - SEVERITY[b.outcome] || a.id.localeCompare(b.id),
    );
    out.push("");
    out.push("Metrics");
    out.push(
      table(["", "metric", "baseline", "observed", "delta", "tolerance"], sorted.map(metricRow)),
    );

    // The explanation belongs next to the failure, not in a document nobody opens.
    for (const row of sorted) {
      if (row.outcome !== "regressed" && row.outcome !== "missing") continue;
      const baseline = row.baseline;
      out.push("");
      out.push(`  ${row.id} — ${baseline?.label ?? ""}`);
      if (baseline?.note != null) out.push(`  tolerance chosen because: ${baseline.note}`);
    }

    // A band wider than the number it guards will only ever catch the thing breaking, not the thing
    // getting worse. That is a legitimate state for a gate to be in — some of these are measured on
    // twenty minutes of simulated traffic — but a reader who sees PASSED deserves to know which
    // half of the sheet is actually load-bearing.
    const gated = verdict.metrics.filter((m) => m.baseline?.tolerance != null);
    const loose = gated.filter((m) => {
      const share = m.baseline === null ? null : toleranceShare(m.baseline);
      return share !== null && share > 0.5;
    });
    if (loose.length > 0) {
      out.push("");
      out.push(
        `note: ${loose.length} of ${gated.length} bands are wider than half the value they guard, ` +
          "so they catch breakage rather than degradation: " +
          `${loose.map((m) => m.id).join(", ")}.`,
      );
    }
  }

  for (const advisory of verdict.advisories) {
    out.push("");
    out.push(`note: ${advisory}`);
  }

  out.push("");
  out.push("─".repeat(78));
  out.push(verdict.failed ? "FAILED" : "PASSED");

  return out.join("\n");
}
