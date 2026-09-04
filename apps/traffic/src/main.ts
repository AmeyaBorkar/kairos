import type { Casualty } from "@kairos/domain";
import { migrate, PostgresCasualtyStore } from "@kairos/postgres";
import type { CasualtyStore } from "@kairos/recover";
import { MemoryCasualtyStore } from "@kairos/recover";
import { Pool } from "pg";
import { type Batch, DEFAULT_MERCHANT, Merchant, type OutcomeRow } from "./merchant.js";

/**
 * The traffic process.
 *
 * Drives the two touchpoints a real integration has, in the order a real checkout has them: ask for
 * a plan before the page renders, report the outcome after the payment resolves. The third thing it
 * does — filing casualties into the store the worker drains — is not a touchpoint at all in a real
 * deployment, where the intake runs on the merchant's webhook. It is here because the alternative
 * was a worker with an empty queue, and a queue that is always empty proves nothing.
 *
 * Everything it emits is one JSON object per line on stdout, because the only reader that matters
 * is `docker compose logs` and a person squinting at it.
 */

function optionalInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, received ${JSON.stringify(raw)}`);
  }
  return parsed;
}

const SENTRY = process.env["KAIROS_SENTRY_URL"] ?? "http://localhost:8080";
const TICK_MS = optionalInt("KAIROS_TRAFFIC_TICK_MS", 2000);

/** `POST /outcomes` caps a batch at 1000, and a pass at 60x can exceed that on a busy minute. */
const MAX_BATCH = 1000;

/** Earlier than any clock any process here could report. See `file`. */
const DUE_NOW = 0;

function log(line: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

/**
 * Wait for the sentry to answer.
 *
 * Compose starts everything at once and a dependency that is merely *started* is not a dependency
 * that is *listening*. Retried rather than ordered, because there is no ordering that survives a
 * slow first boot — and reported, so a stack that never comes up says which service it is waiting
 * on rather than sitting silent.
 */
async function waitForSentry(): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(`${SENTRY}/health`);
      if (response.ok) return;
    } catch {
      /* not listening yet */
    }
    if (attempt % 5 === 0) log({ waiting: "sentry", url: SENTRY, attempt });
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function report(outcomes: readonly OutcomeRow[]): Promise<number> {
  let accepted = 0;
  for (let i = 0; i < outcomes.length; i += MAX_BATCH) {
    const response = await fetch(`${SENTRY}/outcomes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attempts: outcomes.slice(i, i + MAX_BATCH) }),
    });
    if (!response.ok) {
      log({ error: "outcomes rejected", status: response.status, body: await response.text() });
      return accepted;
    }
    accepted += ((await response.json()) as { accepted?: number }).accepted ?? 0;
  }
  return accepted;
}

/**
 * Ask for a plan the way a checkout would.
 *
 * One customer per pass rather than all of them. The point is to show the hot path answering and to
 * put a steered sequence in the log where somebody can see it, not to load-test a route whose
 * latency the benchmark already measures properly.
 */
async function askPlan(customer: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(`${SENTRY}/plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ customer }),
    });
    const plan = (await response.json()) as {
      sequence?: string[];
      suppress?: string[];
      steered?: boolean;
      arm?: string;
      reason?: string;
    };
    if (plan.steered !== true) return null;
    // Only the steered ones. A line per pass saying "nothing was steered" is a line nobody reads.
    return {
      plan: customer.slice(0, 12),
      sequence: plan.sequence?.slice(0, 3),
      suppress: plan.suppress,
      arm: plan.arm,
    };
  } catch (error) {
    log({ error: "plan unavailable", detail: error instanceof Error ? error.message : "unknown" });
    return null;
  }
}

/**
 * Where casualties are filed.
 *
 * The same choice the worker makes, made the same way: Postgres if there is a URL, memory if there
 * is not. Memory here means the worker gets nothing, which is worth saying out loud rather than
 * leaving somebody to wonder why an obviously busy stream produces no recovery.
 */
async function store(): Promise<{ store: CasualtyStore; name: string; close(): Promise<void> }> {
  const url = process.env["KAIROS_DATABASE_URL"];
  if (url === undefined) {
    return {
      store: new MemoryCasualtyStore(),
      name: "memory (the worker is a separate process and will see none of this)",
      close: () => Promise.resolve(),
    };
  }
  const pool = new Pool({ connectionString: url, max: optionalInt("KAIROS_DB_POOL_MAX", 4) });
  if (process.env["KAIROS_DB_MIGRATE"] !== "off") await migrate(pool);
  return {
    store: new PostgresCasualtyStore({ sql: pool }),
    name: "postgres",
    close: () => pool.end(),
  };
}

/**
 * File the failures.
 *
 * Due immediately, and immediately means zero rather than "when it happened".
 *
 * The intake is not a scheduler. `schedule()` inside the worker decides when a casualty is worth
 * acting on — the rail coming back, the hour a customer is likely to have money, the next rung of a
 * backoff — and a due date invented here would be a second scheduler disagreeing with the first.
 *
 * It also has to be a date the worker can read. This process stamps attempts in its own accelerated
 * frame, whose origin is the moment *it* booted; the worker's frame has its own origin. They agree
 * closely enough while both are running, and not at all once either restarts: a worker that comes
 * back sixty seconds later starts an hour behind in simulated time, and every casualty already in
 * the queue is dated in its future. It would then consider nothing, for ever, while looking
 * perfectly healthy. Zero is the one value no clock disagrees about.
 */
async function file(target: CasualtyStore, casualties: readonly Casualty[]): Promise<number> {
  let filed = 0;
  for (const casualty of casualties) {
    try {
      await target.save(casualty, DUE_NOW);
      filed++;
    } catch (error) {
      log({ error: "could not file", detail: error instanceof Error ? error.message : "unknown" });
    }
  }
  return filed;
}

async function main(): Promise<void> {
  const bootAt = Date.now();
  const options = {
    ...DEFAULT_MERCHANT,
    bootAt,
    speed: optionalInt("KAIROS_TRAFFIC_SPEED", DEFAULT_MERCHANT.speed),
    attemptsPerMinute: optionalInt("KAIROS_TRAFFIC_APM", DEFAULT_MERCHANT.attemptsPerMinute),
    degradeAfterMs: optionalInt("KAIROS_TRAFFIC_DEGRADE_AFTER_MS", DEFAULT_MERCHANT.degradeAfterMs),
  };

  const merchant = new Merchant(options);
  const casualties = await store();
  await waitForSentry();

  log({
    started: true,
    sentry: SENTRY,
    casualties: casualties.name,
    speed: `${options.speed}x`,
    attemptsPerMinute: options.attemptsPerMinute,
    // The one thing a watcher wants to know before they decide whether to keep watching.
    degradesIn: `${Math.round(options.degradeAfterMs / 1000)}s`,
    seed: options.seed,
  });

  let running = true;
  const stop = (): void => {
    running = false;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  let totals = { attempts: 0, failures: 0, filed: 0 };

  while (running) {
    const batch: Batch = merchant.drain(Date.now());
    if (batch.outcomes.length > 0) {
      const accepted = await report(batch.outcomes);
      const filed = await file(casualties.store, batch.casualties);
      totals = {
        attempts: totals.attempts + accepted,
        failures: totals.failures + batch.casualties.length,
        filed: totals.filed + filed,
      };
      log({ sent: accepted, casualties: filed, total: totals });

      if (batch.askPlanFor !== null) {
        const steered = await askPlan(batch.askPlanFor);
        if (steered !== null) log(steered);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, TICK_MS));
  }

  await casualties.close();
  log({ shutdown: true, ...totals });
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
