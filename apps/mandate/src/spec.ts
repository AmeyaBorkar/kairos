import {
  type ActionKind,
  DomainError,
  isActionKind,
  type Mandate,
  mandateId,
  nonNegativePaise,
  paise,
  rupees,
  validateMandate,
} from "@kairos/domain";
import { DEFAULT_RECOVERY_CONFIG, worstActionCostPaise } from "@kairos/recover";
import { type UnsignedMandate, verifyMandate } from "@kairos/terminus";

const DAY_MS = 86_400_000;

/**
 * What a mandate is *for*, and therefore what it may do and what one action of it may cost.
 *
 * The two dangerous fields on a mandate are `allowedActions` and `maxActionCostPaise`, and neither
 * of them is a merchant's decision to make freely. A ceiling set below the worst message the system
 * can compose refuses that message *at settlement*, after it has already been sent. A ceiling set
 * far above it silently widens the blast radius. Both are properties of the price list, so both are
 * derived here from the same constant the worker derives them from, and the merchant is asked the
 * question they can actually answer: what is this mandate for, and how much may it spend in total.
 */
export const PURPOSES = ["recovery", "steering"] as const;

export type Purpose = (typeof PURPOSES)[number];

interface PurposeShape {
  readonly actions: readonly ActionKind[];
  readonly maxActionCostPaise: number;
  readonly summary: string;
}

const SHAPES: Record<Purpose, PurposeShape> = {
  recovery: {
    actions: ["retry", "contact-sms", "contact-whatsapp", "contact-email"],
    // From the price list, exactly as `recover-worker` does it. An Indic SMS buys a second segment,
    // so the worst case is not the common case, and this is the number that has to cover it.
    maxActionCostPaise: worstActionCostPaise(DEFAULT_RECOVERY_CONFIG),
    summary: "chase payments that failed, by retrying them or by messaging the customer",
  },
  steering: {
    // A steer moves a button on a page. It has no marginal cost, and the ceiling of one paise says
    // so louder than a zero would: zero is also what an unset field looks like.
    actions: ["steer"],
    maxActionCostPaise: 1,
    summary: "reorder or hide payment methods on the checkout while a rail is degraded",
  },
};

/** The shape of a mandate as a person would describe it: rupees, days, and clock times. */
export interface MandateSpec {
  /** Defaults to a time-ordered id, so two mandates authored on one day sort by when. */
  readonly id?: string;
  readonly merchantId: string;
  readonly campaignId: string;
  readonly purpose: Purpose;
  /** The lifetime ceiling on spend. Not a rate — this campaign may never spend more than this. */
  readonly budgetRupees: number;
  /** How many actions may be in flight at once. The blast radius, and it is granted, not configured. */
  readonly maxInFlight: number;
  /** How long a campaign runs, from `startsAt`. */
  readonly runsForDays: number;
  /** At most this many messages to one person in this many days. Ignored by a steering mandate. */
  readonly contactCap: { readonly limit: number; readonly windowDays: number };
  /** `null` means no quiet hours, which for a mandate that can message a person is rarely right. */
  readonly quietHours: QuietHoursSpec | null;
  /**
   * Narrow what this mandate may do, within its purpose. Omit for everything the purpose allows.
   *
   * A merchant with email consent and no SMS consent narrows here. Widening is not possible: an
   * action outside the purpose is rejected rather than granted, because the ceiling was derived
   * for the purpose's own price list and would not cover it.
   */
  readonly allowedActions?: readonly string[];
  /** Epoch milliseconds. Defaults to now. */
  readonly startsAt?: number;
  /** Author it already stopped. Useful for a dry run that must be provably incapable of acting. */
  readonly killSwitch?: boolean;
  /**
   * How long a reservation survives unreconciled before the authority returns to the pool.
   *
   * Must exceed the slowest action, or a still-running charge becomes an unaccounted spend. Two
   * minutes by default, which covers a gateway's own timeout with room to spare.
   */
  readonly reservationTtlSeconds?: number;
}

