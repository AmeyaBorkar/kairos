import {
  type Casualty,
  inQuietHours,
  isRetryable,
  lastActedAt,
  type QuietHours,
  quietHoursEndAt,
  type Slice,
} from "@kairos/domain";
import type { Classification } from "./classify.js";

/**
 * What the detector currently believes about a rail.
 *
 * A port rather than a dependency on `@kairos/detect`, so the recovery arm stays pure and the same
 * scheduling code runs against a live detector, a replayed incident, and a harness that knows the
 * ground truth. It is also the entire reason this package is named after the *right moment* rather
 * than the *next interval*.
 */
export interface RailGauge {
  /** Whether this slice is degraded right now, as far as the detector can tell. */
  isDegraded(slice: Slice): boolean;
  /**
   * When the slice most recently stopped being degraded, or `null` if it is degraded now or has
   * never been seen to break.
   *
   * The recovery *edge*, not the current state. A rail that healed four seconds ago and a rail that
   * has been fine all week are both healthy, and only one of them is worth firing a queue at.
   */
  recoveredAt(slice: Slice): number | null;
}

/** What a casualty is waiting for. Reported so a console can say why nothing is happening yet. */
export type ScheduleTrigger =
  /** Nothing to wait for. */
  | "immediate"
  /** The rail is broken; the detector will say when it is not. */
  | "rail-recovery"
  /** The instrument works and the money is not there. Wait for a moment when it might be. */
  | "balance-likely"
  /** A fixed rung on a bounded ladder. */
  | "ladder"
  /** Give the customer the chance to come back without being asked. */
  | "spontaneous-window"
  /** Nothing more will be attempted. */
  | "none";

export interface Schedule {
  /** When to next consider this casualty. `null` means never again. */
  readonly dueAt: number | null;
  readonly trigger: ScheduleTrigger;
  /** One line of why, written verbatim to the ledger and shown in the console. */
  readonly reason: string;
}

