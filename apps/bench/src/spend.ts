import {
  type CasualtyId,
  type CustomerRef,
  casualtyId,
  customerRef,
  mandateId,
  type ProposedAction,
  paise,
  rupees,
} from "@kairos/domain";
import { MemoryLedger } from "@kairos/ledger";
import { Rng } from "@kairos/simulator";
import {
  CLEAN_STATUS,
  estimateSizer,
  learnedSizer,
  ManualClock,
  overspendBoundPaise,
  predictiveSizer,
  type Sizer,
  sealMandate,
  Terminus,
  type UnsignedMandate,
  worstCaseSizer,
} from "@kairos/terminus";
import { MemoryStore } from "throttlekit";

const DAY = 86_400_000;
const SECRET = "bench-secret";
/** Noon UTC — 17:30 IST, so quiet hours never bind and the spend axis is what is measured. */
const START = Date.UTC(2026, 7, 25, 12, 0, 0);

/**
 * What one message actually costs, and why it is not knowable in advance.
 *
 * GSM-7 fits 160 characters in a segment; Devanagari forces UCS-2 at 70. The same sentence is one
 * segment in Latin script and three in Devanagari, and the model chooses the script while it is
 * writing. The estimate is always one segment, which is what a system that trusted its own quote
 * would reserve.
 */
const ONE_SEGMENT = rupees(1);
const THREE_SEGMENTS = rupees(3);
const ESTIMATE = ONE_SEGMENT;

export interface Job {
  /** A distinct failed payment. Unique per job, so no two actions share an idempotency key. */
  readonly casualty: CasualtyId;
  /** Customers repeat across jobs — which is what makes the per-customer contact cap bind. */
  readonly customer: CustomerRef;
  readonly actualCostPaise: number;
  /** Scheduler ticks between the decision and the cost becoming known. */
  readonly latencyTicks: number;
}

export interface SpendOptions {
  readonly workers: number;
  readonly budgetPaise: number;
  readonly maxInFlight: number;
  readonly contactCapLimit: number;
  readonly jobs: number;
  readonly customers: number;
  /** Share of messages the model writes in Devanagari, and so prices at three segments. */
  readonly devanagariShare: number;
  readonly seed: number;
}

export const DEFAULT_SPEND_OPTIONS: SpendOptions = {
  workers: 16,
  budgetPaise: rupees(500),
  maxInFlight: 8,
  contactCapLimit: 3,
  jobs: 4000,
  customers: 300,
  devanagariShare: 0.35,
  seed: 20_260_825,
};

/**
 * Yield control `n` times.
 *
 * The microtask queue is FIFO, so a fixed number of yields produces a fixed interleaving: the whole
 * experiment is deterministic given its seed, despite being genuinely concurrent. This is what
 * stands in for the real gap between deciding to send a message and learning what it cost.
 */
