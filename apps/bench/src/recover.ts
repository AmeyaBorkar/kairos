import { DetectionEngine, type EngineConfig } from "@kairos/detect";
import {
  applyOutcome,
  type Casualty,
  type CasualtyId,
  inQuietHours,
  isContact,
  type Mandate,
  markRecovered,
  paise,
  quietHoursEndAt,
  type RecoveryAttempt,
  type Slice,
  sliceKey,
} from "@kairos/domain";
import { MemoryLedger } from "@kairos/ledger";
import {
  brierScore,
  type Classification,
  calibrationCurve,
  casualtyFrom,
  DEFAULT_RECOVERY_CONFIG,
  DEFAULT_SCHEDULE_CONFIG,
  type ExecuteRequest,
  type ExecuteResult,
  type Executor,
  expectedCalibrationError,
  MemoryCasualtyStore,
  nextBalanceLikelyMoment,
  type Prediction,
  type RailGauge,
  RecoverWorker,
  type RecoveryConfig,
  RecoveryModel,
  type ScheduleConfig,
  skillScore,
} from "@kairos/recover";
import {
  type CasualtyClass,
  type ContactChannel,
  failureRateAt,
  generateLabelled,
  type LabelledAttempt,
  RecoveryWorld,
  type SimulatorConfig,
  type SliceProfile,
} from "@kairos/simulator";
import { ManualClock, Terminus } from "@kairos/terminus";
import { MemoryStore } from "throttlekit";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** One arm's result, in the only units a merchant cares about. */
export interface ArmResult {
  readonly name: string;
  readonly casualties: number;
  readonly lostPaise: number;
  /** Recovered by anything at all: our action, or the customer coming back regardless. */
  readonly recovered: number;
  readonly recoveredPaise: number;
  /**
   * Recovered *because of* this arm.
   *
   * The difference between this and {@link ArmResult.recoveredPaise} is the number every dunning
   * dashboard reports and no dunning dashboard earns.
   */
  readonly incrementalPaise: number;
  readonly spentPaise: number;
  readonly messages: number;
  readonly retries: number;
  readonly optOuts: number;
  /** Actions that landed on somebody who was coming back anyway. Money spent for nothing. */
  readonly wastedActions: number;
  readonly wastedPaise: number;
  /** Refusals by binding axis, from the ledger. */
  readonly refusals: Readonly<Record<string, number>>;
}

/** One point on the spontaneous-window sweep. */
export interface WindowRow {
  readonly windowMs: number;
  readonly incrementalPaise: number;
  readonly messages: number;
  readonly retries: number;
  readonly optOuts: number;
  readonly spentPaise: number;
  readonly wastedActions: number;
}

export interface RecoveryScorecard {
  readonly arms: readonly ArmResult[];
  readonly windowSweep: readonly WindowRow[];
  /** Kairos's own held-out casualties: the internal control that answers "compared to what?". */
  readonly holdout: { readonly casualties: number; readonly recoveredPaise: number };
  readonly calibration: {
    readonly bins: ReturnType<typeof calibrationCurve>;
    readonly expectedError: number;
    readonly brier: number;
    readonly skill: number;
    readonly predictions: number;
  };
  /** How much of the loss was even addressable without the customer being present. */
  readonly autonomousShare: number;
  readonly classMix: Readonly<Record<string, number>>;
}

export interface RecoveryRunConfig {
  readonly simulator: SimulatorConfig;
  readonly detector: EngineConfig;
  readonly mandate: Mandate;
  readonly secret: string;
  readonly recovery?: RecoveryConfig;
  /** How long to keep working the queue after the traffic stops. */
  readonly tailMs?: number;
  /**
   * Values of the spontaneous window to sweep, in milliseconds.
   *
   * The one parameter in the schedule that is a genuine bet rather than a constraint: waiting saves
   * messages on customers who were coming back anyway, and costs the recoveries that only happened
   * because somebody was asked at a better moment than they would have chosen. Which effect wins is
   * not knowable from first principles, so it is measured.
   */
  readonly spontaneousWindows?: readonly number[];
}

