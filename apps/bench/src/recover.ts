import { DetectionEngine, type EngineConfig } from "@kairos/detect";
import {
  applyOutcome,
  type Casualty,
  type CasualtyId,
  inQuietHours,
  isContact,
  type Language,
  type Mandate,
  markRecovered,
  paise,
  quietHoursEndAt,
  type RecoveryAttempt,
  type Slice,
  sliceKey,
} from "@kairos/domain";
import { MemoryLedger } from "@kairos/ledger";
import { templateCopy } from "@kairos/razorpay";
import { type Copy, type CopySource, libraryCopy } from "@kairos/reason";
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
  type ActionContext,
  type CasualtyClass,
  type ContactChannel,
  DEFAULT_RECOVERY_WORLD,
  failureRateAt,
  generateLabelled,
  INDIA_LANGUAGE_MIX,
  type LabelledAttempt,
  languageOf,
  type MessageQuality,
  RecoveryWorld,
  realisedMix,
  type SimulatorConfig,
  type SliceProfile,
  scoreMessage,
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
  /**
   * Whether the audit chain this arm wrote still hashes end to end.
   *
   * The spend and prevention harnesses have always checked this; the recovery one asserted it in
   * prose and never in code. A chain nobody verifies is a log.
   */
  readonly ledgerVerified: boolean;
  readonly auditRecords: number;
  /**
   * What this arm's copy actually was, rather than what it was configured to be.
   *
   * `fromLibrary` is the share of sent messages a generated variant wrote; `legible` is the share
   * that arrived in a script the recipient reads. Both are reported for every arm, including the
   * ones with no library at all — a baseline's legibility rate is the size of the problem the
   * library exists to solve, and quoting it next to the treated arm is what stops the headline from
   * being a claim about copy when it is really a claim about coverage.
   */
  readonly copy: {
    readonly source: string;
    readonly sent: number;
    readonly fromLibrary: number;
    readonly legible: number;
  };
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

/**
 * One point on the legibility sweep: what generated copy is worth if a message in the wrong script
 * loses this much of its pull.
 *
 * The whole row exists because `gainPaise` at the default penalty is not a finding, it is a
 * consequence of a number somebody picked. Publishing the curve turns "we think this is worth ₹X"
 * into "here is the assumption, and here is what X is for every value of it you might believe" —
 * which is the difference between a measurement and an advertisement.
 */
export interface LegibilityRow {
  readonly penalty: number;
  /** How many seeds this row averages. One seed is not a measurement of this quantity. */
  readonly seeds: number;
  readonly templatePaise: number;
  readonly generatedPaise: number;
  /** Mean gain across seeds. */
  readonly gainPaise: number;
  /** The best and worst seed, so a reader can see whether the row is separable from its neighbour. */
  readonly gainLowPaise: number;
  readonly gainHighPaise: number;
}

