import {
  applyOutcome,
  type Casualty,
  type CustomerRef,
  markOptedOut,
  paise,
  type RecoveryAttempt,
  type RecoveryOutcome,
} from "@kairos/domain";
import type { Clock, Grant, SettleReceipt, Terminus } from "@kairos/terminus";
import { type Classification, classify } from "./classify.js";
import { DEFAULT_RECOVERY_CONFIG, decide, type RecoveryConfig } from "./decide.js";
import type { RecoveryFeatures, RecoveryModel } from "./probability.js";
import { MODEL_CONFIDENCE } from "./residual.js";
import {
  DEFAULT_SCHEDULE_CONFIG,
  type RailGauge,
  type ScheduleConfig,
  schedule,
} from "./schedule.js";
import type { CasualtyStore, CustomerDirectory } from "./store.js";

/**
 * Something the worker can actually do to a casualty, once Terminus has authorised it.
 *
 * One port for both a charge and a message, because from the worker's point of view they are the
 * same shape: an authorised action goes out, something comes back, and it costs what it costs. The
 * differences between them belong in the adapter, not in the drain loop.
 */
export interface Executor {
  execute(request: ExecuteRequest): Promise<ExecuteResult>;
}

export interface ExecuteRequest {
  readonly grant: Grant;
  readonly casualty: Casualty;
  readonly classification: Classification;
  /** Resolved once, here, so nothing downstream has to ask for personal data. */
  readonly firstName: string | null;
  readonly token: string | null;
  readonly at: number;
}

export interface ExecuteResult {
  readonly outcome: RecoveryOutcome;
  /** What it actually cost. Reconciled against the reservation, never assumed equal to it. */
  readonly costPaise: number;
  readonly externalRef: string | null;
  /** Whether the customer asked to stop hearing from us as a result. */
  readonly optedOut: boolean;
}

export interface RecoverWorkerOptions {
  readonly terminus: Terminus;
  readonly store: CasualtyStore;
  readonly directory: CustomerDirectory;
  readonly gauge: RailGauge;
  readonly model: RecoveryModel;
  readonly executor: Executor;
  readonly clock: Clock;
  /** How long a claimed casualty stays claimed. Must exceed the slowest action. */
  readonly leaseMs?: number;
  readonly batchSize?: number;
  readonly config?: RecoveryConfig;
  readonly scheduleConfig?: ScheduleConfig;
}

/** What one pass over the queue did. Returned rather than logged, so the harness can assert on it. */
export interface DrainReport {
  readonly considered: number;
  readonly claimed: number;
  readonly acted: number;
  readonly recovered: number;
  readonly declined: number;
  readonly refused: number;
  readonly spentPaise: number;
  /** Refusals by the axis Terminus named. The answer to "why did nothing happen?". */
  readonly refusalsByAxis: Readonly<Record<string, number>>;
  /** Reasons the decision layer declined, counted. */
  readonly declinesByReason: Readonly<Record<string, number>>;
}

const EMPTY_REPORT: DrainReport = {
  considered: 0,
  claimed: 0,
  acted: 0,
  recovered: 0,
  declined: 0,
  refused: 0,
  spentPaise: 0,
  refusalsByAxis: {},
  declinesByReason: {},
};

/**
 * Recover what can be recovered, under a mandate, one pass at a time.
 *
 * Deliberately not a loop with a timer inside it. `drain` does one pass and returns what happened,
 * so the same object runs under a scheduler in production and under a simulated clock in the
 * harness, and a test can drive a month of dunning in a few milliseconds without waiting for any of
 * it. The daemon is thirty lines in `main.ts`; the behaviour worth testing is all here.
 *
 * ## The order of operations, and why it is this order
 *
 * Claim, decide, admit, execute, settle, reschedule. Each step exists because of a specific way the
 * previous one is not enough:
 *
 * - **Claim** before anything else, because Terminus's idempotent authority stops a crashed worker
 *   double-spending but does not stop two live workers double-sending.
 * - **Decide** before admitting, because admission is not free — it consumes a contact allowance —
 *   and asking for authority to do something not worth doing wastes a scarce resource on a
 *   casualty that was never going to be chased.
 * - **Admit** before executing, because that is the entire point of the kernel.
 * - **Settle** after executing, always, including when executing threw. An action whose cost is
 *   never reconciled holds authority until its TTL expires, and a reservation that outlives its
 *   action is the orphan the ledger counts.
 */
export class RecoverWorker {
  readonly #options: RecoverWorkerOptions;
  readonly #leaseMs: number;
  readonly #batchSize: number;
  readonly #config: RecoveryConfig;
  readonly #scheduleConfig: ScheduleConfig;