/**
 * A rail gauge built from the detector rather than from the truth.
 *
 * The distinction is the entire measurement. Scheduling on ground truth would show what recovery
 * looks like for a system that already knows when rails break, which is not a system anybody has.
 * Kairos schedules on what its own detector believes, including when that is late or wrong, and the
 * result is the honest one.
 */
class DetectorGauge implements RailGauge {
  readonly #open = new Set<string>();
  readonly #recoveredAt = new Map<string, number>();

  observe(engine: DetectionEngine, at: number): void {
    const open = new Set(engine.openIncidents().map((i) => sliceKey(i.slice)));
    for (const key of this.#open) {
      if (!open.has(key)) this.#recoveredAt.set(key, at);
    }
    this.#open.clear();
    for (const key of open) this.#open.add(key);
  }

  isDegraded(slice: Slice): boolean {
    if (this.#open.has(sliceKey(slice))) return true;
    // An incident opened at the issuer covers every app beneath it, which is the altitude the
    // detector reports at and therefore the altitude a casualty has to be matched against.
    for (const key of this.#open) {
      const parts = key.split("|");
      if (parts[0] !== slice.method) continue;
      if (parts[1] !== "" && parts[1] !== slice.issuer) continue;
      if (parts[2] !== "" && parts[2] !== slice.instrument) continue;
      return true;
    }
    return false;
  }

  recoveredAt(slice: Slice): number | null {
    return this.#recoveredAt.get(sliceKey(slice)) ?? null;
  }
}

/** Ground truth about one casualty, kept beside the run and never visible to the system. */
interface Truth {
  readonly casualty: Casualty;
  readonly profile: SliceProfile;
  readonly klass: CasualtyClass;
  /** Would this money have come back with nobody doing anything at all? */
  readonly wouldHaveRecovered: boolean;
  /**
   * When it would have come back, if it would have.
   *
   * Used to close the casualty at that moment, which is what a `payment.captured` webhook does in
   * production. Leaving it out was a real defect in an earlier version of this harness: without it
   * the queue kept chasing customers who had already paid, so waiting before spending saved no
   * messages at all and the whole spontaneous-window question was unmeasurable.
   */
  readonly spontaneousAt: number | null;
}

/**
 * The executor the harness runs every arm through.
 *
 * Consults the simulated world for what actually happens, and records both the outcome and whether
 * the customer was coming back regardless. Every arm shares one world and one seed, so a casualty's
 * fate under no intervention is the same fact in all of them.
 */
class SimulatedExecutor implements Executor {
  readonly acted: {
    at: number;
    kind: string;
    recovered: boolean;
    wasted: boolean;
    cost: number;
  }[] = [];
  #optOuts = 0;

  constructor(
    private readonly world: RecoveryWorld,
    private readonly simulator: SimulatorConfig,
    private readonly profiles: ReadonlyMap<string, SliceProfile>,
    private readonly classOf: (id: CasualtyId) => CasualtyClass,
  ) {}

  get optOuts(): number {
    return this.#optOuts;
  }

