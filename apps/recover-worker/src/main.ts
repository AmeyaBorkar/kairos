import { type Mandate, mandateId, paise } from "@kairos/domain";
import { MemoryLedger } from "@kairos/ledger";
import { migrate, PostgresCasualtyStore } from "@kairos/postgres";
import type { Gateway, Messenger } from "@kairos/razorpay";
import {
  type CasualtyStore,
  type CustomerDirectory,
  DEFAULT_RECOVERY_CONFIG,
  MemoryCasualtyStore,
  RecoverWorker,
  RecoveryModel,
  worstActionCostPaise,
} from "@kairos/recover";
import {
  type KillSwitch,
  openKillSwitch,
  StopSwitch,
  scaledClock,
  sealMandate,
  Terminus,
} from "@kairos/terminus";
import { Pool } from "pg";
import { MemoryStore, type Store } from "throttlekit";
import { PostgresStore } from "throttlekit/postgres";
import { serveAdmin } from "./admin.js";
import { clockSpeedFrom } from "./clock.js";
import { simulatedDirectory } from "./directory.js";
import { dryRunGateway, dryRunMessenger } from "./dry-run.js";
import { RecoveryExecutor } from "./executor.js";
import { accumulate, emptyTotals, type MetricsInput } from "./metrics.js";

/**
 * The daemon.
 *
 * Everything worth testing lives in `RecoverWorker.drain`, which does one pass and returns what
 * happened. This file is the loop around it, the wiring, and the refusals that stop the process
 * starting in a state where a bound could not be enforced.
 *
 * ## What this process is and is not
 *
 * It is the real decision path: classification, the expected-value gate, Terminus admission,
 * composition, cost. It runs by default in **dry-run delivery**, which decides everything and sends
 * nothing, because a Razorpay account able to charge saved tokens and a DLT-registered sender are
 * things a deployment has and a repository does not.
 *
 * How many of these may run at once is decided by one environment variable. With
 * `KAIROS_DATABASE_URL` set, the queue and the spend authority both live in Postgres and the
 * workers are a fleet: they share one budget, and an atomic lease on each casualty stops two of
 * them acting on the same one. Without it, both live in memory and this is a single instance —
 * which is a fine way to run it, and much better than a second copy quietly sharing nothing.
 *
 * ## What is still single-instance
 *
 * The audit ledger. `MemoryLedger` is a hash chain in this process, so a fleet produces one chain
 * per worker: each is internally verifiable and none of them is the whole story. Nothing is lost —
 * every record is still written and still tamper-evident — but somebody asking "show me everything
 * done under this mandate" has to be handed N chains and told how to interleave them. A shared
 * appender is the remaining piece, and it is not built.
 */

const DAY = 86_400_000;

function required(name: string, minLength = 1): string {
  const value = process.env[name];
  if (value === undefined || value.length < minLength) {
    throw new Error(
      `${name} must be set and at least ${minLength} characters. There is no development default: ` +
        "a worker that can spend money without a real secret is a worker whose mandate can be forged.",
    );
  }
  return value;
}

function optionalInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, received ${JSON.stringify(raw)}`);
  }
  return parsed;
}

/**
 * Build the mandate this worker runs under.
 *
 * In production this arrives already signed from a control plane; here it is sealed at startup from
 * configuration, so no signed mandate is committed to the repository. Either way the worker
 * verifies the signature on every single admission, so a mandate that arrived by a route nobody
 * intended is refused before any of its fields are read.
 *
 * The per-action ceiling comes from the price list rather than from configuration. A mandate whose
 * ceiling is below the worst message the system can compose would refuse that message at
 * settlement, after it had already been sent.
 */
function buildMandate(secret: string): Mandate {
  const now = Date.now();
  return sealMandate(
    {
      id: mandateId(process.env["KAIROS_MANDATE_ID"] ?? `mnd_${now.toString(36)}`),
      merchantId: required("KAIROS_MERCHANT_ID"),
      campaignId: process.env["KAIROS_CAMPAIGN_ID"] ?? "recovery",
      budgetPaise: paise(optionalInt("KAIROS_BUDGET_PAISE", 100_000), "budget"),
      maxActionCostPaise: worstActionCostPaise(DEFAULT_RECOVERY_CONFIG),
      maxInFlight: optionalInt("KAIROS_MAX_IN_FLIGHT", 16),
      reservationTtlMs: optionalInt("KAIROS_RESERVATION_TTL_MS", 120_000),
      contactCap: {
        limit: optionalInt("KAIROS_CONTACT_LIMIT", 3),
        windowMs: optionalInt("KAIROS_CONTACT_WINDOW_MS", 7 * DAY),
      },
      // 21:00–08:00 IST. Not configurable, because a merchant who wants to message people at
      // 03:00 wants something Kairos does not do.
      quietHours: { startMinute: 21 * 60, endMinute: 8 * 60, offsetMinutes: 330 },
      allowedActions: ["retry", "contact-sms", "contact-whatsapp", "contact-email"],
      validFrom: now - 60_000,
      validUntil: now + optionalInt("KAIROS_CAMPAIGN_DAYS", 30) * DAY,
      killSwitch: false,
    },
    secret,
  );
}

/**
 * Choose how actions are delivered.
 *
 * Dry-run by default and live only when asked for, because the failure mode of getting this
 * backwards is unrecoverable — a message sent by mistake cannot be unsent, and a merchant who meant
 * to observe for a week and instead messaged their customers has a problem no rollback fixes.
 */
function adapters(): { gateway: Gateway; messenger: Messenger } {
  const mode = process.env["KAIROS_DELIVERY"] ?? "dry-run";
  const sink = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };

  if (mode === "dry-run") {
    return { gateway: dryRunGateway({ sink }), messenger: dryRunMessenger({ sink }) };
  }

  throw new Error(
    `KAIROS_DELIVERY=${JSON.stringify(mode)} requires a live gateway and messenger, and none is ` +
      "wired. The recovery arm needs a Razorpay account able to charge saved tokens and a " +
      "DLT-registered SMS or WhatsApp sender. Supply them in main.ts, or leave KAIROS_DELIVERY " +
      "unset to decide everything and send nothing.",
  );
}

/**
 * Who the customers are, as far as this process is allowed to know.
 *
 * Nobody, by default. The lookup returns `null` for everyone, so no payment can be charged again
 * and every message is addressed impersonally — the correct behaviour for a process that has not
 * been handed access to customer records, and structural rather than promised: a component without
 * this port cannot obtain personal data however much it decides it needs.
 *
 * The cost of that default is that a dry run shows almost nothing. The executor refuses a retry
 * with no token and a message with no recipient before it composes anything, so the two things a
 * merchant runs dry-run delivery to see — the words that would have been sent, and what sending
 * them would have cost — never appear. `KAIROS_DIRECTORY=simulated` stands people in for that, and
 * says so in the startup line, because a demonstration that looked like a deployment would be
 * worse than no demonstration.
 */
function customerDirectory(): CustomerDirectory {
  if (process.env["KAIROS_DIRECTORY"] !== "simulated") {
    return { lookup: () => Promise.resolve(null) };
  }
  return simulatedDirectory({
    // The simulator's own default. A merchant with no recurring business has no autonomous retries
    // at all and a recovery arm made entirely of messages, and this is the number that decides it.
    mandatedShare: Number(process.env["KAIROS_MANDATED_SHARE"] ?? 0.42),
  });
}

/**
 * Where shared state lives, and therefore how many of these may run at once.
 *
 * The two things a second worker must share are not the same thing and do not live in the same
 * place. **Authority** — the budget, the in-flight cap, the contact caps — lives in ThrottleKit's
 * `Store`, and is what stops two workers double-*spending*. **The queue** lives in
 * `CasualtyStore`, and is what stops them double-*sending*: idempotent authority hands both
 * workers the same grant for the same casualty, so only an atomic claim keeps one customer's phone
 * from ringing twice.
 *
 * Both are Postgres, in the same database, through the same pool. `KAIROS_DATABASE_URL` is the
 * entire difference between one instance and a fleet.
 *
 * Without it the worker runs on memory and is a single instance by construction — which is a
 * legitimate way to run it, and much better than a second instance quietly sharing nothing.
 */
interface Backing {
  readonly name: string;
  readonly store: Store;
  readonly casualties: CasualtyStore;
  /**
   * The out-of-band stop, when there is a shared store to keep it in.
   *
   * A per-process switch would stop the process holding it and nothing else, which is worse than
   * having none: an operator who ran one command expecting the fleet to halt would believe it had.
   * So without a database there is no switch, and the startup line says so.
   */
  readonly killSwitch: KillSwitch;
  close(): Promise<void>;
}

async function backing(): Promise<Backing> {
  const url = process.env["KAIROS_DATABASE_URL"];

  if (url === undefined) {
    return {
      name: "memory",
      store: new MemoryStore(),
      casualties: new MemoryCasualtyStore(),
      killSwitch: openKillSwitch,
      close: () => Promise.resolve(),
    };
  }

  const pool = new Pool({
    connectionString: url,
    max: optionalInt("KAIROS_DB_POOL_MAX", 10),
  });

  // Idempotent, and cheap enough to pay on every boot. A deployment that would rather own its
  // schema can run `pnpm --filter @kairos/postgres run schema | psql` and set KAIROS_DB_MIGRATE=off.
  if (process.env["KAIROS_DB_MIGRATE"] !== "off") await migrate(pool);

  const store = new PostgresStore({ pool, table: "kairos_throttle" });
  return {
    name: "postgres",
    store,
    casualties: new PostgresCasualtyStore({ sql: pool }),
    killSwitch: new StopSwitch(store),
    close: async () => {
      // ThrottleKit does not end a pool it does not own, so the order matters: stop its sweep
      // first, then close the pool underneath it.
      await store.close();
      await pool.end();
    },
  };
}

async function main(): Promise<void> {
  const secret = required("KAIROS_MANDATE_SECRET", 32);

  // Read before anything is constructed. A refusal about how this process handles time belongs
  // before the first pool is opened, not after a mandate has been sealed against a clock we are
  // then going to reject.
  const speed = clockSpeedFrom(process.env, process.env["KAIROS_DELIVERY"] ?? "dry-run");
  const clock = scaledClock(speed);

  const mandate = buildMandate(secret);
  const { gateway, messenger } = adapters();
  const directory = customerDirectory();

  const persistence = await backing();
  const ledger = new MemoryLedger();
  const terminus = new Terminus({
    mandate,
    secret,
    store: persistence.store,
    audit: ledger,
    actor: `recover-worker/${process.env["HOSTNAME"] ?? "local"}`,
    clock,
    killSwitch: persistence.killSwitch,
  });

  const worker = new RecoverWorker({
    terminus,
    store: persistence.casualties,
    directory,
    gauge: { isDegraded: () => false, recoveredAt: () => null },
    model: new RecoveryModel(),
    executor: new RecoveryExecutor({
      gateway,
      messenger,
      linkFor: (request) => `${required("KAIROS_LINK_BASE")}/${request.casualty.id}`,
      smsSegmentPaise: optionalInt("KAIROS_SMS_SEGMENT_PAISE", 20),
    }),
    clock,
  });

  const intervalMs = optionalInt("KAIROS_DRAIN_INTERVAL_MS", 15_000);
  /**
   * Two clocks, and every question belongs to exactly one of them.
   *
   * Decisions are made against `clock`, which a demonstration may have accelerated: backoff rungs,
   * quiet hours, reservation TTLs and the drain report's own timestamp all live in that frame,
   * because they are all about the campaign.
   *
   * Liveness is not about the campaign. A probe's timeout, an operator's patience and the number an
   * uptime graph plots are real seconds, and reading them off an accelerated clock reports a
   * two-minute-old process as having run for two hours — and then calls it stalled, because the
   * gap between two passes measured on a 60x clock is sixty times the interval that produced it.
   */
  const startedAt = Date.now();
  let totals = emptyTotals();
  let running = true;

  /**
   * Everything a scrape needs, read fresh.
   *
   * The store reads are allowed to fail and are reported as a failure rather than thrown. A metrics
   * endpoint that returns 500 when the database is slow removes the one signal that would have told
   * you the database is slow.
   */
  const snapshot = async (): Promise<MetricsInput> => {
    const budget = await terminus.snapshot().catch(() => null);
    const stopEngaged =
      persistence.name === "postgres"
        ? await persistence.killSwitch.engaged(mandate).catch(() => null)
        : null;
    return {
      totals,
      budget,
      stopEngaged,
      startedAt,
      now: Date.now(),
      fleet: persistence.name === "postgres",
      delivery: gateway.name,
      campaignId: mandate.campaignId,
      merchantId: mandate.merchantId,
    };
  };

  const admin = serveAdmin({
    port: optionalInt("KAIROS_ADMIN_PORT", 9464),
    snapshot,
    identity: {
      delivery: gateway.name,
      campaign: mandate.campaignId,
      backing: persistence.name,
      fleet: persistence.name === "postgres",
    },
    totals: () => totals,
    now: () => Date.now(),
    // Four intervals. One slow pass is not a stuck loop, and a probe that cannot tell the
    // difference restarts a worker that was about to succeed and loses the lease it was holding.
    stallAfterMs: intervalMs * 4,
    startedAt,
  });

  // A drain pass is bounded and idempotent, so a shutdown that interrupts one loses nothing: the
  // lease expires, the reservation expires, and the next pass picks the casualty up unchanged.
  const stop = (): void => {
    running = false;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  process.stdout.write(
    `${JSON.stringify({
      started: true,
      delivery: gateway.name,
      campaign: mandate.campaignId,
      backing: persistence.name,
      fleet: persistence.name === "postgres",
      stopSwitch:
        persistence.name === "postgres" ? "kairos-mandate stop" : "none — needs a database",
      directory: process.env["KAIROS_DIRECTORY"] === "simulated" ? "simulated people" : "none",
      ...(speed === 1 ? {} : { clock: `${speed}x — a demonstration, not a deployment` }),
    })}\n`,
  );

  while (running) {
    const report = await worker.drain();
    // Wall clock, because the only reader of this timestamp is the liveness probe.
    totals = accumulate(totals, report, Date.now());
    if (report.acted > 0 || report.refused > 0 || report.declined > 0) {
      // The clock the decisions were made against, not the wall clock. Under an accelerated
      // clock those differ, and a report stamped in a frame none of its contents belong to is
      // worse than one with no timestamp at all.
      process.stdout.write(`${JSON.stringify({ at: clock.now(), ...report })}\n`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  // Read the books before closing: they go through the store the close is about to release.
  const books = await terminus.snapshot();
  admin.close();
  await persistence.close();
  process.stdout.write(`${JSON.stringify({ shutdown: true, ledger: ledger.head, ...books })}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
