/**
 * How far every headline number moves when only the seed changes.
 *
 * This is the study the regression gate's tolerances come from, and it has to be run before the
 * gate means anything. Hold the code still, vary the seed, and the spread you get back is the scale
 * of a *meaningless* change — because a code change that draws randomness differently has, for a
 * fixed-seed benchmark, done exactly what changing the seed does.
 *
 * It also reports which metrics did not move at all across every seed. Those are usually arithmetic
 * on the configuration wearing a metric's clothes, and the right response is to make them
 * invariants rather than to give them a very small band.
 *
 * Expensive by design and run deliberately: `pnpm bench:variance`. Nothing in CI depends on it.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  checkInvariant,
  DEFAULT_SIGMAS,
  formatValue,
  type Observation,
  type Spread,
  suggestTolerance,
  summarise,
} from "@kairos/proof";
import { PINNED_SEED, type ProfileName, profile } from "./profiles.js";
import { runScorecard } from "./scorecard.js";

const RULE = "─".repeat(112);

/** Enough seeds for a standard deviation to mean something, few enough to finish over a coffee. */
const DEFAULT_SEEDS = 8;

interface Args {
  readonly profile: ProfileName;
  readonly seeds: number;
  readonly sigmas: number;
}

function parseArgs(argv: readonly string[]): Args {
  const flags = new Map<string, string>();
  for (const arg of argv) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (match?.[1] !== undefined) flags.set(match[1], match[2] ?? "true");
  }
  const name = flags.get("profile") ?? "quick";
  if (name !== "quick" && name !== "full") {
    throw new Error(`unknown profile "${name}"; expected quick or full`);
  }
  return {
    profile: name,
    seeds: flags.has("seeds") ? Number(flags.get("seeds")) : DEFAULT_SEEDS,
    sigmas: flags.has("sigmas") ? Number(flags.get("sigmas")) : DEFAULT_SIGMAS,
  };
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function padStart(text: string, width: number): string {
  return text.length >= width ? text : " ".repeat(width - text.length) + text;
}

interface Row {
  readonly metric: Observation;
  readonly spread: Spread;
  readonly tolerance: number | null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Seeds spaced by a prime rather than by one, so two runs cannot share a low-order bit pattern
  // through any of the four generators that consume them.
  const seeds = Array.from({ length: args.seeds }, (_, i) => PINNED_SEED + i * 1009);

  const samples = new Map<string, number[]>();
  const shape = new Map<string, Observation>();
  const invariantHeld = new Map<string, { held: number; broke: number }>();