  execute(request: ExecuteRequest): Promise<ExecuteResult> {
    const { casualty, grant, at } = request;
    const context = {
      casualtyId: casualty.id,
      casualtyClass: this.classOf(casualty.id),
      occurredAt: casualty.occurredAt,
      at,
      railHealthy: this.#healthy(casualty, at),
      pastPayday: pastPayday(casualty.occurredAt, at),
      ordinal: casualty.attempts.length,
      guided: guidedFor(request.classification),
    };

    const kind = grant.action.kind;
    const outcome =
      kind === "retry"
        ? this.world.retry(context)
        : this.world.contact(context, kind as ContactChannel);

    if (outcome.optedOut) this.#optOuts++;

    // The cost the executor would really have paid. SMS is the only per-segment channel; the
    // others bill per message, and a message that reached nobody costs nothing.
    const price = DEFAULT_RECOVERY_CONFIG.prices.find((p) => p.kind === kind)?.sendPaise ?? 0;
    const cost = outcome.delivered ? price : 0;

    this.acted.push({
      at,
      kind,
      recovered: outcome.recovered,
      wasted: outcome.recovered && outcome.wasAlreadyComing,
      cost,
    });

    return Promise.resolve({
      outcome: outcome.recovered
        ? "recovered"
        : kind === "retry"
          ? outcome.hardDecline
            ? "declined-hard"
            : "declined-soft"
          : outcome.delivered
            ? "delivered"
            : "undeliverable",
      costPaise: cost,
      externalRef: null,
      optedOut: outcome.optedOut,
    });
  }

  #healthy(casualty: Casualty, at: number): boolean {
    const profile = this.profiles.get(sliceKey(casualty.slice));
    if (profile === undefined) return true;
    return failureRateAt(this.simulator, profile, at) <= profile.baseFailureRate + 1e-9;
  }
}

/** Whether a balance-likely date has passed between the loss and now. Ground truth for `timed`. */
function pastPayday(occurredAt: number, at: number): boolean {
  return nextBalanceLikelyMoment(occurredAt, DEFAULT_SCHEDULE_CONFIG) <= at;
}

/** Whether the copy for this class tells the customer what to fix. Mirrors the template table. */
function guidedFor(classification: Classification): boolean {
  return (
    classification.recoverability === "customer-action" ||
    classification.recoverability === "transient"
  );
}

/**
 * Run the whole recovery arm against simulated traffic, four ways.
 *
 * The four arms share one world, one seed and one set of casualties, so every difference between
 * them is the policy and nothing else. Time advances in ticks: finely while traffic is arriving so
 * the detector sees it as it would in production, then coarsely for the tail, because a `timed`
 * casualty aims at a salary date a fortnight out and a ladder rung lands three days later.
 */
export async function runRecovery(config: RecoveryRunConfig): Promise<RecoveryScorecard> {
  const world = new RecoveryWorld(config.simulator.seed);
  const profiles = new Map(config.simulator.profiles.map((p) => [sliceKey(p.slice), p]));

  const labelled = [...generateLabelled(config.simulator)];
  const truths = buildTruths(labelled, world, config.simulator, profiles);
  const classOf = new Map(truths.map((t) => [t.casualty.id, t.klass]));

  const startAt = config.simulator.startAt;
  const endAt = startAt + config.simulator.durationMs;
  const tailMs = config.tailMs ?? 40 * DAY;

  const arms: ArmResult[] = [];

  arms.push(doNothing(truths));

  arms.push(
    await runLadder({
      name: "chronos ladder (+1h, +24h, +72h)",
      offsets: [HOUR, DAY, 3 * DAY],
      truths,
      world,
      config,
      profiles,
      endAt: endAt + tailMs,
    }),
  );

  arms.push(
    await runLadder({
      name: "message everyone, immediately",
      offsets: [0],
      truths,
      world,
      config,
      profiles,
      endAt: endAt + tailMs,
    }),
  );

  const kairos = await runKairos({
    truths,
    labelled,
    world,
    config,
    profiles,
    classOf,
    startAt,
    endAt,
    tailMs,
    schedule: DEFAULT_SCHEDULE_CONFIG,
  });
  arms.push(kairos.result);

  const windowSweep: WindowRow[] = [];
  for (const windowMs of config.spontaneousWindows ?? []) {
    const variant =
      windowMs === DEFAULT_SCHEDULE_CONFIG.spontaneousWindowMs
        ? kairos
        : await runKairos({
            truths,
            labelled,
            world,
            config,
            profiles,
            classOf,
            startAt,
            endAt,
            tailMs,
            schedule: { ...DEFAULT_SCHEDULE_CONFIG, spontaneousWindowMs: windowMs },
          });
    windowSweep.push({
      windowMs,
      incrementalPaise: variant.result.incrementalPaise,
      messages: variant.result.messages,
      retries: variant.result.retries,
      optOuts: variant.result.optOuts,
      spentPaise: variant.result.spentPaise,
      wastedActions: variant.result.wastedActions,
    });
  }

  const autonomous = truths.filter((t) => t.casualty.retry === "autonomous");
  const classMix: Record<string, number> = {};
  for (const t of truths) classMix[t.klass] = (classMix[t.klass] ?? 0) + 1;

  return {
    arms,
    windowSweep,
    holdout: kairos.holdout,
    calibration: kairos.calibration,
    autonomousShare: truths.length === 0 ? 0 : autonomous.length / truths.length,
    classMix,
  };
}