  constructor(options: RecoverWorkerOptions) {
    this.#options = options;
    this.#leaseMs = options.leaseMs ?? 5 * 60_000;
    this.#batchSize = options.batchSize ?? 64;
    this.#config = options.config ?? DEFAULT_RECOVERY_CONFIG;
    this.#scheduleConfig = options.scheduleConfig ?? DEFAULT_SCHEDULE_CONFIG;
  }

  /** One pass over everything due. */
  async drain(): Promise<DrainReport> {
    const now = this.#options.clock.now();
    const due = await this.#options.store.due(now, this.#batchSize);

    let report: DrainReport = { ...EMPTY_REPORT, considered: due.length };
    for (const casualty of due) {
      report = merge(report, await this.#work(casualty, now));
    }
    return report;
  }

  async #work(casualty: Casualty, now: number): Promise<Partial<DrainReport>> {
    const { store, terminus, model, gauge, directory } = this.#options;

    if (!(await store.claim(casualty.id, now, now + this.#leaseMs))) return {};

    const classification = classificationOf(casualty);
    const railHealthy = !gauge.isDegraded(casualty.slice);

    // Read the contact allowance without consuming it, so the decision can see how much this
    // customer has already had — across every casualty of theirs, not just this one, because
    // annoyance is a property of the person. Terminus consumes it for real at admission.
    const remaining = await terminus.remainingContacts(casualty.customer);
    const contactsRecent = Math.max(0, terminus.mandate.contactCap.limit - remaining);

    // Re-check the schedule before acting, even though the store only handed this over because it
    // said it was due. The two disagree exactly when somebody else set the due time — an intake
    // that queued a fresh casualty for "now", a reschedule after a crash — and acting on a stale
    // one means a message at three in the morning that Terminus then has to refuse. A refusal is a
    // correct outcome and a wasted pass; deferring is the same outcome without the waste.
    const planned = schedule(
      casualty,
      classification,
      now,
      gauge,
      terminus.mandate.quietHours,
      this.#scheduleConfig,
    );
    if (planned.dueAt === null || planned.dueAt > now) {
      await store.save(casualty, planned.dueAt);
      return { claimed: 1, declined: 1, declinesByReason: { [shortReason(planned.reason)]: 1 } };
    }

    const decision = decide(
      casualty,
      classification,
      model,
      railHealthy,
      contactsRecent,
      this.#config,
    );

    if (!decision.act) {
      // A decision not to act now is not a decision never to act. A casualty declined because its
      // rail is broken becomes worth chasing the moment it heals, and the schedule already knows
      // when to ask again — except for a control, which is never chased at all.
      await store.save(
        casualty,
        decision.reason.includes("control") ? null : now + this.#scheduleConfig.minBackoffMs,
      );
      return { claimed: 1, declined: 1, declinesByReason: { [shortReason(decision.reason)]: 1 } };
    }

    const admission = await terminus.admit({
      action: decision.action,
      status: casualty.status,
      attemptNo: casualty.attempts.length,
    });

    if (!admission.allowed) {
      const retryAt = admission.retryAfterMs === null ? null : now + admission.retryAfterMs;
      await store.save(casualty, retryAt);
      return { claimed: 1, refused: 1, refusalsByAxis: { [admission.axis]: 1 } };
    }

    return await this.#execute(casualty, classification, admission.grant, now, directory);
  }

  async #execute(
    casualty: Casualty,
    classification: Classification,
    grant: Grant,
    now: number,
    directory: CustomerDirectory,
  ): Promise<Partial<DrainReport>> {
    const { store, terminus, model, gauge } = this.#options;

    const profile = await this.#profile(casualty.customer, directory);
    let result: ExecuteResult;
    try {
      result = await this.#options.executor.execute({
        grant,
        casualty,
        classification,
        firstName: profile?.firstName ?? null,
        token: profile?.token ?? null,
        at: now,
      });
    } catch (cause) {
      // The action did not happen, so nothing was spent — but the authority is still held, and a
      // held reservation refuses other workers on the concurrency axis until its TTL expires.
      // Handing it back is the difference between one failed send and a stalled fleet.
      await terminus.abandon(grant, `execution failed: ${describe(cause)}`);
      await store.save(casualty, now + this.#scheduleConfig.minBackoffMs);
      return { claimed: 1, refused: 1, refusalsByAxis: { execution: 1 } };
    }

    const receipt = await this.#settle(grant, result);

    let updated = applyOutcome(casualty, attemptFrom(grant, result, now));
    if (result.optedOut) updated = markOptedOut(updated);

    // Feed the realised outcome back before rescheduling, so the next decision about this casualty
    // is made by a model that has seen what happened to it.
    model.observe(
      featuresOf(updated, classification, grant, gauge),
      result.outcome === "recovered",
    );

    const next = schedule(
      updated,
      classification,
      now,
      gauge,
      terminus.mandate.quietHours,
      this.#scheduleConfig,
    );
    await store.save(updated, next.dueAt);

    return {
      claimed: 1,
      acted: 1,
      recovered: result.outcome === "recovered" ? 1 : 0,
      spentPaise: receipt?.actualPaise ?? 0,
    };
  }

  /**
   * Reconcile, and never let a failure to record become a failure to reconcile.
   *
   * Settlement throws when the money moved but the record did not. The money has already moved by
   * then, so swallowing it would be wrong — but so would abandoning the drain pass, because every
   * other casualty in the batch is unaffected. The receipt rides along on the error, so the retry
   * writes only the missing half rather than booking the spend twice.
   */
  async #settle(grant: Grant, result: ExecuteResult): Promise<SettleReceipt | null> {
    const cost = paise(Math.max(0, Math.round(result.costPaise)), "actualCost");
    try {
      return await this.#options.terminus.settle(grant, cost, result.outcome, result.externalRef);
    } catch (error) {
      const receipt = (error as { receipt?: SettleReceipt }).receipt;
      if (receipt === undefined) throw error;
      try {
        await this.#options.terminus.recordSettlement(receipt, grant);
      } catch {
        // Retried once and still unrecorded. The spend is booked and the ledger is short a line —
        // which is exactly the state P8 says must be loud, so it is left for the operator rather
        // than papered over here.
      }
      return receipt;
    }
  }

