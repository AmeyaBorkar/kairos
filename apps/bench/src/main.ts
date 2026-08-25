import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DEFAULT_OPTIONS, type ExperimentOptions, runCurve } from "./experiment.js";
import { formatCurve, formatScenarios, recommend } from "./format.js";
import { FALSE_ALARM_BUDGET_PER_HOUR } from "./profiles.js";

const RULE = "─".repeat(64);

function parseArgs(argv: readonly string[]): { options: ExperimentOptions; out: string | null } {
  const flags = new Map<string, string>();
  for (const arg of argv) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (match?.[1] !== undefined) flags.set(match[1], match[2] ?? "true");
  }

  const quick = flags.has("quick");
  const options: ExperimentOptions = {
    ...DEFAULT_OPTIONS,
    ...(quick
      ? { thresholds: [8, 12, 17], seedsPerCell: 2, warmupMs: 15 * 60_000, observeMs: 25 * 60_000 }
      : {}),
    ...(flags.has("seeds") ? { seedsPerCell: Number(flags.get("seeds")) } : {}),
  };

  const out = flags.get("out") ?? "bench-out/detection-curve.json";
  return { options, out: out === "none" ? null : out };
}

function main(): void {
  const { options, out } = parseArgs(process.argv.slice(2));

  const total =
    options.thresholds.length *
    (options.seedsPerCell + options.scenarios.length * options.seedsPerCell);
  process.stderr.write(`Running ${total} simulated trials…\n`);

  const started = process.hrtime.bigint();
  let lastReport = 0;
  const result = runCurve(options, (done, all) => {
    const pct = Math.floor((done / all) * 100);
    if (pct >= lastReport + 10) {
      lastReport = pct;
      process.stderr.write(`  ${pct}%\n`);
    }
  });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  process.stdout.write("\nDetection latency versus false-alarm rate\n");
  process.stdout.write(`${RULE}\n`);
  process.stdout.write(`${formatCurve(result)}\n\n`);

  const chosen = recommend(result, FALSE_ALARM_BUDGET_PER_HOUR);
  if (chosen === null) {
    process.stdout.write(
      `No threshold stayed within ${FALSE_ALARM_BUDGET_PER_HOUR} false alarms/hour. ` +
        "The sweep needs to extend higher.\n",
    );
  } else {
    process.stdout.write(
      `Operating point: threshold ${chosen.threshold} — ` +
        `${chosen.falseAlarmsPerHour.toFixed(2)} false alarms/hour, ` +
        `${(chosen.overallDetectionRate * 100).toFixed(0)}% detected, ` +
        `median ${((chosen.overallMedianLatencyMs ?? 0) / 1000).toFixed(0)}s.\n\n`,
    );
    process.stdout.write("Per scenario at that threshold\n");
    process.stdout.write(`${RULE}\n`);
    process.stdout.write(`${formatScenarios(chosen)}\n`);
  }

  process.stderr.write(`\nCompleted in ${(elapsedMs / 1000).toFixed(1)}s\n`);

  if (out !== null) {
    const path = resolve(process.cwd(), out);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({ generatedBy: "kairos bench detect-curve", elapsedMs, ...result }, null, 2)}\n`,
    );
    process.stderr.write(`Scorecard written to ${out}\n`);
  }
}

main();