function buildTruths(
  labelled: readonly LabelledAttempt[],
  world: RecoveryWorld,
  simulator: SimulatorConfig,
  profiles: ReadonlyMap<string, SliceProfile>,
): readonly Truth[] {
  const truths: Truth[] = [];

  for (const item of labelled) {
    const casualty = casualtyFrom(item.attempt, item.retry);
    if (casualty === null) continue;

    const klass = casualty.status.recoverability as CasualtyClass;
    const { spontaneousAt } = world.counterfactual(casualty.id, klass, casualty.occurredAt);

    // The control outcome: they come back on their own, and the payment goes through *at that
    // moment* rather than at one we chose. Evaluating it at our timing would credit the control
    // arm with our scheduling and erase the effect being measured.
    let wouldHaveRecovered = false;
    if (spontaneousAt !== null) {
      const profile = profiles.get(sliceKey(casualty.slice));
      const railHealthy =
        profile === undefined ||
        failureRateAt(simulator, profile, spontaneousAt) <= profile.baseFailureRate + 1e-9;
      wouldHaveRecovered = world.wouldSucceed({
        casualtyId: casualty.id,
        casualtyClass: klass,
        occurredAt: casualty.occurredAt,
        at: spontaneousAt,
        railHealthy,
        pastPayday: pastPayday(casualty.occurredAt, spontaneousAt),
        ordinal: 0,
        guided: false,
      });
    }

    const profile = profiles.get(sliceKey(casualty.slice));
    if (profile === undefined) continue;
    truths.push({
      casualty,
      profile,
      klass,
      wouldHaveRecovered,
      spontaneousAt: wouldHaveRecovered ? spontaneousAt : null,
    });
  }

  return truths;
}

/** The baseline that spends nothing: whatever comes back, comes back. */
function doNothing(truths: readonly Truth[]): ArmResult {
  const recovered = truths.filter((t) => t.wouldHaveRecovered);
  return {
    name: "do nothing",
    casualties: truths.length,
    lostPaise: truths.reduce((sum, t) => sum + t.casualty.amount, 0),
    recovered: recovered.length,
    recoveredPaise: recovered.reduce((sum, t) => sum + t.casualty.amount, 0),
    incrementalPaise: 0,
    spentPaise: 0,
    messages: 0,
    retries: 0,
    optOuts: 0,
    wastedActions: 0,
    wastedPaise: 0,
    refusals: {},
  };
}

interface LadderRun {
  readonly name: string;
  readonly offsets: readonly number[];
  readonly truths: readonly Truth[];
  readonly world: RecoveryWorld;
  readonly config: RecoveryRunConfig;
  readonly profiles: ReadonlyMap<string, SliceProfile>;
  readonly endAt: number;
}

/**
 * A dunning system that schedules on the clock and targets nobody.
 *
 * Every casualty gets a message at every offset, in order, regardless of what went wrong or whether
 * it could possibly help. It is still governed by the same Terminus mandate as Kairos — same
 * budget, same contact cap, same quiet hours — because the comparison worth making is between
 * *policies*, not between one system with bounds and one without.
 */
