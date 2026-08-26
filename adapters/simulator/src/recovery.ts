import { stableSeed } from "@kairos/domain";
import { ILLEGIBLE_PENALTY } from "./quality.js";
import { Rng } from "./rng.js";

/**
 * The recoverability classes the outcome model reasons about.
 *
 * Spelled out here rather than imported from `@kairos/domain`, for the same reason `AppliedPlan`
 * is structural: the simulator must not share a type with the system it is used to evaluate, or one
 * refactor later it will be sharing assumptions too. If the names drift apart, the harness will
 * fail to find a key and say so, which is the failure we want.
 */
export type CasualtyClass =
  | "transient"
  | "timed"
  | "customer-action"
  | "customer-retry"
  | "dead"
  | "unknown";

export type ContactChannel = "contact-sms" | "contact-whatsapp" | "contact-email";

/**
 * How a lost payment behaves when nobody, or somebody, does something about it.
 *
 * **This is the weakest link in the recovery measurement, in exactly the way the choice model is
 * the weakest link in the prevention measurement.** No simulator knows how many customers return to
 * a cancelled checkout unprompted, or how many of those who do only did so because a message
 * arrived. Every number here is an assumption, each is stated next to what it means, and the
 * harness sweeps the ones the answer is sensitive to rather than quoting a flattering point.
 *
 * The structure, though, is not an assumption, and it is the part that matters. A customer either
 * comes back on their own or does not; a message either reaches somebody who was already coming
 * back — in which case it recovered nothing and cost money — or somebody who was not. Getting that
 * decomposition right is what makes a control arm meaningful, and it is why the model draws the
 * counterfactual *first* and the treatment effect second.
 */
