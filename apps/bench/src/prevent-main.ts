import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { formatINR, paise } from "@kairos/domain";
import { DEFAULT_STEERING_CONFIG } from "@kairos/policy";
import {
  DEFAULT_PREVENT_OPTIONS,
  type PreventOptions,
  type PreventResult,
  runPrevention,
} from "./prevent.js";
import { PREVENT_SCENARIOS as SCENARIOS } from "./profiles.js";

const MINUTE = 60_000;
const RULE = "─".repeat(88);

function pad(text: string, width: number, align: "left" | "right" = "left"): string {
  return align === "left" ? text.padEnd(width) : text.padStart(width);
}

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: readonly string[]): string =>
    cells.map((c, i) => pad(c, widths[i] ?? 0, i === 0 ? "left" : "right")).join("  ");
  return [line(headers), widths.map((w) => "─".repeat(w)).join("  "), ...rows.map(line)].join("\n");
}

const pct = (x: number): string => `${(x * 100).toFixed(2)}%`;

const verdict = (c: { lossRateDelta: number; significant: boolean }): string =>
  c.significant ? (c.lossRateDelta > 0 ? "yes" : "HARMFUL") : "noise";

const delta = (c: { lossRateDelta: number }): string =>
  `${c.lossRateDelta >= 0 ? "+" : ""}${pct(c.lossRateDelta)}`;

/**
 * Three populations, because one number would hide the trade.
 *
 * `exposed` is the people the outage was going to hurt; `collateral` is the people on the same
 * method whose own rail was fine and who were moved anyway. A lever is only worth pulling if the
 * first is clearly positive and the second is not clearly negative, and reporting only the overall
 * figure would let a large benefit to a few and a small harm to many net out into a number that
 * says nothing about either.
 */
function formatRun(result: PreventResult): string {
  if (result.incidents.length === 0) {
    const reasons = Object.entries(result.declines)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 1)
      .map(([reason]) => reason);
    return `  no steer issued — ${reasons[0] ?? "no incident detected"}`;
  }

  const rows: string[][] = [];
  for (const i of result.incidents) {
    const flap = i.leverChanges === 0 ? "" : `, ${i.leverChanges} changes`;
    const label = `${i.slice.replace(/\|+$/, "")} (${i.lever}, ${(i.steeredMs / 60_000).toFixed(0)}m${flap})`;
    for (const [name, c] of [
      ["exposed", i.affected],
      ["collateral", i.collateral],
      ["overall", i.overall],
    ] as const) {
      if (c.control.attempts === 0 && c.treated.attempts === 0) continue;
      rows.push([
        rows.length === 0 ? label : "",
        name,
        `${c.control.attempts}`,
        pct(c.control.lossRate),
        `${c.treated.attempts}`,
        pct(c.treated.lossRate),
        delta(c),
        `±${pct(c.confidenceHalfWidth)}`,
        verdict(c),
      ]);
    }
  }

  return table(
    ["incident", "who", "ctrl n", "ctrl loss", "treat n", "treat loss", "delta", "95% CI", "real?"],
    rows,
  );
}

function parseArgs(argv: readonly string[]): { options: PreventOptions; out: string | null } {
  const flags = new Set(
    argv.filter((a) => a.startsWith("--")).map((a) => a.slice(2).split("=")[0]),
  );
  const outArg = argv.find((a) => a.startsWith("--out="))?.slice(6);

  const options: PreventOptions = {
    ...DEFAULT_PREVENT_OPTIONS,
    ...(flags.has("quick") ? { observeMs: 20 * MINUTE, attemptsPerMinute: 300 } : {}),
  };
  const out = outArg ?? "bench-out/prevention.json";
  return { options, out: out === "none" ? null : out };
}

/** Elasticities to sweep, spanning "almost nobody moves" to "almost everybody does". */
const ELASTICITIES = [0.05, 0.2, 0.35, 0.6, 0.9];

async function main(): Promise<void> {
  const { options, out } = parseArgs(process.argv.slice(2));
  const started = process.hrtime.bigint();
  const runs: PreventResult[] = [];

  process.stdout.write("\nPrevention lift against a holdout\n");
  process.stdout.write(`${RULE}\n`);

  for (const scenario of SCENARIOS) {
    const result = await runPrevention(scenario.name, scenario.degradation, options);
    runs.push(result);
    process.stdout.write(`\n${scenario.name} — ${scenario.description}\n`);
    process.stdout.write(`${formatRun(result)}\n`);
  }

  // What happens when the policy's belief about customers is wrong. The policy keeps its default
  // elasticity throughout; only the simulated customers change.
  process.stdout.write("\n\nWhen the policy's belief about customers is wrong\n");
  process.stdout.write(`${RULE}\n`);
  const beliefRows: string[][] = [];
  const severe = SCENARIOS.find((s) => s.name === "upi-hdfc-severe");

  if (severe !== undefined) {
    for (const truth of ELASTICITIES) {
      const result = await runPrevention(`elasticity-${truth}`, severe.degradation, {
        ...options,
        steering: { ...DEFAULT_STEERING_CONFIG, switchElasticity: 0.35 },
        choice: { ...options.choice, switchElasticity: truth },
      });
      runs.push(result);
      const incident = result.incidents[0];
      const exposed = incident?.affected;
      const collateral = incident?.collateral;
      beliefRows.push([
        `believes 0.35, truth ${truth.toFixed(2)}`,
        exposed === undefined ? "no steer" : pct(exposed.control.lossRate),
        exposed === undefined ? "—" : pct(exposed.treated.lossRate),
        exposed === undefined ? "—" : delta(exposed),
        exposed === undefined ? "—" : verdict(exposed),
        collateral === undefined ? "—" : delta(collateral),
        collateral === undefined ? "—" : verdict(collateral),
      ]);
    }
    process.stdout.write(
      `${table(["customers", "ctrl loss", "treat loss", "delta", "95% CI", "real?"], beliefRows)}\n`,
    );
  }

  const all = runs.flatMap((r) => r.incidents);
  const saved = all
    .filter((i) => i.affected.significant && i.affected.lossRateDelta > 0)
    .reduce((sum, i) => sum + i.affected.savedPaise, 0);
  const harmful = all.filter(
    (i) =>
      (i.affected.significant && i.affected.lossRateDelta < 0) ||
      (i.collateral.significant && i.collateral.lossRateDelta < 0),
  );

  process.stdout.write(
    `\nAcross every run: ${formatINR(paise(saved))} of loss avoided in the treated arms, ` +
      `${harmful.length} steers measurably harmful.\n` +
      `Ledgers: ${runs.filter((r) => r.ledgerVerified).length}/${runs.length} verify. ` +
      `Detection held through the peak in ${runs.filter((r) => r.detectionHeld).length}/${runs.length}.\n`,
  );

  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  process.stderr.write(`\nCompleted in ${(elapsedMs / 1000).toFixed(1)}s\n`);

  if (out !== null) {
    const path = resolve(process.cwd(), out);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({ generatedBy: "kairos bench prevention", elapsedMs, runs }, null, 2)}\n`,
    );
    process.stderr.write(`Scorecard written to ${out}\n`);
  }
}

await main();