async function runLadder(run: LadderRun): Promise<ArmResult> {
  const ledger = new MemoryLedger();
  const clock = new ManualClock(run.config.simulator.startAt);
  const terminus = new Terminus({
    mandate: run.config.mandate,
    secret: run.config.secret,
    store: new MemoryStore(),
    audit: ledger,
    actor: "bench/baseline",
    clock,
  });

  const classOf = new Map(run.truths.map((t) => [t.casualty.id, t.klass]));
  const executor = new SimulatedExecutor(
    run.world,
    run.config.simulator,
    run.profiles,
    (id) => classOf.get(id) ?? "unknown",
  );

  const recoveredIds = new Set<CasualtyId>();
  let spent = 0;

  // One pass per rung, in time order, so the contact cap binds the way it would in production.
  const events: { at: number; truth: Truth; rung: number }[] = [];
  for (const truth of run.truths) {
    for (const [rung, offset] of run.offsets.entries()) {
      const at = truth.casualty.occurredAt + offset;
      if (at <= run.endAt) events.push({ at, truth, rung });
    }
  }
  events.sort((a, b) => a.at - b.at);

  // A naive dunning system has not classified anything, so its casualties must not carry the
  // classification Kairos produced. Leaving it in would hand the baseline two things it did not
  // earn: Terminus's `dead-class` stopping rule, and copy that names the specific problem.
  const states = new Map<CasualtyId, Casualty>(
    run.truths.map((t) => [
      t.casualty.id,
      { ...t.casualty, status: { ...t.casualty.status, recoverability: "unknown" as const } },
    ]),
  );
  const generic: Classification = {
    recoverability: "unknown",
    rule: "fixed-ladder",
    source: "default",
    confidence: 1,
  };

  const quietHours = run.config.mandate.quietHours;

  for (const event of events) {
    const casualty = states.get(event.truth.casualty.id);
    if (casualty === undefined || casualty.status.recovered || casualty.status.optedOut) continue;
    // The same `payment.captured` closure the treated arm gets. A baseline that kept messaging
    // customers who had already paid would be worse than any real dunning tool.
    const returnedAt = event.truth.spontaneousAt;
    if (returnedAt !== null && returnedAt <= event.at) {
      states.set(casualty.id, markRecovered(casualty));
      continue;
    }

    // Any real dunning tool defers a message that lands in the middle of the night rather than
    // dropping it. Letting the baseline lose those would make it weaker than the thing it is meant
    // to represent, and every comparison against it correspondingly generous.
    const at =
      quietHours !== null && inQuietHours(quietHours, event.at)
        ? quietHoursEndAt(quietHours, event.at)
        : event.at;
    if (at > run.endAt) continue;

    clock.set(at);

    const admission = await terminus.admit({
      action: {
        kind: "contact-sms",
        customer: casualty.customer,
        casualty: casualty.id,
        incident: null,
        estimatedCost: paise(20),
        expectedValue: paise(Math.round(casualty.amount * DEFAULT_RECOVERY_CONFIG.margin)),
        // A naive ladder does not have a probability model, so it assumes the population rate —
        // which is exactly what "no targeting" means, and is why its expected-value gate never
        // declines anything.
        successProbability: 0.15,
        rationale: `fixed ladder rung ${event.rung + 1}`,
      },
      status: casualty.status,
      attemptNo: casualty.attempts.length,
    });

    if (!admission.allowed) continue;

    const result = await executor.execute({
      grant: admission.grant,
      casualty,
      classification: generic,
      firstName: null,
      token: null,
      at,
    });

    await terminus.settle(admission.grant, paise(result.costPaise), result.outcome, null);
    spent += result.costPaise;

    let updated = applyOutcome(casualty, attemptOf(admission.grant.action.kind, at, result));
    if (result.optedOut) updated = { ...updated, status: { ...updated.status, optedOut: true } };
    states.set(casualty.id, updated);
    if (result.outcome === "recovered") recoveredIds.add(casualty.id);
  }

  return summarise(run.name, run.truths, recoveredIds, executor, spent, ledger);
}

