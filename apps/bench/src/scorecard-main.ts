import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  bless,
  compare,
  formatValue,
  parseBaseline,
  renderVerdict,
  type Scorecard,
  serialiseBaseline,
} from "@kairos/proof";
import { PINNED_SEED, type ProfileName, profile } from "./profiles.js";
import { runScorecard } from "./scorecard.js";

const RULE = "─".repeat(92);
const RESULTS = resolve(process.cwd(), "../../docs/results");

interface Args {
  readonly profile: ProfileName;
  readonly mode: "report" | "gate" | "bless";
  readonly seed: number;
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

  const mode = flags.has("bless") ? "bless" : flags.has("gate") ? "gate" : "report";
  const seed = flags.has("seed") ? Number(flags.get("seed")) : PINNED_SEED;
  if (!Number.isSafeInteger(seed)) throw new Error(`--seed must be an integer, received ${seed}`);

  return { profile: name, mode, seed };
}

/** The human-facing rendering: what the project claims, and what this run measured. */
function render(card: Scorecard): string {
  const out: string[] = [];
  const say = (line = ""): void => void out.push(line);

  say("Kairos scorecard");
  say(RULE);
  say(`profile        ${card.provenance.profile}`);
  say(`config         ${card.provenance.configHash}`);
  say(`revision       ${card.provenance.codeRevision}`);
  say(`node           ${card.provenance.node}`);
  say(`elapsed        ${(card.elapsedMs / 1000).toFixed(1)}s`);
  say();

  say("Claims that must hold exactly");
  say(RULE);
  const width = Math.max(...card.invariants.map((i) => i.id.length));
  for (const item of card.invariants) {
    const shown =
      typeof item.value === "boolean" ? String(item.value) : formatValue(item.value, "count");
    say(`  ${item.id.padEnd(width)}  ${shown.padStart(12)}   ${item.label}`);
  }
  say();

  say("Numbers that carry a band");
  say(RULE);
  const metricWidth = Math.max(...card.metrics.map((m) => m.id.length));
  for (const item of card.metrics) {
    say(`  ${item.id.padEnd(metricWidth)}  ${formatValue(item.value, item.unit).padStart(14)}`);
    say(`  ${" ".repeat(metricWidth)}  ${" ".repeat(14)}   ${item.label}`);
  }

  return out.join("\n");
}

function baselinePath(name: ProfileName): string {
  return resolve(RESULTS, `baseline-${name}.json`);
}

function loadBaseline(name: ProfileName): ReturnType<typeof parseBaseline> | null {
  const path = baselinePath(name);
  if (!existsSync(path)) return null;
  return parseBaseline(JSON.parse(readFileSync(path, "utf8")));
}

function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, "utf8");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const p = profile(args.profile, args.seed);

  process.stderr.write(`Running the ${args.profile} scorecard at seed ${args.seed}…\n`);
  const { scorecard, detail } = await runScorecard(p, (arm) => {
    process.stderr.write(`  ${arm}\n`);
  });

  if (args.mode === "report") {
    const text = render(scorecard);
    process.stdout.write(`${text}\n`);
    write(resolve(RESULTS, `scorecard-${args.profile}.txt`), `${text}\n`);
    write(
      resolve(RESULTS, `scorecard-${args.profile}.json`),
      `${JSON.stringify({ scorecard, detail }, null, 2)}\n`,
    );
    process.stderr.write(`\nWritten to docs/results/scorecard-${args.profile}.{txt,json}\n`);
    return;
  }

  const previous = loadBaseline(args.profile);

  if (args.mode === "bless") {
    const today = new Date().toISOString().slice(0, 10);
    const result = bless(previous, scorecard, today);

    if (!result.changed) {
      process.stdout.write("Nothing moved. The baseline is left untouched.\n");
      return;
    }

    write(baselinePath(args.profile), serialiseBaseline(result.baseline));
    process.stdout.write(`Blessed docs/results/baseline-${args.profile}.json\n`);

    if (result.uncalibrated.length > 0) {
      process.stdout.write(
        `\n${result.uncalibrated.length} metric(s) have no tolerance and are recorded without ` +
          `being enforced:\n  ${result.uncalibrated.join("\n  ")}\n` +
          "\nRun `pnpm bench:variance` to measure how far each moves when nothing is wrong, then " +
          "set `tolerance`, `sd`, `seeds` and `note` by hand. A bless never widens a band.\n",
      );
    }
    if (result.dropped.length > 0) {
      process.stdout.write(
        `\nNo longer measured, and dropped:\n  ${result.dropped.join("\n  ")}\n`,
      );
    }
    if (previous !== null && previous.provenance.configHash !== scorecard.provenance.configHash) {
      process.stdout.write(
        `\nThe experiment itself changed — ${previous.provenance.configHash} → ` +
          `${scorecard.provenance.configHash}. Every band in this file was measured against the ` +
          "old one; check them rather than assuming they carried over.\n",
      );
    }
    return;
  }

  if (previous === null) {
    process.stderr.write(
      `There is no docs/results/baseline-${args.profile}.json to compare against. ` +
        "Create one with `pnpm bench:bless`.\n",
    );
    process.exitCode = 1;
    return;
  }

  const verdict = compare(previous, scorecard);
  process.stdout.write(`${renderVerdict(verdict)}\n`);

  // Always written, pass or fail. A red build needs to be diffable against the committed baseline
  // without re-running the job, so CI uploads this. It goes to `bench-out/`, which is ignored:
  // `docs/results/` is for artifacts somebody decided to publish, not for every run's exhaust.
  write(
    resolve(process.cwd(), `bench-out/observed-${args.profile}.json`),
    `${JSON.stringify(scorecard, null, 2)}\n`,
  );

  if (verdict.failed) process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