async function yieldTicks(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

/**
 * Build the casualty queue, **clustered by customer**.
 *
 * The clustering is deliberate and it is what makes the contact cap a real test. A customer whose
 * card is failing generates several casualties close together — one incident, several retries, an
 * abandoned checkout — so their jobs arrive adjacent in the queue and a fleet of workers picks them
 * up at the same moment. Spreading each customer's jobs evenly across the queue would make a
 * check-then-act cap look correct, because no two workers would ever hold the same customer at
 * once. That would be measuring the queue's ordering rather than the code.
 */
export function buildJobs(options: SpendOptions): Job[] {
  const rng = new Rng(options.seed);
  const perCustomer = Math.max(1, Math.ceil(options.jobs / options.customers));
  const jobs: Job[] = [];

  for (let i = 0; i < options.jobs; i++) {
    const customer = Math.min(options.customers - 1, Math.floor(i / perCustomer));
    jobs.push({
      casualty: casualtyId(`cas_${i.toString().padStart(6, "0")}`),
      customer: customerRef(`cus_${customer.toString().padStart(12, "0")}`),
      actualCostPaise: rng.bool(options.devanagariShare) ? THREE_SEGMENTS : ONE_SEGMENT,
      latencyTicks: 1 + rng.int(4),
    });
  }
  return jobs;
}

/** A queue several workers drain concurrently. */
class Queue {
  #next = 0;
  readonly #jobs: readonly Job[];

  constructor(jobs: readonly Job[]) {
    this.#jobs = jobs;
  }

  take(): Job | null {
    return this.#next < this.#jobs.length ? (this.#jobs[this.#next++] ?? null) : null;
  }
}

export interface ArmResult {
  readonly arm: string;
  readonly workers: number;
  readonly budgetPaise: number;
  readonly spentPaise: number;
  /** Spend above the budget. The number the whole kernel exists to keep at zero. */
  readonly overspendPaise: number;
  /**
   * The overspend this configuration permits, `null` where nothing bounds it.
   *
   * For the kernel this is `maxInFlight x (maxActionCost - reservation)`, evaluated at the smallest
   * reservation the run actually took — a checkable statement about this run rather than the
   * vacuous worst case over every reservation an adaptive sizer might ever choose.
   */
  readonly boundPaise: number | null;
  readonly actionsTaken: number;
  /** Spend as a fraction of budget — safety's own cost, when it is below one. */
  readonly utilisation: number;
  /** Contacts delivered to a customer beyond the cap. */
  readonly capViolations: number;
  readonly maxContactsToOneCustomer: number;
}

function tally(customers: Map<CustomerRef, number>, capLimit: number) {
  let violations = 0;
  let worst = 0;
  for (const count of customers.values()) {
    if (count > capLimit) violations += count - capLimit;
    if (count > worst) worst = count;
  }
  return { violations, worst };
}

/**
 * Check the budget, then spend against it — the implementation almost everyone writes first.
 *
 * There is nothing obviously wrong with it. It reads the remaining budget, confirms the action
 * fits, does the work, and books the cost. The bug is the gap: between the check and the booking,
 * every other worker also checks, and they all see a budget that nobody has debited yet.
 */
export async function runNaive(options: SpendOptions): Promise<ArmResult> {
  const jobs = buildJobs(options);
  const queue = new Queue(jobs);
  const shared = { spentPaise: 0, actions: 0 };

  /** The naive implementation's own view of who has been contacted. Raced, like everything else. */
  const contacts = new Map<CustomerRef, number>();
  /**
   * What was actually delivered.
   *
   * Kept separately because the racy counter above cannot be trusted to report its own failure:
   * two workers that both read `seen = 0` also both write `1`, so the map ends up claiming one
   * contact for a customer who received several. Measuring the violation from the same structure
   * that caused it would report zero violations for a run full of them.
   */
  const delivered = new Map<CustomerRef, number>();

  const worker = async (): Promise<void> => {
    for (;;) {
      const job = queue.take();
      if (job === null) return;

      // Check.
      if (shared.spentPaise + ESTIMATE > options.budgetPaise) return;
      const seen = contacts.get(job.customer) ?? 0;
      if (seen >= options.contactCapLimit) continue;

      // Act. The real cost becomes known only here.
      await yieldTicks(job.latencyTicks);

      // Spend.
      shared.spentPaise += job.actualCostPaise;
      shared.actions++;
      contacts.set(job.customer, seen + 1);
      delivered.set(job.customer, (delivered.get(job.customer) ?? 0) + 1);
    }
  };

  await Promise.all(Array.from({ length: options.workers }, worker));

  const capped = tally(delivered, options.contactCapLimit);
  return {
    arm: "naive check-then-spend",
    workers: options.workers,
    budgetPaise: options.budgetPaise,
    spentPaise: shared.spentPaise,
    overspendPaise: Math.max(0, shared.spentPaise - options.budgetPaise),
    boundPaise: null,
    actionsTaken: shared.actions,
    utilisation: shared.spentPaise / options.budgetPaise,
    capViolations: capped.violations,
    maxContactsToOneCustomer: capped.worst,
  };
}

function mandate(options: SpendOptions): UnsignedMandate {
  return {
    id: mandateId("mnd_bench"),
    merchantId: "bench",
    campaignId: `w${options.workers}`,
    budgetPaise: paise(options.budgetPaise),
    maxActionCostPaise: THREE_SEGMENTS,
    maxInFlight: options.maxInFlight,
    reservationTtlMs: 60_000,
    contactCap: { limit: options.contactCapLimit, windowMs: 7 * DAY },
    quietHours: { startMinute: 21 * 60, endMinute: 8 * 60, offsetMinutes: 330 },
    allowedActions: ["contact-sms"],
    validFrom: START - DAY,
    validUntil: START + 30 * DAY,
    killSwitch: false,
  };
}

function action(job: Job): ProposedAction {
  return {
    kind: "contact-sms",
    customer: job.customer,
    casualty: job.casualty,
    incident: null,
    estimatedCost: paise(ESTIMATE),
    expectedValue: rupees(1500),
    successProbability: 0.28,
    rationale: "transient decline; the rail has recovered",
  };
}

export interface TerminusArmResult extends ArmResult {
  readonly sizer: string;
  /** The smallest reservation taken during the run; the term the bound is evaluated at. */
  readonly minReservationPaise: number;
  /** Reservations held for actions that never reported a cost. Should be zero. */
  readonly orphans: number;
  readonly ledgerVerified: boolean;
  readonly refusalsByAxis: Readonly<Record<string, number>>;
}

/** The same workload, admitted through the kernel. */
export async function runTerminus(
  options: SpendOptions,
  makeSizer: (maxActionCostPaise: number) => Sizer,
): Promise<TerminusArmResult> {
  const jobs = buildJobs(options);
  const queue = new Queue(jobs);
  const clock = new ManualClock(START);
  const audit = new MemoryLedger();
  const sealed = sealMandate(mandate(options), SECRET);
  const sizer = makeSizer(sealed.maxActionCostPaise);

  const terminus = new Terminus({
    mandate: sealed,
    secret: SECRET,
    store: new MemoryStore({ sweepIntervalMs: 0 }),
    audit,
    actor: "bench",
    clock,
    sizer,
  });

  const contacts = new Map<CustomerRef, number>();
  let actions = 0;
  let minReservationPaise = Number.POSITIVE_INFINITY;

  const worker = async (): Promise<void> => {
    let job = queue.take();
    while (job !== null) {
      const admission = await terminus.admit({
        action: action(job),
        status: CLEAN_STATUS,
        attemptNo: 1,
      });

      if (!admission.allowed) {
        // The kernel says whether a refusal can ever clear, and a worker that ignores that is how a
        // harness accidentally measures itself. A budget or in-flight refusal with a retry time is
        // authority that is merely held by someone else, so hold this job and try again; dropping
        // it would leave the campaign under-spent and make the kernel look like it refuses work it
        // would happily have done. Without a retry time the money is genuinely gone, so stop. A
        // capped customer cannot be contacted at all right now, so that job is finished.
        if (admission.axis === "budget" && admission.retryAfterMs === null) return;
        if (admission.axis === "budget" || admission.axis === "concurrency") {
          await yieldTicks(1);
          continue;
        }
        job = queue.take();
        continue;
      }

      minReservationPaise = Math.min(minReservationPaise, admission.grant.reservedPaise);
      await yieldTicks(job.latencyTicks);
      await terminus.settle(admission.grant, paise(job.actualCostPaise), "delivered");

      actions++;
      contacts.set(job.customer, (contacts.get(job.customer) ?? 0) + 1);
      job = queue.take();
    }
  };

  await Promise.all(Array.from({ length: options.workers }, worker));

  const snapshot = await terminus.snapshot();
  const capped = tally(contacts, options.contactCapLimit);

  const smallest = Number.isFinite(minReservationPaise)
    ? minReservationPaise
    : sealed.maxActionCostPaise;

  return {
    arm: `terminus (${sizer.name})`,
    sizer: sizer.name,
    minReservationPaise: smallest,
    workers: options.workers,
    budgetPaise: options.budgetPaise,
    spentPaise: snapshot.settledPaise,
    overspendPaise: Math.max(0, snapshot.settledPaise - options.budgetPaise),
    boundPaise: overspendBoundPaise(options.maxInFlight, sealed.maxActionCostPaise, smallest),
    actionsTaken: actions,
    utilisation: snapshot.settledPaise / options.budgetPaise,
    capViolations: capped.violations,
    maxContactsToOneCustomer: capped.worst,
    orphans: snapshot.orphanCount,
    ledgerVerified: audit.verify().valid,
    refusalsByAxis: audit.countByBinding(),
  };
}

export const SIZERS: ReadonlyArray<readonly [string, (max: number) => Sizer]> = [
  ["worst-case", (max) => worstCaseSizer(max)],
  ["estimate", () => estimateSizer()],
  ["learned", (max) => learnedSizer({ holdCost: 1, overrunCost: 4, maxActionCostPaise: max })],
  [
    "predictive",
    (max) => predictiveSizer({ holdCost: 1, overrunCost: 4, maxActionCostPaise: max }),
  ],
];

export interface TailRow {
  readonly budgetPaise: number;
  readonly sizer: string;
  readonly actionsTaken: number;
  readonly spentPaise: number;
  readonly overspendPaise: number;
  /** Actions relative to reserving the worst case, at the same budget. */
  readonly liftOverWorstCase: number;
}

/**
 * Where an over-sized reservation actually costs something.
 *
 * On a lifetime budget it mostly does not: a reservation is *released* at settlement rather than
 * consumed, so over-reserving holds authority briefly and hands back whatever the action did not
 * use. The one place it bites is the tail — when the remaining budget is smaller than the worst-case
 * reservation but larger than what the action would really have cost, admission refuses work the
 * campaign could have afforded. That loss is bounded by `maxInFlight x (reservation - actual)`, so
 * it matters in proportion to how large the in-flight reservation total is against the budget.
 *
 * Sweeping the budget down toward `maxInFlight x maxActionCost` is therefore the test that can
 * actually falsify "learning the reservation earns its complexity". If the learner does not pull
 * ahead here, it does not pull ahead anywhere.
 */
export async function runTailSweep(
  options: SpendOptions,
  budgets: readonly number[],
): Promise<TailRow[]> {
  const rows: TailRow[] = [];

  for (const budgetPaise of budgets) {
    const cell = { ...options, budgetPaise };
    const baseline = await runTerminus(cell, (max) => worstCaseSizer(max));

    for (const [, makeSizer] of SIZERS) {
      const result = await runTerminus(cell, makeSizer);
      rows.push({
        budgetPaise,
        sizer: result.sizer,
        actionsTaken: result.actionsTaken,
        spentPaise: result.spentPaise,
        overspendPaise: result.overspendPaise,
        liftOverWorstCase:
          baseline.actionsTaken === 0
            ? 0
            : (result.actionsTaken - baseline.actionsTaken) / baseline.actionsTaken,
      });
    }
  }

  return rows;
}

/**
 * Budgets from comfortable down to comparable with the in-flight reservation total.
 *
 * At eight in flight and a three-rupee ceiling, the worst case holds twenty-four rupees at once, so
 * a thirty-rupee budget is where over-reservation should hurt most if it hurts at all.
 */
export const TAIL_BUDGETS = [rupees(30), rupees(60), rupees(125), rupees(250), rupees(500)];

export interface MixRow {
  readonly devanagariShare: number;
  readonly sizer: string;
  readonly minReservationPaise: number;
  readonly actionsTaken: number;
  readonly spentPaise: number;
  readonly overspendPaise: number;
  readonly liftOverWorstCase: number;
}

/**
 * The cost mixes the learner is supposed to win on.
 *
 * The critical fractile is the quantile the newsvendor optimum sits at: with an overrun priced at
 * four times a hold, that is the 80th percentile of realised cost. When more than a fifth of
 * messages cost three segments, the 80th percentile *is* three segments, so the learner's correct
 * answer is the worst case and it can only tie. It is on a long thin tail — a few expensive
 * messages among many cheap ones — that the optimum sits below the ceiling and there is anything
 * for the learner to find. Sweeping the mix across that boundary is what turns "does it earn its
 * place" into a question with an answer.
 */
export const COST_MIXES = [0.02, 0.05, 0.1, 0.2, 0.35, 0.6];

export async function runMixSweep(
  options: SpendOptions,
  shares: readonly number[],
): Promise<MixRow[]> {
  const rows: MixRow[] = [];

  for (const devanagariShare of shares) {
    const cell = { ...options, devanagariShare };
    const baseline = await runTerminus(cell, (max) => worstCaseSizer(max));

    for (const [, makeSizer] of SIZERS) {
      const result = await runTerminus(cell, makeSizer);
      rows.push({
        devanagariShare,
        sizer: result.sizer,
        minReservationPaise: result.minReservationPaise,
        actionsTaken: result.actionsTaken,
        spentPaise: result.spentPaise,
        overspendPaise: result.overspendPaise,
        liftOverWorstCase:
          baseline.actionsTaken === 0
            ? 0
            : (result.actionsTaken - baseline.actionsTaken) / baseline.actionsTaken,
      });
    }
  }

  return rows;
}

export interface SpendSweep {
  readonly options: SpendOptions;
  readonly workerCounts: readonly number[];
  readonly naive: readonly ArmResult[];
  readonly terminus: readonly TerminusArmResult[];
  readonly tail: readonly TailRow[];
  readonly mix: readonly MixRow[];
}

/**
 * The comparison, swept over worker count.
 *
 * Worker count is the independent variable because it is the one a deployment changes without
 * thinking about it. The naive arm's overspend grows with it; the kernel's does not, because the
 * only thing that multiplies the residual is the in-flight cap, which is a mandate field.
 */
export async function runSpendSweep(
  options: SpendOptions = DEFAULT_SPEND_OPTIONS,
  workerCounts: readonly number[] = [1, 2, 4, 8, 16, 32, 64],
  onProgress?: (done: number, total: number) => void,
): Promise<SpendSweep> {
  const naive: ArmResult[] = [];
  const terminus: TerminusArmResult[] = [];
  const total = workerCounts.length * (1 + SIZERS.length);
  let done = 0;

  for (const workers of workerCounts) {
    const cell = { ...options, workers };
    naive.push(await runNaive(cell));
    onProgress?.(++done, total);

    for (const [, makeSizer] of SIZERS) {
      terminus.push(await runTerminus(cell, makeSizer));
      onProgress?.(++done, total);
    }
  }

  const tail = await runTailSweep({ ...options, workers: 16 }, TAIL_BUDGETS);
  // Run the mix sweep at the tightest budget, where an over-sized reservation costs the most.
  const mix = await runMixSweep({ ...options, workers: 16, budgetPaise: rupees(60) }, COST_MIXES);
  return { options, workerCounts, naive, terminus, tail, mix };
}
