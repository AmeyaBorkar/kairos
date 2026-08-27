import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  DEFAULT_OPTIONS,
  DEFAULT_RESOLUTION_OPTIONS,
  type ExperimentOptions,
  type ResolutionOptions,
  runCurve,
  runResolutionStudy,
} from "./experiment.js";
import {
  formatCurve,
  formatResolution,
  formatResolutionScenarios,
  formatScenarios,
  recommend,
} from "./format.js";
import { FALSE_ALARM_BUDGET_PER_HOUR } from "./profiles.js";

const RULE = "─".repeat(64);

interface Args {
  readonly options: ExperimentOptions;
  readonly resolution: ResolutionOptions;
  readonly out: string | null;
}

function parseArgs(argv: readonly string[]): Args {
  const flags = new Map<string, string>();
  for (const arg of argv) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (match?.[1] !== undefined) flags.set(match[1], match[2] ?? "true");
  }

  const quick = flags.has("quick");
  const options: ExperimentOptions = {
    ...DEFAULT_OPTIONS,
    ...(quick
      ? {
          thresholds: [8, 12, 17],
          seedsPerCell: 2,
          healthySeeds: 12,
          warmupMs: 15 * 60_000,
          observeMs: 25 * 60_000,
        }
      : {}),
    ...(flags.has("seeds") ? { seedsPerCell: Number(flags.get("seeds")) } : {}),
  };

  /* The resolution arm keeps its own window. It has to watch well past the moment the rail heals,
     and stretching the shared one would move the healthy arm's denominator and the detection arm's
     deadline — re-baselining two published measurements to add a third. */
  const resolution: ResolutionOptions = {
    ...DEFAULT_RESOLUTION_OPTIONS,
    thresholds: options.thresholds,
    seedsPerCell: options.seedsPerCell,
    seedBase: options.seedBase,
    attemptsPerMinute: options.attemptsPerMinute,
    warmupMs: options.warmupMs,
    scenarios: options.scenarios,
    ...(quick ? { tailMs: 60 * 60_000 } : {}),
  };

  const out = flags.get("out") ?? "bench-out/detection-curve.json";
  return { options, resolution, out: out === "none" ? null : out };
}

function main(): void {
  const { options, resolution, out } = parseArgs(process.argv.slice(2));

  const total =
    options.thresholds.length *
    (options.healthySeeds + options.scenarios.length * options.seedsPerCell);
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

  /* The way back. Measured because it was not, for five phases: the sweep above reported a
     93-second median detection latency while the same detector held incidents open for six hours,
     and nothing here disagreed with either number. */
  process.stderr.write("\nRunning the resolution arm…\n");
  const resolved = runResolutionStudy(resolution);

  process.stdout.write("\nResolution: how long an incident outlives the outage\n");
  process.stdout.write(`${RULE}\n`);
  process.stdout.write(`${formatResolution(resolved)}\n\n`);

  const resolvedAtChosen =
    chosen === null
      ? null
      : (resolved.thresholds.find((t) => t.threshold === chosen.threshold) ?? null);
  if (resolvedAtChosen !== null) {
    process.stdout.write("Per scenario at that threshold\n");
    process.stdout.write(`${RULE}\n`);
    process.stdout.write(`${formatResolutionScenarios(resolvedAtChosen)}\n`);
  }

  process.stderr.write(`\nCompleted in ${(elapsedMs / 1000).toFixed(1)}s\n`);

  if (out !== null) {
    const path = resolve(process.cwd(), out);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify(
        { generatedBy: "kairos bench detect-curve", elapsedMs, ...result, resolution: resolved },
        null,
        2,
      )}\n`,
    );
    process.stderr.write(`Scorecard written to ${out}\n`);
  }
}

main();