export interface RecoveryScorecard {
  readonly arms: readonly ArmResult[];
  readonly windowSweep: readonly WindowRow[];
  readonly legibilitySweep: readonly LegibilityRow[];
  /**
   * The language mix the run actually contained, not the one it was configured with.
   *
   * A few hundred customers drawn from a stipulated distribution do not reproduce it, and the value
   * of multilingual copy is roughly proportional to the non-English share — so the realised mix is
   * part of the result rather than a footnote about the setup.
   */
  readonly languageMix: Readonly<Record<Language, number>>;
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
  /**
   * What the modelled customers read. Defaults to {@link INDIA_LANGUAGE_MIX}.
   *
   * Every number in it is a stipulation and the measured value of the copy library moves with the
   * non-English share, so it is a parameter of the run rather than a fact about the world. Set it
   * to `ENGLISH_ONLY` to reproduce the population every benchmark before this one assumed.
   */
  readonly languageMix?: Readonly<Record<Language, number>>;
  /**
   * The generated copy library, for the arm that uses one. `null` runs template-only.
   *
   * Passed in rather than read from disk here, so the benchmark has no opinion about where a
   * library lives and a test can hand it three variants instead of four hundred.
   */
  readonly library?: Copy | null;
  /**
   * Legibility penalties to sweep, each producing a fresh pair of Kairos arms.
   *
   * The direct answer to open question 18. The gap between generated and template copy is
   * proportional to how much a message in the wrong script actually loses, and nobody has measured
   * that — so rather than publish one number derived from a guess, the harness publishes the whole
   * curve and lets a reader find their own belief on it. At `1.0` the language work is worth
   * nothing by construction, and the sweep says so out loud.
   */
  readonly legibilitySweep?: readonly number[];
  /**
   * Seeds to average each legibility row over. Defaults to the simulator's own, which is one seed
   * and therefore not enough — see the note at the sweep itself.
   */
  readonly legibilitySeeds?: readonly number[];
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
 * Attach a scored message to an action context.
 *
 * Split out so the two fields the scorer produces travel together and cannot be attached one
 * without the other — passing `guidance` while leaving `legible` at its retry default would score
 * an unreadable message as if the reader had understood it, and would do so silently.
 */
function withQuality(context: ActionContext, quality: MessageQuality): ActionContext {
  return { ...context, guidance: quality.guidance, legible: quality.legible };
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

  /**
   * What the copy did, counted.
   *
   * Reported per arm rather than aggregated, because the two numbers answer the question a reader
   * asks first — *did the treatment actually reach anybody?* An arm whose library missed half its
   * segments quietly falls back to English templates and looks like a modest win over the baseline,
   * when what it really is is a half-applied treatment. `fromLibrary` makes that visible instead of
   * averaging it away.
   */
  readonly copyStats = { sent: 0, fromLibrary: 0, legible: 0 };

  constructor(
    private readonly world: RecoveryWorld,
    private readonly simulator: SimulatorConfig,
    private readonly profiles: ReadonlyMap<string, SliceProfile>,
    private readonly classOf: (id: CasualtyId) => CasualtyClass,
    /** Where this arm's words come from. The only thing that differs between the two Kairos arms. */
    private readonly copy: CopySource,
  ) {}

  get optOuts(): number {
    return this.#optOuts;
  }

  get copySource(): string {
    return this.copy.name;
  }

  /**
   * Build the message this action would send, and score it.
   *
   * Composed through this arm's {@link CopySource}, exactly as the recovery worker would compose it
   * — so what the world judges is the text a customer would really receive, greeting and bank name
   * and all. Copy scored with its holes still in would be credited for a bank name it never
   * printed.
   *
   * The expectation is built from the customer's *own* language, whichever source wrote the words.
   * That is what makes the comparison fair in the only direction that matters: the baseline is not
   * handicapped, it is scored against the population that actually exists. An English template
   * reaching an English reader scores exactly what it always did; the same template reaching a
   * Tamil reader is marked illegible, because it is.
   */
  #qualityFor(request: ExecuteRequest, channel: ContactChannel): MessageQuality {
    const { casualty } = request;
    const institution = institutionName(casualty.slice.issuer);
    const selected = this.copy.select({
      recoverability: request.classification.recoverability,
      method: casualty.slice.method,
      language: request.language,
      channel,
      pick: request.grant.id,
      variables: {
        firstName: null,
        amount: casualty.amount,
        link: BENCH_LINK,
        institution,
      },
    });

    const quality = scoreMessage(selected.text, {
      language: request.language,
      institution,
      method: casualty.slice.method,
      channel,
    });

    this.copyStats.sent++;
    if (selected.variantId !== null) this.copyStats.fromLibrary++;
    if (quality.legible) this.copyStats.legible++;

    return quality;
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
      guidance: 0,
      // A retry sends no message, and a message nobody sent cannot be unreadable. `true` is the
      // neutral value here — it leaves the response rate unmultiplied — not a claim that some
      // imaginary text was legible.
      legible: true,
    };