interface KairosRun {
  readonly truths: readonly Truth[];
  readonly labelled: readonly LabelledAttempt[];
  readonly world: RecoveryWorld;
  readonly config: RecoveryRunConfig;
  readonly profiles: ReadonlyMap<string, SliceProfile>;
  readonly classOf: ReadonlyMap<CasualtyId, CasualtyClass>;
  readonly startAt: number;
  readonly endAt: number;
  readonly tailMs: number;
  readonly schedule: ScheduleConfig;
}

/**
 * Kairos, wired the way it runs in production.
 *
 * The detector consumes the same traffic the casualties come from, and the worker schedules on what
 * the detector believes — not on the ground truth the harness holds. Anything else would measure a
 * system that already knows when rails break.
 */
async function runKairos(run: KairosRun): Promise<{
  readonly result: ArmResult;
  readonly holdout: { casualties: number; recoveredPaise: number };
  readonly calibration: RecoveryScorecard["calibration"];
}> {
  const ledger = new MemoryLedger();
  const clock = new ManualClock(run.startAt);
  const terminus = new Terminus({
    mandate: run.config.mandate,
    secret: run.config.secret,
    store: new MemoryStore(),
    audit: ledger,
    actor: "bench/kairos",
    clock,
  });

  const engine = new DetectionEngine(run.config.detector);
  const gauge = new DetectorGauge();
  const store = new MemoryCasualtyStore();
  const model = new RecoveryModel();
  const executor = new SimulatedExecutor(
    run.world,
    run.config.simulator,
    run.profiles,
    (id) => run.classOf.get(id) ?? "unknown",
  );

  const predictions: Prediction[] = [];
  const recording: Executor = {
    execute: async (request) => {
      predictions.push({
        predicted: request.grant.action.successProbability,
        recovered: false,
      });
      const result = await executor.execute(request);
      const last = predictions.length - 1;
      predictions[last] = {
        predicted: request.grant.action.successProbability,
        recovered: result.outcome === "recovered",
      };
      return result;
    },
  };

  const worker = new RecoverWorker({
    terminus,
    store,
    directory: { lookup: () => Promise.resolve({ firstName: "Rohit", token: "tok" }) },
    gauge,
    model,
    executor: recording,
    clock,
    batchSize: 8192,
    scheduleConfig: run.schedule,
    ...(run.config.recovery === undefined ? {} : { config: run.config.recovery }),
  });

  const byId = new Map(run.truths.map((t) => [t.casualty.id, t]));
  const openAt = new Map<number, Truth[]>();
  for (const truth of run.truths) {
    const bucket = Math.floor(truth.casualty.occurredAt / MINUTE);
    const list = openAt.get(bucket) ?? [];
    list.push(truth);
    openAt.set(bucket, list);
  }

  // Customers who come back unaided pay, and the payment produces a `payment.captured` webhook that
  // closes the casualty. Modelling that is not decoration: without it the queue keeps chasing
  // people who have already paid, which is both a message a real system would not send and the
  // reason the spontaneous window would appear to save nothing.
  const returning = [...run.truths]
    .filter((t): t is Truth & { spontaneousAt: number } => t.spontaneousAt !== null)
    .sort((a, b) => a.spontaneousAt - b.spontaneousAt);
  let returned = 0;

  const closeReturners = async (at: number): Promise<void> => {
    while (returned < returning.length) {
      const truth = returning[returned];
      if (truth === undefined || truth.spontaneousAt > at) break;
      returned++;
      const held = await store.get(truth.casualty.id);
      if (held !== null && !held.status.recovered) await store.save(markRecovered(held), null);
    }
  };

  // Fine ticks while traffic arrives; coarse ones afterwards. A minute is short enough that the
  // detector sees the stream the way it would in production, and a tail measured in weeks at that
  // resolution would be sixty thousand passes over an empty queue.
  let index = 0;
  for (let at = run.startAt; at <= run.endAt; at += MINUTE) {
    while (index < run.labelled.length && (run.labelled[index]?.attempt.at ?? 0) < at + MINUTE) {
      const item = run.labelled[index];
      index++;
      if (item !== undefined) engine.observe(item.attempt);
    }
    gauge.observe(engine, at);

    for (const truth of openAt.get(Math.floor(at / MINUTE)) ?? []) {
      await store.save(truth.casualty, truth.casualty.occurredAt);
    }

    await closeReturners(at);
    clock.set(at);
    await worker.drain();
  }

  for (let at = run.endAt; at <= run.endAt + run.tailMs; at += 30 * MINUTE) {
    gauge.observe(engine, at);
    await closeReturners(at);
    clock.set(at);
    await worker.drain();
  }

  const recoveredIds = new Set<CasualtyId>();
  let holdoutCasualties = 0;
  let holdoutRecoveredPaise = 0;

  for (const casualty of store.all()) {
    if (casualty.status.recovered) recoveredIds.add(casualty.id);
    if (casualty.attempts.length === 0) {
      const truth = byId.get(casualty.id);
      if (truth !== undefined) {
        holdoutCasualties++;
        if (truth.wouldHaveRecovered) holdoutRecoveredPaise += truth.casualty.amount;
      }
    }
  }

  const spent = executor.acted.reduce((sum, a) => sum + a.cost, 0);
  const bins = calibrationCurve(predictions);

  return {
    result: summarise("kairos", run.truths, recoveredIds, executor, spent, ledger),
    holdout: { casualties: holdoutCasualties, recoveredPaise: holdoutRecoveredPaise },
    calibration: {
      bins,
      expectedError: expectedCalibrationError(bins),
      brier: brierScore(predictions),
      skill: skillScore(predictions),
      predictions: predictions.length,
    },
  };
}