/** `21:00` to `08:00` at `+05:30`, which is how a person says it and how India actually is. */
export interface QuietHoursSpec {
  readonly start: string;
  readonly end: string;
  /**
   * A fixed UTC offset, not an IANA zone.
   *
   * India is UTC+5:30 with no daylight saving, so the offset is exact for the target market — and
   * it is the only calendar arithmetic that stays bit-identical whether the bound is evaluated in
   * this process or inside the shared store. A zone that observes DST is out of scope rather than
   * quietly approximated.
   */
  readonly offset: string;
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const OFFSET = /^([+-])(\d{2}):(\d{2})$/;

/**
 * Turn what a merchant wrote into the mandate the kernel enforces.
 *
 * Every unit conversion in the system happens here and nowhere else. A merchant writes ₹5,000 and
 * 30 days; the kernel reads 500000 paise and two epoch milliseconds. Doing that conversion in a
 * form, in a CLI and in a test would be three chances to write ₹5,000 as 5,000 paise, which is an
 * error no type can catch because both are integers and both are plausible.
 *
 * Unsigned on purpose. This function is safe to run anywhere — a browser, a CI job, a merchant's
 * laptop — precisely because it cannot produce a mandate the kernel will accept. Signing is a
 * separate step that needs a secret, and keeping the two apart is what lets the form be a static
 * page.
 */
export function toMandate(spec: MandateSpec, now = Date.now()): UnsignedMandate {
  const shape = SHAPES[spec.purpose];
  if (shape === undefined) {
    throw new DomainError(
      "purpose",
      `expected one of ${PURPOSES.join(", ")}, received ${spec.purpose}`,
    );
  }

  const startsAt = spec.startsAt ?? now;
  requirePositive(spec.runsForDays, "runsForDays");
  requirePositive(spec.maxInFlight, "maxInFlight");
  requirePositive(spec.contactCap.limit, "contactCap.limit");
  requirePositive(spec.contactCap.windowDays, "contactCap.windowDays");
  requireNonEmpty(spec.merchantId, "merchantId");
  requireNonEmpty(spec.campaignId, "campaignId");

  const mandate: UnsignedMandate = {
    id: mandateId(spec.id ?? `mnd_${startsAt.toString(36)}_${spec.campaignId}`),
    merchantId: spec.merchantId,
    campaignId: spec.campaignId,
    budgetPaise: nonNegativePaise(rupees(spec.budgetRupees, "budgetRupees"), "budgetPaise"),
    maxActionCostPaise: paise(shape.maxActionCostPaise, "maxActionCostPaise"),
    maxInFlight: spec.maxInFlight,
    reservationTtlMs: Math.round((spec.reservationTtlSeconds ?? 120) * 1000),
    contactCap: { limit: spec.contactCap.limit, windowMs: spec.contactCap.windowDays * DAY_MS },
    quietHours: toQuietHours(spec.quietHours),
    allowedActions: narrow(spec.allowedActions, shape.actions),
    validFrom: startsAt,
    validUntil: startsAt + Math.round(spec.runsForDays * DAY_MS),
    killSwitch: spec.killSwitch ?? false,
  };

  // The same validation the kernel runs, run at authoring time. A mandate that cannot be enforced
  // should be refused by the tool that wrote it, not discovered by the worker that loaded it.
  validateMandate({ ...mandate, signature: "" });
  return mandate;
}

function toQuietHours(quiet: QuietHoursSpec | null): Mandate["quietHours"] {
  if (quiet === null) return null;
  return {
    startMinute: minuteOfDay(quiet.start, "quietHours.start"),
    endMinute: minuteOfDay(quiet.end, "quietHours.end"),
    offsetMinutes: offsetMinutes(quiet.offset),
  };
}

function minuteOfDay(value: string, field: string): number {
  const match = TIME.exec(value);
  if (match === null) {
    throw new DomainError(
      field,
      `expected a 24-hour time like "21:00", received ${JSON.stringify(value)}`,
    );
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

function offsetMinutes(value: string): number {
  const match = OFFSET.exec(value);
  if (match === null) {
    throw new DomainError(
      "quietHours.offset",
      `expected a fixed UTC offset like "+05:30", received ${JSON.stringify(value)}`,
    );
  }
  const magnitude = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -magnitude : magnitude;
}

/**
 * Narrow the purpose's action set, refusing to widen it.
 *
 * The asymmetry is the point. Taking SMS away from a recovery mandate is a merchant tightening
 * their own grant and needs no ceremony. Adding an action the purpose does not cover would leave it
 * governed by a ceiling derived for a different price list, which is exactly how an action comes to
 * be refused after it has been performed.
 */
function narrow(
  requested: readonly string[] | undefined,
  allowed: readonly ActionKind[],
): readonly ActionKind[] {
  if (requested === undefined) return allowed;
  if (requested.length === 0) {
    throw new DomainError(
      "allowedActions",
      "a mandate that allows nothing is a configuration error",
    );
  }

  const kinds: ActionKind[] = [];
  for (const name of requested) {
    if (!isActionKind(name)) {
      throw new DomainError("allowedActions", `unknown action ${JSON.stringify(name)}`);
    }
    if (!allowed.includes(name)) {
      throw new DomainError(
        "allowedActions",
        `${name} is outside this mandate's purpose, which allows ${allowed.join(", ")}. ` +
          "Widening would leave the action governed by a per-action ceiling derived for a " +
          "different price list.",
      );
    }
    if (!kinds.includes(name)) kinds.push(name);
  }
  return kinds;
}

function requirePositive(value: number, field: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new DomainError(field, `expected a positive number, received ${value}`);
  }
}

function requireNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DomainError(field, "expected a non-empty value");
  }
}

/** What a purpose grants, for the form's own explanation of the choice. */
export function purposeShape(purpose: Purpose): PurposeShape {
  const shape = SHAPES[purpose];
  if (shape === undefined) throw new DomainError("purpose", `unknown purpose ${purpose}`);
  return shape;
}

/** Whether a signed mandate is this secret's, without saying anything else about it. */
export function isSealedWith(mandate: Mandate, secret: string): boolean {
  return verifyMandate(mandate, secret);
}