  async #profile(
    customer: CustomerRef,
    directory: CustomerDirectory,
  ): Promise<{ firstName: string | null; token: string | null } | null> {
    try {
      return await directory.lookup(customer);
    } catch {
      // A directory that cannot be read costs a first name, not a recovery. The message goes out
      // addressed impersonally rather than not at all.
      return null;
    }
  }
}

/**
 * The classification of a casualty as it stands now.
 *
 * Re-derived rather than stored, because it is pure and cheap and a stored copy is a copy that can
 * disagree with the table that produced it. The one thing that cannot be re-derived is a residual
 * the model refined: the table still says `unknown`, and the casualty says otherwise. That
 * disagreement is itself the record that a model decided this one, and it is reconstructed here
 * rather than carried as a fourth field that could drift out of step with the class beside it.
 */
export function classificationOf(casualty: Casualty): Classification {
  const deterministic = classify(casualty.failure, casualty.kind);
  const stored = casualty.status.recoverability;

  if (deterministic.recoverability === stored) return deterministic;
  if (deterministic.source !== "default") {
    // The table names it and the casualty disagrees. That should not happen, and the table wins:
    // a stored class that contradicts a deterministic rule is stale data, not a refinement.
    return deterministic;
  }
  return {
    recoverability: stored,
    rule: "model:residual",
    source: "model",
    confidence: MODEL_CONFIDENCE,
  };
}

function featuresOf(
  casualty: Casualty,
  classification: Classification,
  grant: Grant,
  gauge: RailGauge,
): RecoveryFeatures {
  return {
    action: grant.action.kind,
    recoverability: classification.recoverability,
    confidence: classification.confidence,
    railHealthy: !gauge.isDegraded(casualty.slice),
    // The attempt that just landed is already folded in, so the ordinal the decision was made under
    // is one less than the count now.
    attemptOrdinal: Math.max(0, casualty.attempts.length - 1),
  };
}

function attemptFrom(grant: Grant, result: ExecuteResult, at: number): RecoveryAttempt {
  return {
    kind: grant.action.kind,
    at,
    outcome: result.outcome,
    costPaise: paise(Math.max(0, Math.round(result.costPaise)), "cost"),
    externalRef: result.externalRef,
  };
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Reasons are sentences; a histogram needs a key. Take the first clause. */
function shortReason(reason: string): string {
  return reason.split(",")[0]?.slice(0, 48) ?? reason.slice(0, 48);
}

function merge(into: DrainReport, part: Partial<DrainReport>): DrainReport {
  return {
    considered: into.considered,
    claimed: into.claimed + (part.claimed ?? 0),
    acted: into.acted + (part.acted ?? 0),
    recovered: into.recovered + (part.recovered ?? 0),
    declined: into.declined + (part.declined ?? 0),
    refused: into.refused + (part.refused ?? 0),
    spentPaise: into.spentPaise + (part.spentPaise ?? 0),
    refusalsByAxis: tally(into.refusalsByAxis, part.refusalsByAxis),
    declinesByReason: tally(into.declinesByReason, part.declinesByReason),
  };
}

function tally(
  into: Readonly<Record<string, number>>,
  part: Readonly<Record<string, number>> | undefined,
): Readonly<Record<string, number>> {
  if (part === undefined) return into;
  const out = { ...into };
  for (const [key, value] of Object.entries(part)) out[key] = (out[key] ?? 0) + value;
  return out;
}