function attemptOf(kind: string, at: number, result: ExecuteResult): RecoveryAttempt {
  return {
    kind: kind as RecoveryAttempt["kind"],
    at,
    outcome: result.outcome,
    costPaise: paise(result.costPaise),
    externalRef: null,
  };
}

/**
 * Turn an arm's raw events into the numbers a merchant reads.
 *
 * The important line is `incrementalPaise`. An arm's recovered total includes every customer who
 * would have come back regardless, and subtracting the do-nothing baseline is the only way to say
 * what the arm was worth. Reporting the gross figure is what makes dunning tools look good.
 */
function summarise(
  name: string,
  truths: readonly Truth[],
  recoveredByUs: ReadonlySet<CasualtyId>,
  executor: SimulatedExecutor,
  spentPaise: number,
  ledger: MemoryLedger,
): ArmResult {
  let recovered = 0;
  let recoveredPaise = 0;
  let baselinePaise = 0;

  for (const truth of truths) {
    const came = recoveredByUs.has(truth.casualty.id) || truth.wouldHaveRecovered;
    if (came) {
      recovered++;
      recoveredPaise += truth.casualty.amount;
    }
    if (truth.wouldHaveRecovered) baselinePaise += truth.casualty.amount;
  }

  const wasted = executor.acted.filter((a) => a.wasted);

  return {
    name,
    casualties: truths.length,
    lostPaise: truths.reduce((sum, t) => sum + t.casualty.amount, 0),
    recovered,
    recoveredPaise,
    incrementalPaise: recoveredPaise - baselinePaise,
    spentPaise,
    messages: executor.acted.filter((a) => isContact(a.kind as RecoveryAttempt["kind"])).length,
    retries: executor.acted.filter((a) => a.kind === "retry").length,
    optOuts: executor.optOuts,
    wastedActions: wasted.length,
    wastedPaise: wasted.reduce((sum, a) => sum + a.cost, 0),
    refusals: ledger.countByBinding(),
  };
}