export interface ScheduleConfig {
  /**
   * How long to let a customer come back on their own before spending anything on them.
   *
   * The single most `kairos` number in the system, and the one most dunning tools get wrong by
   * having no opinion about it at all. A nudge sent ninety seconds after a cancelled payment is
   * mostly paid for by people who were already reaching for a different card, and the recovery it
   * claims is recovery that would have happened anyway. Waiting costs the small chance the customer
   * forgets; not waiting costs a message on every casualty that was never lost.
   *
   * The control arm in the harness is what turns this from an opinion into a measurement, because
   * it is precisely the population that recovers with no help at all.
   */
  readonly spontaneousWindowMs: number;
  /** How often to re-ask whether a broken rail has come back. */
  readonly railRecheckMs: number;
  /**
   * How long to wait after a rail recovers before trusting it.
   *
   * The detector's hysteresis already stops it flapping, so this is not a second copy of that. It
   * is a queue-shaped concern: the instant a rail clears, every casualty waiting on it becomes due
   * at once, and firing them into a gateway that has been up for one second is how a recovery
   * becomes a second outage.
   */
  readonly railSettleMs: number;
  /**
   * How long a `transient` casualty waits for its rail before giving up on the theory.
   *
   * A rail that has been down for hours is not having a transient problem, whatever the error code
   * said. Past this point the casualty stops waiting and is treated as one that needs the customer,
   * which is the honest reading of a failure nothing has fixed all afternoon.
   */
  readonly railPatienceMs: number;
  /** Minimum gap between two attempts on the same casualty, whatever else says otherwise. */
  readonly minBackoffMs: number;
  /**
   * Days of the local month when an Indian salaried customer is most likely to have money.
   *
   * The 1st and 2nd for private-sector credits landing on the last working day, the 7th for a large
   * part of government and PSU payroll. A prior about a population, stated where it can be argued
   * with, and worth far more than a retry at +24h that lands on the 23rd.
   */
  readonly balanceLikelyDaysOfMonth: readonly number[];
  /** Also treat the last day of the month as balance-likely. */
  readonly includeLastDayOfMonth: boolean;
  /** Local hour to aim at on a balance-likely day. */
  readonly balanceLikelyHourLocal: number;
  /** Fixed offset from UTC in minutes for the salary-cycle arithmetic. `330` is IST. */
  readonly offsetMinutes: number;
  /** How long to keep waiting for money before concluding it is not coming. */
  readonly balancePatienceMs: number;
  /** Offsets from the casualty for each rung of the customer-action ladder. */
  readonly contactLadderMs: readonly number[];
  /** How many times a casualty may be charged again before the ladder is spent. */
  readonly maxRetries: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const DEFAULT_SCHEDULE_CONFIG: ScheduleConfig = {
  spontaneousWindowMs: 45 * MINUTE,
  railRecheckMs: 2 * MINUTE,
  railSettleMs: 90_000,
  railPatienceMs: 6 * HOUR,
  minBackoffMs: 10 * MINUTE,
  balanceLikelyDaysOfMonth: [1, 2, 7],
  includeLastDayOfMonth: true,
  balanceLikelyHourLocal: 11,
  offsetMinutes: 330,
  balancePatienceMs: 35 * DAY,
  contactLadderMs: [0, DAY, 3 * DAY],
  maxRetries: 3,
};

/**
 * Whether recovering this casualty requires the customer to be present.
 *
 * Shared with action selection rather than each deciding for itself, because the two must agree:
 * a schedule that assumes a silent retry and a decision that sends an SMS would put a message
 * outside quiet hours with an impeccable audit trail explaining why it was fine.
 */
export function needsCustomer(casualty: Casualty, classification: Classification): boolean {
  if (!isRetryable(classification.recoverability)) return true;
  return casualty.retry === "requires-customer";
}

/**
 * When to next consider this casualty, and why then.
 *
 * Every dunning system schedules on `chronos`: +1h, +24h, +72h, indifferent to what is happening in
 * the world. This schedules on the cause — the rail's recovery edge for a transient failure, a
 * balance-likely moment for an empty account, a bounded ladder for a customer who has to go and do
 * something. That is the whole difference the product is named for, and it is only available
 * because the detector is in the same system.
 *
 * Pure: the gauge and the clock are arguments, so a schedule computed during an incident last month
 * can be recomputed from the ledger and will produce the same answer (P4).
 */
export function schedule(
  casualty: Casualty,
  classification: Classification,
  now: number,
  gauge: RailGauge,
  quietHours: QuietHours | null,
  config: ScheduleConfig = DEFAULT_SCHEDULE_CONFIG,
): Schedule {
  const never = (reason: string): Schedule => ({ dueAt: null, trigger: "none", reason });

  if (casualty.status.recovered) return never("the payment already succeeded");
  if (casualty.status.optedOut) return never("the customer opted out of contact");
  if (casualty.status.disputed) return never("a dispute or chargeback is open");
  if (classification.recoverability === "dead") {
    return never(`${classification.rule} cannot be recovered by anything we can do`);
  }

  const contacting = needsCustomer(casualty, classification);
  const floor = Math.max(
    casualty.occurredAt + (contacting ? config.spontaneousWindowMs : 0),
    (lastActedAt(casualty) ?? Number.NEGATIVE_INFINITY) + config.minBackoffMs,
    now,
  );

  const planned = plan(casualty, classification, now, gauge, config, floor);
  if (planned.dueAt === null) return planned;

  // The spontaneous window is a floor on the *first* customer-facing action, so say so when it is
  // what is actually holding the casualty back rather than reporting the ladder rung it displaced.
  const waitingOut =
    contacting &&
    casualty.attempts.length === 0 &&
    planned.dueAt <= casualty.occurredAt + config.spontaneousWindowMs;

  const shifted = contacting ? outsideQuietHours(planned.dueAt, quietHours) : planned.dueAt;

  if (shifted !== planned.dueAt) {
    return {
      dueAt: shifted,
      trigger: planned.trigger,
      reason: `${planned.reason}, deferred to the end of the do-not-disturb window`,
    };
  }
  if (waitingOut) {
    return {
      dueAt: shifted,
      trigger: "spontaneous-window",
      reason: "letting the customer return unprompted before spending anything on them",
    };
  }
  return { ...planned, dueAt: shifted };
}

function plan(
  casualty: Casualty,
  classification: Classification,
  now: number,
  gauge: RailGauge,
  config: ScheduleConfig,
  floor: number,
): Schedule {
  const at = (dueAt: number, trigger: ScheduleTrigger, reason: string): Schedule => ({
    dueAt: Math.max(dueAt, floor),
    trigger,
    reason,
  });

  switch (classification.recoverability) {
    case "transient":
      return transientSchedule(casualty, now, gauge, config, at);

    case "timed": {
      if (casualty.attempts.length >= config.maxRetries) {
        return { dueAt: null, trigger: "none", reason: "the balance ladder is spent" };
      }
      if (now - casualty.occurredAt > config.balancePatienceMs) {
        return { dueAt: null, trigger: "none", reason: "the money has not arrived in a month" };
      }
      const moment = nextBalanceLikelyMoment(floor, config);
      return at(moment, "balance-likely", "the next moment this customer is likely to have money");
    }

    case "customer-action": {
      const rung = config.contactLadderMs[casualty.attempts.length];
      if (rung === undefined) {
        return { dueAt: null, trigger: "none", reason: "the contact ladder is spent" };
      }
      return at(
        casualty.occurredAt + rung,
        "ladder",
        `rung ${casualty.attempts.length + 1} of ${config.contactLadderMs.length}, ${classification.rule}`,
      );
    }

    case "customer-retry":
    case "unknown": {
      // Exactly one. A person who decided not to pay, or whose failure nobody could name, is asked
      // once and then left alone — the difference between a recovery system and a nuisance.
      if (casualty.attempts.length > 0) {
        return {
          dueAt: null,
          trigger: "none",
          reason: "this casualty gets one ask, and has had it",
        };
      }
      return at(floor, "immediate", `one ask, then stop, ${classification.rule}`);
    }

    case "dead":
      return { dueAt: null, trigger: "none", reason: "nothing we can do recovers this" };
  }
}

function transientSchedule(
  casualty: Casualty,
  now: number,
  gauge: RailGauge,
  config: ScheduleConfig,
  at: (dueAt: number, trigger: ScheduleTrigger, reason: string) => Schedule,
): Schedule {
  if (casualty.attempts.length >= config.maxRetries) {
    return { dueAt: null, trigger: "none", reason: "the retry ladder is spent" };
  }

  const outwaited = now - casualty.occurredAt > config.railPatienceMs;

  if (gauge.isDegraded(casualty.slice)) {
    if (outwaited) {
      // Hours in, this is not a transient problem however the error code was worded. Stop holding
      // the casualty against a recovery that is not coming and ask the customer instead.
      return at(now, "immediate", "the rail has been down too long to keep calling this transient");
    }
    return at(now + config.railRecheckMs, "rail-recovery", "waiting for the rail to come back");
  }

  const healed = gauge.recoveredAt(casualty.slice);
  if (healed === null) {
    // Healthy, and never observed broken. The failure was classified transient from its error code
    // rather than from an incident, so there is no recovery edge to wait for.
    return at(now, "immediate", "the rail is healthy and was never seen to break");
  }

  return at(
    healed + config.railSettleMs,
    "rail-recovery",
    "the rail recovered; firing once it has held",
  );
}

/**
 * The next moment a salaried Indian customer is plausibly in funds.
 *
 * Fixed-offset local time, for the same reason the mandate's quiet hours use one: it is exact for
 * the target market and it is the only calendar arithmetic that reproduces bit-for-bit somewhere
 * that is not this process. Merchants operating across zones that observe daylight saving need a
 * real zone database, and that is out of scope rather than quietly approximated.
 */
export function nextBalanceLikelyMoment(after: number, config: ScheduleConfig): number {
  const offset = config.offsetMinutes * MINUTE;
  const days = new Set(config.balanceLikelyDaysOfMonth);
  const horizonDays = Math.ceil(config.balancePatienceMs / DAY) + 1;

  const local = new Date(after + offset);
  let year = local.getUTCFullYear();
  let month = local.getUTCMonth();
  let day = local.getUTCDate();

  for (let step = 0; step <= horizonDays; step++) {
    const lastOfMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const qualifies = days.has(day) || (config.includeLastDayOfMonth && day === lastOfMonth);

    if (qualifies) {
      const candidate = Date.UTC(year, month, day, config.balanceLikelyHourLocal, 0, 0, 0) - offset;
      if (candidate > after) return candidate;
    }

    day += 1;
    if (day > lastOfMonth) {
      day = 1;
      month += 1;
      if (month > 11) {
        month = 0;
        year += 1;
      }
    }
  }

  // No qualifying day inside the horizon — only reachable with a configuration that names no days
  // and excludes month end. Fall back to the horizon rather than returning something misleading.
  return after + config.balancePatienceMs;
}

/**
 * Move a customer-facing moment out of the do-not-disturb window.
 *
 * Terminus refuses a contact inside quiet hours regardless, so this is not the bound — it is the
 * difference between a worker that wakes at 03:00, is refused, and requeues, and one that simply
 * arrives at 08:00. Two checks that fail differently, which is the pattern the method floor uses
 * for the same reason.
 */
function outsideQuietHours(at: number, quietHours: QuietHours | null): number {
  if (quietHours === null) return at;
  return inQuietHours(quietHours, at) ? quietHoursEndAt(quietHours, at) : at;
}