export interface RecoveryWorldConfig {
  /** Probability the customer returns and pays with no prompting at all, within the horizon. */
  readonly spontaneousReturn: Readonly<Record<CasualtyClass, number>>;
  /** Mean delay of a spontaneous return, in milliseconds. */
  readonly spontaneousDelayMs: Readonly<Record<CasualtyClass, number>>;
  /**
   * Probability a delivered message brings back somebody who was *not* already coming back.
   *
   * The incremental effect, and the only part of a contact that is worth anything. A model that
   * conflated this with the response rate would report the spontaneous returners as recoveries and
   * make every dunning tool look twice as good as it is.
   */
  readonly nudgeUplift: Readonly<Record<CasualtyClass, number>>;
  /** Relative pull of each channel, multiplying the uplift. */
  readonly channelEffect: Readonly<Record<ContactChannel, number>>;
  /** How much less each subsequent message works than the one before it. */
  readonly nudgeDecay: number;
  /**
   * How much of a message's pull survives arriving in a script the reader does not use.
   *
   * Configurable rather than constant because it is invented, it is the weight the entire
   * multilingual claim rests on, and ADR 0007 spends real postage on the strength of it. A number
   * nobody measured should be a number the harness can sweep — the honest output is not "generated
   * copy is worth ₹X" but "generated copy is worth ₹X if this is 0.5, and ₹0 if it is 1.0".
   *
   * `1` means an unreadable message works exactly as well as a readable one, which is the setting
   * under which the whole language programme is worthless. That the harness can express that is the
   * point of the field.
   */
  readonly illegiblePenalty: number;
  /**
   * Probability per elapsed day that a `customer-action` customer fixes the underlying problem.
   *
   * The reason a fix-link is worth more than a reminder: a customer who has been told exactly what
   * is wrong with their card does something about it far sooner than one who was told a payment
   * failed. {@link RecoveryWorldConfig.fixRateWithGuidance} is that difference.
   */
  readonly fixRatePerDay: number;
  readonly fixRateWithGuidance: number;
  /** Probability the customer is in funds once a salary-likely date has passed. */
  readonly fundedAfterPayday: number;
  /** Probability the customer is in funds before one has. */
  readonly fundedBeforePayday: number;
  /** Probability a message cannot be delivered at all: dead number, bounced address. */
  readonly undeliverableRate: Readonly<Record<ContactChannel, number>>;
  /** Probability a delivered message makes the customer opt out of all future contact. */
  readonly optOutRate: Readonly<Record<ContactChannel, number>>;
  /** After this long, a casualty is written off and no further outcome is drawn. */
  readonly horizonMs: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Defaults, every one of them an assumption.
 *
 * The spontaneous-return rates carry the most weight and are ordered by a simple argument: a
 * customer who cancelled a payment ninety seconds ago is standing at a checkout, and a customer
 * whose card expired is not. Someone who mistyped a PIN is one tap from succeeding; someone with no
 * balance is waiting on their employer. The absolute levels are guesses; the ordering is not.
 */
export const DEFAULT_RECOVERY_WORLD: RecoveryWorldConfig = {
  spontaneousReturn: {
    transient: 0.31,
    timed: 0.14,
    "customer-action": 0.07,
    "customer-retry": 0.46,
    dead: 0.01,
    unknown: 0.18,
  },
  spontaneousDelayMs: {
    transient: 3 * HOUR,
    timed: 6 * DAY,
    "customer-action": 4 * DAY,
    "customer-retry": 25 * MINUTE,
    dead: 30 * DAY,
    unknown: 12 * HOUR,
  },
  nudgeUplift: {
    transient: 0.18,
    timed: 0.16,
    "customer-action": 0.22,
    "customer-retry": 0.13,
    dead: 0,
    unknown: 0.09,
  },
  channelEffect: {
    "contact-sms": 1,
    "contact-whatsapp": 1.15,
    "contact-email": 0.55,
  },
  nudgeDecay: 0.45,
  illegiblePenalty: ILLEGIBLE_PENALTY,
  fixRatePerDay: 0.06,
  fixRateWithGuidance: 0.19,
  fundedAfterPayday: 0.62,
  fundedBeforePayday: 0.09,
  undeliverableRate: {
    "contact-sms": 0.02,
    "contact-whatsapp": 0.06,
    "contact-email": 0.09,
  },
  optOutRate: {
    "contact-sms": 0.012,
    "contact-whatsapp": 0.009,
    "contact-email": 0.003,
  },
  horizonMs: 40 * DAY,
};

/** The counterfactual: what would have happened to this casualty if nobody had touched it. */
export interface Counterfactual {
  /** When the customer would have come back unprompted, or `null` if they never would. */
  readonly spontaneousAt: number | null;
}

export interface ActionOutcome {
  /** Whether the money came in as a result of this action. */
  readonly recovered: boolean;
  /** For a retry, whether the decline will differ next time. */
  readonly hardDecline: boolean;
  /** For a contact, whether it reached anybody. */
  readonly delivered: boolean;
  /** Whether this action cost the merchant the customer's consent to be contacted again. */
  readonly optedOut: boolean;
  /**
   * Whether this customer was going to come back within the horizon regardless.
   *
   * The flag that makes the whole measurement honest. A system reporting recoveries without it is
   * reporting the sum of its own effect and the customer's, and claiming both. Note that it is
   * about the *horizon*, not about this moment: a customer who would have returned tomorrow was
   * always coming back, and a message sent today accelerated them rather than recovering them.
   */
  readonly wasAlreadyComing: boolean;
}

/** Everything the outcome of one action depends on. */
export interface ActionContext {
  readonly casualtyId: string;
  readonly casualtyClass: CasualtyClass;
  readonly occurredAt: number;
  readonly at: number;
  /** Whether the rail this payment died on is genuinely healthy right now. Ground truth. */
  readonly railHealthy: boolean;
  /** Whether a salary-likely date has passed since the failure. Ground truth. */
  readonly pastPayday: boolean;
  /** How many actions have already been taken on this casualty. */
  readonly ordinal: number;
  /**
   * How good the message was, scored from the message.
   *
   * A number in [0,1] rather than a flag, and produced by {@link scoreMessage} from the rendered
   * text rather than supplied by the arm that wrote it. That distinction is the whole reason this
   * field changed shape: a boolean the caller set was an arm's opinion of its own copy, and an arm
   * could improve its measured result by passing `true`.
   *
   * Content only. Whether the reader can read it at all is {@link legible}, and the two are applied
   * at different points below because they are different mechanisms.
   */
  readonly guidance: number;
  /**
   * Whether the message arrived in a script this customer reads.
   *
   * Separated from {@link guidance} when the multilingual arm was built, and the separation is the
   * point rather than a tidy-up. These two facts act on a customer at two different moments:
   *
   * - **Legibility decides whether they respond at all.** Nobody acts on a message they cannot
   *   read, so it belongs on the response rate — and until this field existed, it was not there.
   *   An illegible message pulled back exactly as many people as a legible one and was then
   *   slightly worse at helping them, which is not a model of anything.
   * - **Guidance decides whether the attempt then succeeds.** Knowing that it was your card's OTP
   *   and not your balance is what makes the second attempt work.
   *
   * Folding both into one number would have applied the readability penalty to the wrong quantity,
   * and folding it into `guidance` *as well* would have charged it twice through two routes and
   * flattered every multilingual result by construction. It is charged once, here.
   */
  readonly legible: boolean;
}

/**
 * The ground truth of what happens to lost payments.
 *
 * Every draw is derived from the casualty's own id and the world seed, so a casualty's fate does
 * not depend on the order in which the harness happens to process it. Without that, two arms
 * running the same casualties in different orders would diverge for reasons that have nothing to do
 * with the policy being measured, and every comparison would be noise.
 */
export class RecoveryWorld {
  readonly #seed: number;
  readonly #config: RecoveryWorldConfig;

