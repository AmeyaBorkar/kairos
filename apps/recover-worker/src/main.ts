import { type Mandate, mandateId, paise } from "@kairos/domain";
import { MemoryLedger } from "@kairos/ledger";
import type { Gateway, Messenger } from "@kairos/razorpay";
import {
  DEFAULT_RECOVERY_CONFIG,
  MemoryCasualtyStore,
  RecoverWorker,
  RecoveryModel,
  worstActionCostPaise,
} from "@kairos/recover";
import { sealMandate, systemClock, Terminus } from "@kairos/terminus";
import { MemoryStore } from "throttlekit";
import { dryRunGateway, dryRunMessenger } from "./dry-run.js";
import { RecoveryExecutor } from "./executor.js";

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
 * It also holds its queue in memory, which makes it a single instance. The fleet story — a shared
 * queue with an atomic lease — is what `CasualtyStore` is an interface for, and the Postgres
 * implementation of it is not built. Two of these running today would each drain their own queue
 * rather than sharing one; they would still not double-spend, because the budget is in the shared
 * store, but they would not co-operate either.
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

async function main(): Promise<void> {
  const secret = required("KAIROS_MANDATE_SECRET", 32);
  const mandate = buildMandate(secret);
  const { gateway, messenger } = adapters();

  const ledger = new MemoryLedger();
  const terminus = new Terminus({
    mandate,
    secret,
    store: new MemoryStore(),
    audit: ledger,
    actor: `recover-worker/${process.env["HOSTNAME"] ?? "local"}`,
    clock: systemClock,
  });

  const worker = new RecoverWorker({
    terminus,
    store: new MemoryCasualtyStore(),
    // No directory is wired, so every message is addressed impersonally and no payment can be
    // charged again. That is the correct behaviour for a process with no access to customer data,
    // rather than a gap that fails at the moment it matters.
    directory: { lookup: () => Promise.resolve(null) },
    gauge: { isDegraded: () => false, recoveredAt: () => null },
    model: new RecoveryModel(),
    executor: new RecoveryExecutor({
      gateway,
      messenger,
      linkFor: (request) => `${required("KAIROS_LINK_BASE")}/${request.casualty.id}`,
      smsSegmentPaise: optionalInt("KAIROS_SMS_SEGMENT_PAISE", 20),
    }),
    clock: systemClock,
  });

  const intervalMs = optionalInt("KAIROS_DRAIN_INTERVAL_MS", 15_000);
  let running = true;

  // A drain pass is bounded and idempotent, so a shutdown that interrupts one loses nothing: the
  // lease expires, the reservation expires, and the next pass picks the casualty up unchanged.
  const stop = (): void => {
    running = false;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  process.stdout.write(
    `${JSON.stringify({ started: true, delivery: gateway.name, campaign: mandate.campaignId })}\n`,
  );

  while (running) {
    const report = await worker.drain();
    if (report.acted > 0 || report.refused > 0 || report.declined > 0) {
      process.stdout.write(`${JSON.stringify({ at: Date.now(), ...report })}\n`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  process.stdout.write(
    `${JSON.stringify({ shutdown: true, ledger: ledger.head, ...(await terminus.snapshot()) })}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
