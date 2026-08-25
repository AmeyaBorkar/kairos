import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { formatINR, paise } from "@kairos/domain";
import { formatMix, formatSizers, formatSpendSweep, formatTail } from "./format.js";
import { DEFAULT_SPEND_OPTIONS, runSpendSweep, type SpendOptions } from "./spend.js";

const RULE = "─".repeat(78);

/** The worker counts to sweep. The point of the experiment is that this axis stops mattering. */
const WORKER_COUNTS = [1, 2, 4, 8, 16, 32, 64];
const QUICK_WORKER_COUNTS = [1, 8, 64];

function parseArgs(argv: readonly string[]): {
  options: SpendOptions;
  workerCounts: readonly number[];
  out: string | null;
} {
  const flags = new Map<string, string>();
  for (const arg of argv) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (match?.[1] !== undefined) flags.set(match[1], match[2] ?? "true");
  }

  const quick = flags.has("quick");
  const options: SpendOptions = {
    ...DEFAULT_SPEND_OPTIONS,
    ...(quick ? { jobs: 1200, customers: 120 } : {}),
  };

  const out = flags.get("out") ?? "bench-out/spend-bound.json";
  return {
    options,
    workerCounts: quick ? QUICK_WORKER_COUNTS : WORKER_COUNTS,
    out: out === "none" ? null : out,
  };
}

async function main(): Promise<void> {
  const { options, workerCounts, out } = parseArgs(process.argv.slice(2));

  process.stderr.write(
    `Draining ${options.jobs} casualties against a ${formatINR(paise(options.budgetPaise))} budget, ` +
      `at ${workerCounts.length} worker counts…\n`,
  );

  const started = process.hrtime.bigint();
  let lastReport = 0;
  const sweep = await runSpendSweep(options, workerCounts, (done, all) => {
    const pct = Math.floor((done / all) * 100);
    if (pct >= lastReport + 20) {
      lastReport = pct;
      process.stderr.write(`  ${pct}%\n`);
    }
  });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  process.stdout.write("\nOverspend against fleet size\n");
  process.stdout.write(`${RULE}\n`);
  process.stdout.write(`${formatSpendSweep(sweep)}\n\n`);

  const worst = sweep.naive.reduce((a, b) => (b.overspendPaise > a.overspendPaise ? b : a));
  const kernelWorst = sweep.terminus.reduce((a, b) =>
    b.overspendPaise > a.overspendPaise ? b : a,
  );

  process.stdout.write(
    `Naive peaks at ${formatINR(paise(worst.overspendPaise))} over budget on ${worst.workers} workers ` +
      `and ${worst.capViolations} contacts past the cap.\n` +
      `Terminus peaks at ${formatINR(paise(kernelWorst.overspendPaise))} over ` +
      `(${kernelWorst.sizer}, ${kernelWorst.workers} workers) with ${kernelWorst.capViolations} past the cap.\n\n`,
  );

  const widest = Math.max(...workerCounts);
  process.stdout.write(`Reservation strategies at ${widest} workers\n`);
  process.stdout.write(`${RULE}\n`);
  process.stdout.write(`${formatSizers(sweep.terminus.filter((r) => r.workers === widest))}\n`);

  process.stdout.write("\nDoes a smaller reservation get more done as the budget tightens?\n");
  process.stdout.write(`${RULE}\n`);
  process.stdout.write(`${formatTail(sweep.tail)}\n`);

  process.stdout.write("\nLift against the share of messages that cost the ceiling\n");
  process.stdout.write(`${RULE}\n`);
  process.stdout.write(`${formatMix(sweep.mix)}\n`);

  const unverified = sweep.terminus.filter((r) => !r.ledgerVerified);
  const orphaned = sweep.terminus.filter((r) => r.orphans > 0);
  process.stdout.write(
    `\nLedger: ${sweep.terminus.length - unverified.length}/${sweep.terminus.length} chains verify, ` +
      `${orphaned.length} runs left an orphaned reservation.\n`,
  );

  process.stderr.write(`\nCompleted in ${(elapsedMs / 1000).toFixed(1)}s\n`);

  if (out !== null) {
    const path = resolve(process.cwd(), out);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({ generatedBy: "kairos bench spend-bound", elapsedMs, ...sweep }, null, 2)}\n`,
    );
    process.stderr.write(`Scorecard written to ${out}\n`);
  }
}

await main();