  constructor(seed: number, config: RecoveryWorldConfig = DEFAULT_RECOVERY_WORLD) {
    this.#seed = seed;
    this.#config = config;
  }

  get config(): RecoveryWorldConfig {
    return this.#config;
  }

  /**
   * What would have happened with no intervention at all.
   *
   * Drawn from the casualty alone, so it is the same fact in every arm — which is exactly what makes
   * the control arm a control rather than a different population.
   */
  counterfactual(
    casualtyId: string,
    casualtyClass: CasualtyClass,
    occurredAt: number,
  ): Counterfactual {
    const rng = this.#rngFor(casualtyId, "spontaneous");
    if (!rng.bool(this.#config.spontaneousReturn[casualtyClass])) return { spontaneousAt: null };

    const delay = rng.exponential(this.#config.spontaneousDelayMs[casualtyClass]);
    const at = occurredAt + delay;
    return { spontaneousAt: at <= occurredAt + this.#config.horizonMs ? Math.round(at) : null };
  }

  /**
   * Whether the payment could actually go through at this moment, if the customer were willing.
   *
   * Public because the control arm needs it too: an untouched casualty recovers only if the
   * customer returns *and* the thing that broke it has stopped being broken by then. Evaluating
   * that at the customer's own return time rather than at ours is what stops the control arm from
   * being credited with our timing.
   */
  wouldSucceed(context: ActionContext): boolean {
    // Zero guidance: nobody sent them anything. Whatever brought them back, it was not our copy.
    return this.#underlyingFixed(
      context,
      this.#rngFor(context.casualtyId, "spontaneous-success"),
      0,
    );
  }

  /**
   * Charge the payment again, with nobody present.
   *
   * Succeeds when the thing that broke it is no longer broken, which is the entire reason the
   * schedule waits for a recovery edge rather than for a clock.
   */
  retry(context: ActionContext): ActionOutcome {
    const rng = this.#rngFor(context.casualtyId, `retry:${context.ordinal}`);
    const wasAlreadyComing = this.#coming(context);

    // Likewise: an autonomous retry is a server call. There is no message to be good.
    const success = this.#underlyingFixed(context, rng, 0);
    return {
      recovered: success,
      hardDecline: !success && context.casualtyClass === "customer-action",
      delivered: true,
      optedOut: false,
      wasAlreadyComing,
    };
  }

  /**
   * Send the customer a message.
   *
   * Three independent things have to go right, and the model keeps them separate because they fail
   * for different reasons and cost different amounts. The message has to arrive. It has to move
   * somebody who was not already moving. And the payment then has to be able to succeed, which for
   * a broken rail or an empty account it still may not.
   */
  contact(context: ActionContext, channel: ContactChannel): ActionOutcome {
    const rng = this.#rngFor(context.casualtyId, `${channel}:${context.ordinal}`);
    const wasAlreadyComing = this.#coming(context);

    if (rng.bool(this.#config.undeliverableRate[channel])) {
      return {
        recovered: false,
        hardDecline: false,
        delivered: false,
        optedOut: false,
        wasAlreadyComing,
      };
    }

    const optedOut = rng.bool(this.#config.optOutRate[channel]);

    const pull =
      this.#config.nudgeUplift[context.casualtyClass] *
      this.#config.channelEffect[channel] *
      (1 - this.#config.nudgeDecay) ** context.ordinal *
      // A message in a script the reader does not use still arrives, still costs its segments, and
      // still spends a contact from the cap — it just moves fewer people. This is the single place
      // that fact is priced, and `ILLEGIBLE_PENALTY` is the invented number the whole multilingual
      // case rests on. `bench variance --sweep-legibility` reports the arm's gain across its range
      // rather than asserting the default is right. See open question 18.
      (context.legible ? 1 : this.#config.illegiblePenalty);

    // Somebody who was already coming back is receptive by construction; the uplift is the extra
    // people the message reaches. Whether the payment then goes through is a separate question, and
    // it is where the *timing* of the message earns its keep — the same customer, contacted while
    // their rail is still broken, responds and fails.
    const responded = wasAlreadyComing || rng.bool(Math.min(1, pull));
    const recovered = responded && this.#underlyingFixed(context, rng, context.guidance);

    return { recovered, hardDecline: false, delivered: true, optedOut, wasAlreadyComing };
  }

  /**
   * Whether the payment can actually go through at this moment.
   *
   * Separate from whether the customer is willing, because they are separate facts and conflating
   * them is what makes a dunning system retry into an outage all afternoon.
   */
  #underlyingFixed(context: ActionContext, rng: Rng, guidance: number): boolean {
    switch (context.casualtyClass) {
      case "transient":
        return context.railHealthy;
      case "timed":
        return rng.bool(
          context.pastPayday ? this.#config.fundedAfterPayday : this.#config.fundedBeforePayday,
        );
      case "customer-action": {
        const days = Math.max(0, (context.at - context.occurredAt) / DAY);
        // Interpolated rather than switched. Copy is not guided or unguided; it names the bank or
        // it does not, says what to do or does not, arrives in a script the reader uses or does
        // not. A message with two of those three is worth more than one with none and less than one
        // with all, and a boolean could not say so.
        const { fixRatePerDay, fixRateWithGuidance } = this.#config;
        const rate = fixRatePerDay + guidance * (fixRateWithGuidance - fixRatePerDay);
        return rng.bool(1 - (1 - rate) ** days);
      }
      case "customer-retry":
        // Nothing was wrong, so the only question was whether they came back at all — unless the
        // rail they were using has since broken, which would be an unkind coincidence and is
        // modelled as one.
        return context.railHealthy;
      case "unknown":
        return rng.bool(0.4);
      case "dead":
        return false;
    }
  }

  /** Whether this customer was going to return within the horizon with no help from anyone. */
  #coming(context: ActionContext): boolean {
    const { spontaneousAt } = this.counterfactual(
      context.casualtyId,
      context.casualtyClass,
      context.occurredAt,
    );
    return spontaneousAt !== null;
  }

  /**
   * A generator whose stream depends only on the casualty and the purpose, never on call order.
   *
   * FNV-1a over the two, mixed with the world seed. A shared sequential generator would make one
   * arm's draws depend on how many draws the other arm happened to make first, which is the classic
   * way a simulation study measures its own scheduling.
   */
  #rngFor(casualtyId: string, purpose: string): Rng {
    return new Rng(stableSeed(String(this.#seed), casualtyId, purpose));
  }
}
