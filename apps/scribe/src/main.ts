/**
 * The copy generator.
 *
 * Run once, by a person, when the prompt changes or a language is added. Its output is a committed
 * JSON file that a reviewer reads like any other text that reaches a customer, and after that no
 * inference happens anywhere near the path where money moves.
 *
 * ## Resumable by default
 *
 * The run loads the existing library, asks only for the segments it does not cover, and merges. So
 * an interrupted run is not a lost run and a free tier's daily quota is not a hard ceiling on the
 * size of a library — it is a ceiling on how much of one gets written today.
 *
 * `--fresh` starts from nothing, which is what a changed prompt calls for: copy written under one
 * set of instructions says nothing about copy written under another, and the provenance records the
 * prompt hash so a stale library is visible rather than merely old.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { type Mandate, mandateId, paise } from "@kairos/domain";
import { MemoryLedger } from "@kairos/ledger";
import {
  Copy,
  type CopyLibrary,
  type CopySegment,
  type ModelPrice,
  parseLibrary,
  promptHash,
  requiredSegments,
  reservationFor,
  serialiseLibrary,
  statsFor,
} from "@kairos/reason";
import {
  budgetFor,
  configFromProcess,
  describeConfig,
  geminiReasoners,
  priceFor,
} from "@kairos/reasoner-gemini";
import { sealMandate, systemClock, Terminus } from "@kairos/terminus";
import { MemoryStore } from "throttlekit";
import { generate } from "./generate.js";
import {
  COVERAGE,
  describePolicy,
  inWritingOrder,
  LIBRARY_PATH,
  requestFor,
  VARIANTS_PER_SEGMENT,
} from "./policy.js";

const DAY = 24 * 60 * 60 * 1000;

/** How long one compose call gets. Generous: nobody is waiting, and a retry costs a quota unit. */
const DEADLINE_MS = 90_000;

function out(line = ""): void {
  process.stdout.write(`${line}\n`);
}

/**
 * The mandate this run spends under.
 *
 * A real one, signed, with `reason` as the only action it authorises — so this process could not
 * send a message if its code asked it to. That is not theatre: the whole argument for putting
 * `reason` in the action vocabulary is that a merchant turns model use on and off by editing a
 * mandate, and a generator that spent outside one would be the counter-example.
 */
function buildMandate(secret: string, budgetPaise: number, maxCallPaise: number): Mandate {
  const now = Date.now();
  return sealMandate(
    {
      id: mandateId(`mnd_scribe_${now.toString(36)}`),
      merchantId: process.env["KAIROS_MERCHANT_ID"] ?? "kairos-internal",
      campaignId: "copy-library",
      budgetPaise: paise(budgetPaise, "budget"),
      // Computed from the largest prompt this run will actually send, answered at its output
      // ceiling — by the same functions the loop reserves with, so the mandate cannot be tighter
      // than the work it authorises. A hand-typed number here is a run that refuses its own first
      // call on a Tuesday when somebody lengthens the prompt.
      maxActionCostPaise: paise(maxCallPaise, "action ceiling"),
      // One at a time. The provider's rate limit makes concurrency pointless here, and a
      // single-flight run cannot overrun its budget by more than one call's ceiling.
      maxInFlight: 1,
      reservationTtlMs: 5 * 60_000,
      // Never consulted. `reason` is exempt from the contact cap because nobody is contacted, and
      // it is the only action this mandate allows — so this is the smallest value the mandate
      // schema will accept rather than a policy. Zero would be the honest number and is rejected,
      // correctly: a cap of zero on a mandate that could contact somebody is a mandate nobody
      // meant to sign.
      contactCap: { limit: 1, windowMs: DAY },
      // No quiet hours: nobody is being contacted. A window here would stop a build at 21:00 for
      // the benefit of customers who are not involved.
      quietHours: null,
      allowedActions: ["reason"],
      validFrom: now - 60_000,
      validUntil: now + DAY,
      killSwitch: false,
    },
    secret,
  );
}

/** The most any one call in this run could cost, at its reservation ceiling. */
function worstCallPaise(segments: readonly CopySegment[], price: ModelPrice): number {
  const costs = segments.map((segment) => {
    const { inputTokens, outputTokens } = budgetFor(requestFor(segment));
    return reservationFor(inputTokens, outputTokens, price);
  });
  // A run with nothing to do still needs a positive ceiling: zero would be a mandate that
  // authorises no action at all, and the refusal would name the wrong cause.
  return Math.max(1, ...costs);
}