  const started = process.hrtime.bigint();
  for (const [index, seed] of seeds.entries()) {
    process.stderr.write(`seed ${index + 1}/${seeds.length} (${seed})\n`);
    const { scorecard } = await runScorecard(profile(args.profile, seed), (arm) => {
      process.stderr.write(`  ${arm}\n`);
    });

    for (const metric of scorecard.metrics) {
      shape.set(metric.id, metric);
      const list = samples.get(metric.id) ?? [];
      list.push(metric.value);
      samples.set(metric.id, list);
    }
    // Invariants have no spread to report, but an invariant that holds on one seed and breaks on
    // another is the most valuable thing this study can find: a claim that is true by luck.
    //
    // What is tracked is whether the *check* passed, not whether the value repeated. A `positive`
    // invariant's value moves on every seed by construction — that is what makes it a measurement
    // rather than a constant — and reading a changed value as instability would flag every healthy
    // control arm in the harness.
    for (const item of scorecard.invariants) {
      const tally = invariantHeld.get(item.id) ?? { held: 0, broke: 0 };
      if (checkInvariant(item).ok) tally.held++;
      else tally.broke++;
      invariantHeld.set(item.id, tally);
    }
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  const rows: Row[] = [];
  for (const [id, values] of samples) {
    const metric = shape.get(id);
    if (metric === undefined) continue;
    const spread = summarise(values);
    rows.push({ metric, spread, tolerance: suggestTolerance(spread, args.sigmas) });
  }
  rows.sort((a, b) => a.metric.id.localeCompare(b.metric.id));

  const out: string[] = [];
  const say = (line = ""): void => void out.push(line);

  say("How far each number moves when only the seed changes");
  say(RULE);
  say(
    `${args.seeds} seeds, ${args.profile} profile, ${(elapsedMs / 1000).toFixed(0)}s. ` +
      `Suggested tolerance is ${args.sigmas} sd, rounded up to a readable figure.`,
  );
  say();
  say(
    "A code change that consumes randomness differently re-rolls a fixed-seed benchmark, so it moves",
  );
  say(
    "a metric by about one seed's worth. That is what these tolerances are sized to survive. They are",
  );
  say("a starting point for a human, not a value to paste in: `bench:bless` never sets them.");
  say();

  const widths = [Math.max(6, ...rows.map((r) => r.metric.id.length)), 12, 12, 12, 8, 14];
  const headers = ["metric", "mean", "sd", "range", "cv", `${args.sigmas} sd →`];
  say(
    headers
      .map((h, i) => (i === 0 ? pad(h, widths[i] ?? 0) : padStart(h, widths[i] ?? 0)))
      .join("  "),
  );
  say(widths.map((w) => "─".repeat(w)).join("  "));

  for (const { metric, spread, tolerance } of rows) {
    const unit = metric.unit;
    const cells = [
      pad(metric.id, widths[0] ?? 0),
      padStart(formatValue(spread.mean, unit), widths[1] ?? 0),
      padStart(spread.degenerate ? "—" : formatValue(spread.sd, unit), widths[2] ?? 0),
      padStart(
        spread.degenerate ? "—" : formatValue(spread.max - spread.min, unit),
        widths[3] ?? 0,
      ),
      padStart(
        spread.coefficientOfVariation === null
          ? "—"
          : `${(spread.coefficientOfVariation * 100).toFixed(1)}%`,
        widths[4] ?? 0,
      ),
      padStart(
        tolerance === null ? "make it an invariant" : formatValue(tolerance, unit),
        widths[5] ?? 0,
      ),
    ];
    say(cells.join("  "));
  }

  const degenerate = rows.filter((r) => r.spread.degenerate);
  if (degenerate.length > 0) {
    say();
    say(
      `${degenerate.length} metric(s) produced the same value on all ${args.seeds} seeds: ` +
        `${degenerate.map((r) => r.metric.id).join(", ")}.`,
    );
    say(
      "That usually means the quantity is arithmetic on the configuration rather than an outcome of",
    );
    say("the simulation, and belongs in the baseline as an `exact` invariant instead.");
  }

  const flaky = [...invariantHeld].filter(([, t]) => t.held > 0 && t.broke > 0);
  const broken = [...invariantHeld].filter(([, t]) => t.held === 0);
  say();
  say("Invariants across seeds");
  say(RULE);
  if (flaky.length === 0 && broken.length === 0) {
    say(`All ${invariantHeld.size} held on every one of the ${args.seeds} seeds.`);
  }
  for (const [id, t] of flaky) {
    say(`  BY LUCK  ${id} held on ${t.held} seeds and broke on ${t.broke}.`);
  }
  for (const [id] of broken) {
    say(`  BROKEN   ${id} did not hold on any seed.`);
  }
  if (flaky.length > 0) {
    say();
    say("An invariant that holds on some seeds is not an invariant. Either it is a metric with a");
    say("band, or the code does not guarantee what the claim says it does.");
  }

  const rendered = out.join("\n");
  process.stdout.write(`${rendered}\n`);

  const path = resolve(process.cwd(), `../../docs/results/variance-${args.profile}.txt`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${rendered}\n`, "utf8");
  writeFileSync(
    resolve(dirname(path), `variance-${args.profile}.json`),
    `${JSON.stringify(
      {
        profile: args.profile,
        seeds,
        sigmas: args.sigmas,
        metrics: rows.map((r) => ({
          id: r.metric.id,
          unit: r.metric.unit,
          direction: r.metric.direction,
          ...r.spread,
          suggestedTolerance: r.tolerance,
        })),
        invariants: [...invariantHeld].map(([id, t]) => ({ id, ...t })),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  process.stderr.write(`\nWritten to docs/results/variance-${args.profile}.{txt,json}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
