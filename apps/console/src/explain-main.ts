/**
 * `pnpm explain <target>` — why the system treated one casualty, incident or slice as it did.
 *
 * A terminal front end for `@kairos/explain`, and the smallest possible one: it runs a scenario to
 * completion so there is an audit chain to ask about, retrieves the subject's records, asks the
 * model, and prints the answer only if every figure in it came from a record.
 *
 * ## It prints the timeline whether or not the model succeeds
 *
 * That is the point of the ordering. The records are the answer; the prose is a convenience over
 * them. If the model is unavailable, over quota, or writes a number nobody recorded, the operator
 * still gets the thing they actually needed — and gets it in a form they can check. A tool that
 * printed nothing without a working provider would have made an audit log depend on an API key.
 */

import { DEFAULT_DETECTOR_CONFIG, withThreshold } from "@kairos/detect";
import { type Mandate, mandateId, paise } from "@kairos/domain";
import { describeBounds, explain, type RecordSource, retrieve } from "@kairos/explain";
import { configFromProcess, geminiReasoners } from "@kairos/reasoner-gemini";
import { sealMandate } from "@kairos/terminus";
import { ConsoleRun } from "./run.js";
import { type Scenario, scenarioNamed } from "./scenario.js";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function usage(): never {
  process.stderr.write(
    'usage: pnpm --filter @kairos/console run explain <target> [--scenario=name] [--ask="..."]\n' +
      "\n" +
      "  <target>   a casualty, incident or slice id as it appears in the ledger\n" +
      "  --scenario which run to build the chain from (default: issuer-outage)\n" +
      "  --ask      a specific question, rather than the general one\n" +
      "  --list     print the targets this run recorded, and stop\n",
  );
  process.exit(2);
}

function mandateFor(scenario: Scenario, secret: string): Mandate {
  return sealMandate(
    {
      id: mandateId("mnd_console"),
      merchantId: "console",
      campaignId: scenario.name,
      budgetPaise: paise(scenario.budgetPaise),
      maxActionCostPaise: paise(300),
      maxInFlight: 3,
      reservationTtlMs: 30 * MINUTE,
      contactCap: { limit: 3, windowMs: 7 * DAY },
      quietHours: { startMinute: 21 * 60, endMinute: 8 * 60, offsetMinutes: 330 },
      allowedActions: ["steer", "retry", "contact-sms", "contact-whatsapp", "contact-email"],
      validFrom: scenario.simulator.startAt - DAY,
      validUntil: scenario.simulator.startAt + 120 * DAY,
      killSwitch: scenario.killSwitch,
    },
    secret,
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flags = new Map(
    args
      .filter((a) => a.startsWith("--"))
      .map((a) => {
        const [name, ...rest] = a.slice(2).split("=");
        return [name ?? "", rest.join("=")];
      }),
  );
  const target = args.find((a) => !a.startsWith("--")) ?? "";

  const secret = process.env["KAIROS_MANDATE_SECRET"] ?? "";
  if (secret.length < 32) {
    process.stderr.write("set KAIROS_MANDATE_SECRET to at least 32 characters\n");
    process.exit(1);
  }

  const startAt = Date.now();
  const name = flags.get("scenario") ?? "issuer-outage";
  const scenario = scenarioNamed(name, startAt);
  if (scenario === null) {
    process.stderr.write(`unknown scenario ${name}\n`);
    process.exit(2);
  }

  process.stderr.write(`running scenario ${scenario.name}…\n`);
  const run = new ConsoleRun({
    scenario,
    mandate: mandateFor(scenario, secret),
    secret,
    detector: { ...withThreshold(DEFAULT_DETECTOR_CONFIG, 12), rollup: true },
  });
  await run.runToEnd();

  if (flags.has("list")) {
    const targets = new Set(run.ledger.records.map((record) => record.target));
    process.stdout.write(`${[...targets].sort().join("\n")}\n`);
    return;
  }

  if (target === "") usage();

  const retrieved = retrieve(run.ledger as RecordSource, { target });
  if (retrieved.timeline.length === 0) {
    process.stderr.write(
      `nothing in this run's audit chain has target ${target}.\n` +
        "Run with --list to see what it recorded.\n",
    );
    process.exit(1);
  }

  // The records first, always. They are the answer; the prose is a convenience over them.
  process.stdout.write(`\n${target} — ${retrieved.timeline.length} record(s)\n\n`);
  for (const entry of retrieved.timeline) {
    const verdict = entry.allowed ? "allowed" : "REFUSED";
    const bound = entry.binding === null ? "" : `  [${entry.binding}]`;
    process.stdout.write(
      `  ${entry.at}  ${verdict.padEnd(8)}  ${entry.action}  ${entry.reason}${bound}\n`,
    );
  }
  if (retrieved.truncated > 0) {
    process.stdout.write(`\n  (${retrieved.truncated} earlier record(s) not shown)\n`);
  }

  if ((process.env["GOOGLE_API_KEY"] ?? "").length === 0) {
    process.stdout.write("\nset GOOGLE_API_KEY for a written explanation of the above.\n");
    return;
  }

  const result = await explain({
    source: run.ledger as RecordSource,
    explainer: geminiReasoners({ config: configFromProcess() }).explainer,
    bounds: describeBounds(mandateFor(scenario, secret)),
    target,
    ...(flags.get("ask") === undefined ? {} : { question: flags.get("ask") as string }),
  });

  if (!result.ok) {
    // Named as a refusal rather than printed with a caveat. An answer whose figures cannot be
    // vouched for is not a worse answer, it is not an answer.
    process.stderr.write(`\nno explanation: ${result.detail}\n`);
    if (result.rejected !== null) {
      process.stderr.write(`\nwhat the model said, for debugging:\n  ${result.rejected}\n`);
    }
    process.exit(1);
  }

  process.stdout.write(`\n${result.prose}\n`);
  process.stdout.write(
    `\n— ${result.model}; every figure above appears in a record (${result.cited.length} checked)\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