function loadLibrary(path: string): CopyLibrary | null {
  try {
    return parseLibrary(JSON.parse(readFileSync(path, "utf8")));
  } catch (error: unknown) {
    // A file that does not exist is the first run. A file that exists and does not parse is a
    // problem somebody has to see, because overwriting it would destroy the only copy.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function main(): Promise<void> {
  const argv = new Set(process.argv.slice(2));
  const fresh = argv.has("--fresh");
  const dryRun = argv.has("--dry-run");
  const flag = (name: string, fallback: number): number => {
    const found = [...argv].find((a) => a.startsWith(`--${name}=`));
    return found === undefined ? fallback : Number(found.slice(name.length + 3));
  };
  const limit = flag("limit", Number.POSITIVE_INFINITY);
  // How many variants a segment needs before it counts as done. One by default, because a segment
  // with any copy at all is a segment that works; raise it to top up the thin ones, which is what a
  // gauntlet rejection leaves behind.
  const minVariants = flag("min-variants", 1);

  const config = configFromProcess();
  const secret = process.env["KAIROS_MANDATE_SECRET"] ?? "scribe-local-development-secret";
  const budgetPaise = Number(process.env["KAIROS_BUDGET_PAISE"] ?? 10_000);

  const required = requiredSegments(COVERAGE);
  const existing = fresh ? null : loadLibrary(LIBRARY_PATH);
  const copy = new Copy(existing ?? { provenance: blank(), variants: [] });
  const thin = required.filter((segment) => copy.variantsFor(segment).length < minVariants);
  const todo: readonly CopySegment[] = inWritingOrder(thin).slice(0, limit);

  out(describeConfig(config));
  out();
  out(describePolicy());
  out();
  out(`library         ${LIBRARY_PATH}`);
  out(`required        ${required.length} segments`);
  out(`already written ${required.length - copy.missing(required).length}`);
  out(
    `to write        ${todo.length} segments x ${VARIANTS_PER_SEGMENT} variants` +
      (minVariants > 1 ? `, topping up anything under ${minVariants}` : ""),
  );
  out(`budget          ${(budgetPaise / 100).toFixed(2)} rupees at list rate`);
  out();

  if (todo.length === 0) {
    out("nothing to do.");
    return;
  }
  if (dryRun) {
    out("--dry-run: no calls made.");
    return;
  }

  const ledger = new MemoryLedger();
  const price = priceFor(config.model);
  const mandate = buildMandate(secret, budgetPaise, worstCallPaise(todo, price));
  const terminus = new Terminus({
    mandate,
    secret,
    store: new MemoryStore(),
    audit: ledger,
    actor: "scribe/local",
    clock: systemClock,
  });

  const { composer } = geminiReasoners({
    config,
    onRetry: (attempt, waitMs, error) =>
      out(
        `   waiting ${(waitMs / 1000).toFixed(1)}s before attempt ${attempt + 1} — ${error.kind}`,
      ),
  });

  let done = 0;
  const result = await generate({
    terminus,
    composer,
    price,
    segments: todo,
    deadlineMs: DEADLINE_MS,
    onEvent: (event) => {
      done++;
      const head = `[${String(done).padStart(3)}/${todo.length}] ${event.key.padEnd(38)}`;
      if (event.refusal !== null) {
        out(`${head} — ${event.refusal}`);
        return;
      }
      const codes = event.rejected.flatMap((r) => r.codes);
      out(
        `${head} ${event.accepted.length}/${event.accepted.length + event.rejected.length} kept` +
          (codes.length === 0 ? "" : `  (${[...new Set(codes)].join(", ")})`),
      );
    },
  });

  const merged: CopyLibrary = {
    provenance: {
      model: composer.model,
      generatedAt: new Date().toISOString().slice(0, 10),
      promptHash: promptHash(),
      spentPaise: (existing?.provenance.spentPaise ?? 0) + result.spentPaise,
      calls: (existing?.provenance.calls ?? 0) + result.calls,
    },
    // Deduplicated by id, keeping what was already there. A variant's id is a hash of its text, so
    // a top-up run that regenerates a segment and produces a sentence it produced before is not a
    // new arm — and appending it blind would write a library `parseLibrary` refuses to read.
    variants: [
      ...new Map(
        [...(existing?.variants ?? []), ...result.variants].map((variant) => [variant.id, variant]),
      ).values(),
    ],
  };

  writeFileSync(LIBRARY_PATH, serialiseLibrary(merged));

  const after = statsFor(new Copy(merged), required);
  const kept = result.variants.length;

  out();
  out(`calls           ${result.calls}`);
  out(`tokens          ${result.usage.inputTokens} in, ${result.usage.outputTokens} out`);
  out(`spent           ${(result.spentPaise / 100).toFixed(2)} rupees at list rate`);
  out(
    `accepted        ${kept}/${result.proposed} variants` +
      (result.proposed === 0 ? "" : ` (${((100 * kept) / result.proposed).toFixed(0)}%)`),
  );
  if (result.rejections.size > 0) {
    out("rejected");
    for (const [code, count] of [...result.rejections].sort((a, b) => b[1] - a[1])) {
      out(`   ${String(count).padStart(4)}  ${code}`);
    }
  }
  out(
    `coverage        ${after.segments}/${required.length} segments, ` +
      `${after.averageVariantsPerSegment.toFixed(1)} variants each`,
  );
  if (result.stoppedBecause !== null) {
    out();
    out(`stopped early: ${result.stoppedBecause}`);
    out(`${result.unattempted.length} segments were not attempted. Run again to resume.`);
  }
  out();
  out(`written to ${LIBRARY_PATH}`);
}

function blank(): CopyLibrary["provenance"] {
  return {
    model: "none",
    generatedAt: "1970-01-01",
    promptHash: "0".repeat(16),
    spentPaise: 0,
    calls: 0,
  };
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