    const kind = grant.action.kind;
    // Compose before acting, and score what was composed. The executor used to price a channel
    // without ever building the message, and the world was handed a boolean the *benchmark* set
    // from the failure class — so an arm could have claimed better copy by passing `true`. Now every
    // arm's text goes through the same scorer, which has no argument for who wrote it.
    const outcome =
      kind === "retry"
        ? this.world.retry(context)
        : this.world.contact(
            withQuality(context, this.#qualityFor(request, kind as ContactChannel)),
            kind as ContactChannel,
          );

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
/** A stand-in for the single-use URL the worker would mint. Same length as a real one. */
const BENCH_LINK = "https://rzp.io/i/aB3xQ";

/** What a message calls an issuer. The adapter does this properly; a benchmark can uppercase. */
function institutionName(issuer: string | null): string | null {
  return issuer === null ? null : issuer.toUpperCase();
}

function pastPayday(occurredAt: number, at: number): boolean {
  return nextBalanceLikelyMoment(occurredAt, DEFAULT_SCHEDULE_CONFIG) <= at;
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

  const languageMix = config.languageMix ?? INDIA_LANGUAGE_MIX;
  const library = config.library ?? null;

  // Every arm below the last one writes the hand-written English templates, because that is what
  // every arm in this benchmark has always written and what the system actually shipped. The last
  // arm differs in exactly one input.
  const templates = templateCopy;
  const generated = library === null ? null : libraryCopy(library, templates);

  const arms: ArmResult[] = [];

  arms.push(doNothing(truths));

  arms.push(
    await runLadder({
      name: "chronos ladder (+1h, +24h, +72h)",
      offsets: [HOUR, DAY, 3 * DAY],
      copy: templates,
      languageMix,
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
      copy: templates,
      languageMix,
      truths,
      world,
      config,
      profiles,
      endAt: endAt + tailMs,
    }),
  );

  const kairos = await runKairos({
    name: "kairos + template copy",
    copy: templates,
    languageMix,
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

  // The fifth arm, and the only reason the copy library is worth its generation cost. Identical to
  // the fourth in scheduling, expected-value gate, seed, customers and world — the *single* thing
  // that differs is where the words come from. Any gap between them is attributable to the copy
  // and to nothing else, which is a claim this harness can make precisely because everything else
  // is shared by construction rather than by care.
  const generatedArm =
    generated === null
      ? null
      : await runKairos({
          name: "kairos + generated copy",
          copy: generated,
          languageMix,
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
  if (generatedArm !== null) arms.push(generatedArm.result);

  const windowSweep: WindowRow[] = [];
  for (const windowMs of config.spontaneousWindows ?? []) {
    const variant =
      windowMs === DEFAULT_SCHEDULE_CONFIG.spontaneousWindowMs
        ? kairos
        : await runKairos({
            name: `kairos (window ${windowMs}ms)`,
            copy: templates,
            languageMix,
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

  // What the language work is worth, as a function of the one number nobody measured. Both arms are
  // re-run at each penalty against a world configured with it, because the penalty is a property of
  // the world rather than of the copy — running one arm and rescaling would assume the very linear
  // relationship the sweep exists to check.
  const legibilitySweep: LegibilityRow[] = [];
  // There is nothing to sweep without a library: the curve is the *gap* between two arms, and with
  // one arm it would be a flat line at zero dressed up as a finding.
  //
  // Swept across several seeds rather than one, and the first version of this table is why. At a
  // single seed the template column came out non-monotonic — a penalty of 0.25 scored *below* a
  // penalty of 0.00, which is impossible — and the step was ₹31,737 against a seed-to-seed
  // coefficient of variation of 4.18% on this very metric. The inversion was the noise floor
  // announcing itself. A curve whose middle cannot be ordered is not a curve, so each point is a
  // mean over seeds and the observed range is carried alongside it.
  for (const penalty of generated === null ? [] : (config.legibilitySweep ?? [])) {
    if (generated === null) break;

    const gains: number[] = [];
    let templateTotal = 0;
    let generatedTotal = 0;

    for (const seed of config.legibilitySeeds ?? [config.simulator.seed]) {
      const simulator = { ...config.simulator, seed };
      const seedLabelled = [...generateLabelled(simulator)];
      const swept = new RecoveryWorld(seed, {
        ...DEFAULT_RECOVERY_WORLD,
        illegiblePenalty: penalty,
      });
      const sweptTruths = buildTruths(seedLabelled, swept, simulator, profiles);
      const sweptClassOf = new Map(sweptTruths.map((t) => [t.casualty.id, t.klass]));

      const sources: readonly { name: string; copy: CopySource }[] = [
        { name: "template", copy: templates },
        { name: "generated", copy: generated },
      ];
      const pair = await Promise.all(
        sources.map((source) =>
          runKairos({
            name: `kairos + ${source.name} copy (penalty ${penalty}, seed ${seed})`,
            copy: source.copy,
            languageMix,
            truths: sweptTruths,
            labelled: seedLabelled,
            world: swept,
            config: { ...config, simulator },
            profiles,
            classOf: sweptClassOf,
            startAt: simulator.startAt,
            endAt: simulator.startAt + simulator.durationMs,
            tailMs,
            schedule: DEFAULT_SCHEDULE_CONFIG,
          }),
        ),
      );

      const [template, generatedRun] = pair;
      if (template === undefined || generatedRun === undefined) continue;
      templateTotal += template.result.incrementalPaise;
      generatedTotal += generatedRun.result.incrementalPaise;
      gains.push(generatedRun.result.incrementalPaise - template.result.incrementalPaise);
    }

    if (gains.length === 0) continue;
    legibilitySweep.push({
      penalty,
      seeds: gains.length,
      templatePaise: Math.round(templateTotal / gains.length),
      generatedPaise: Math.round(generatedTotal / gains.length),
      gainPaise: Math.round(gains.reduce((sum, gain) => sum + gain, 0) / gains.length),
      gainLowPaise: Math.min(...gains),
      gainHighPaise: Math.max(...gains),
    });
  }

  const autonomous = truths.filter((t) => t.casualty.retry === "autonomous");
  const classMix: Record<string, number> = {};
  for (const t of truths) classMix[t.klass] = (classMix[t.klass] ?? 0) + 1;

  return {
    arms,
    windowSweep,
    legibilitySweep,
    languageMix: realisedMix(
      truths.map((t) => t.casualty.customer),
      languageMix,
    ),
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
        // Nobody sent this customer anything — they came back on their own. `legible` is neutral
        // here for the same reason `guidance` is zero: there is no message to judge.
        legible: true,
        // Nobody sent them anything; whatever brought them back, it was not our copy.
        guidance: 0,
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
    // An arm that takes no action writes no audit records, and an empty chain verifies trivially.
    // Saying so is better than leaving the field to be read as "we checked".
    ledgerVerified: true,
    auditRecords: 0,
    copy: { source: "none — sends nothing", sent: 0, fromLibrary: 0, legible: 0 },
  };
}

interface LadderRun {
  readonly name: string;
  readonly offsets: readonly number[];
  readonly copy: CopySource;
  readonly languageMix: Readonly<Record<Language, number>>;
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
    run.copy,
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
      // The ladder sends English templates into the same multilingual population Kairos serves.
      // Handing it the customer's real language is what makes that visible rather than assumed —
      // the baseline is not being handicapped, it is being scored against who is actually there.
      language: languageOf(casualty.customer, run.languageMix),
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
  readonly copy: CopySource;
  readonly languageMix: Readonly<Record<Language, number>>;
  readonly name: string;
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
    run.copy,
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
    // A directory that knows what each customer reads. Derived from the customer reference, so the
    // same person reads the same language in every arm — two arms that disagreed about that would
    // differ by more than their copy and the comparison would be measuring the population.
    directory: {
      lookup: (customer) =>
        Promise.resolve({
          firstName: "Rohit",
          token: "tok",
          language: languageOf(customer, run.languageMix),
        }),
    },
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
    result: summarise(run.name, run.truths, recoveredIds, executor, spent, ledger),
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
    ledgerVerified: ledger.verify().valid,
    auditRecords: ledger.length,
    copy: { source: executor.copySource, ...executor.copyStats },
  };
}
