import type { ActionKind } from "./action.js";
import { DomainError } from "./brand.js";
import type { MandateId } from "./identifiers.js";
import type { Paise } from "./money.js";

/** How many contacts a single customer may receive in a rolling window. */
export interface ContactCap {
  readonly limit: number;
  readonly windowMs: number;
}

/**
 * A do-not-disturb window, expressed in minutes from local midnight.
 *
 * The zone is a **fixed UTC offset**, not an IANA identifier. India is UTC+5:30 with no daylight
 * saving, so a fixed offset is exact for the target market; more importantly a fixed offset is the
 * only calendar arithmetic that is reproducible bit-for-bit in a Redis Lua script, which is what
 * keeps this bound identical whether it is evaluated in-process or in the shared store. Merchants
 * operating across DST-observing zones would need a real zone database, and that is out of scope
 * rather than quietly approximated.
 *
 * `startMinute > endMinute` means the window wraps midnight, which is the usual case: 21:00–08:00.
 */
export interface QuietHours {
  /** Inclusive, `[0, 1440)`. */
  readonly startMinute: number;
  /** Exclusive, `[0, 1440)`. */
  readonly endMinute: number;
  /** Fixed offset from UTC in minutes. `330` is IST. */
  readonly offsetMinutes: number;
}

/**
 * A grant of authority to spend money and contact people on a merchant's behalf.
 *
 * Everything Terminus enforces is stated here as a number, not as a policy document. A mandate is
 * the *whole* of what the system may do: if a limit is not on this object, it is not enforced, and
 * if it is on this object it cannot be exceeded by any code path, because there is exactly one
 * admission gate and it reads this.
 */
export interface Mandate {
  readonly id: MandateId;
  readonly merchantId: string;
  readonly campaignId: string;
  /** Total spend authority for the campaign's lifetime. Not a rate — a ceiling. */
  readonly budgetPaise: Paise;
  /**
   * The most a single action may cost. This is the term that makes the overspend bound finite:
   * see {@link https://github.com/AmeyaBorkar/kairos/blob/main/docs/ARCHITECTURE.md | §8}. An
   * adapter that cannot cap its own cost cannot be admitted.
   */
  readonly maxActionCostPaise: Paise;
  /**
   * How many actions may be in flight — reserved but not yet reconciled — at once.
   *
   * This is the *other* term in the overspend bound, and it is a property of the mandate rather
   * than of the deployment: adding workers cannot raise it.
   */
  readonly maxInFlight: number;
  /**
   * How long a reservation survives without being reconciled before the authority returns to the
   * pool. Must exceed the worst-case wall-clock duration of an action, or a still-running action
   * becomes an unaccounted spend.
   */
  readonly reservationTtlMs: number;
  readonly contactCap: ContactCap;
  readonly quietHours: QuietHours | null;
  /** The closed set of things this mandate authorises. Anything else is refused by name. */
  readonly allowedActions: readonly ActionKind[];
  readonly validFrom: number;
  readonly validUntil: number;
  /**
   * The authored stop. Signed, so an attacker who cannot forge the signature cannot clear it.
   * A second, store-backed switch exists for instant fleet-wide propagation; either one stops
   * everything, which is P2 applied to the stop itself.
   */
  readonly killSwitch: boolean;
  /** HMAC-SHA256 over the canonical encoding of every field above. */
  readonly signature: string;
}

const DAY_MINUTES = 1440;
const DAY_MS = 86_400_000;

function requirePositiveInt(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new DomainError(field, `expected a positive integer, received ${value}`);
  }
}

function requireMinuteOfDay(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value >= DAY_MINUTES) {
    throw new DomainError(
      field,
      `expected a minute of day in [0, ${DAY_MINUTES}), received ${value}`,
    );
  }
}

/**
 * Reject a mandate that cannot be enforced, at construction rather than at admission.
 *
 * Every check here corresponds to a way the bound would silently stop holding: a zero budget that
 * is really "unlimited" by accident, a reservation TTL shorter than the action it covers, an empty
 * action list that would deny everything, a validity window that has already closed.
 */
export function validateMandate(m: Mandate): void {
  if (m.budgetPaise < 0) {
    throw new DomainError(
      "budgetPaise",
      `expected a non-negative budget, received ${m.budgetPaise}`,
    );
  }
  requirePositiveInt(m.maxActionCostPaise, "maxActionCostPaise");
  requirePositiveInt(m.maxInFlight, "maxInFlight");
  requirePositiveInt(m.reservationTtlMs, "reservationTtlMs");
  requirePositiveInt(m.contactCap.limit, "contactCap.limit");
  requirePositiveInt(m.contactCap.windowMs, "contactCap.windowMs");

  if (m.allowedActions.length === 0) {
    throw new DomainError(
      "allowedActions",
      "a mandate that allows nothing is a configuration error, not a policy",
    );
  }
  if (new Set(m.allowedActions).size !== m.allowedActions.length) {
    throw new DomainError("allowedActions", "duplicate action kinds make the list ambiguous");
  }
  if (!Number.isSafeInteger(m.validFrom) || !Number.isSafeInteger(m.validUntil)) {
    throw new DomainError("validity", "validity bounds must be epoch milliseconds");
  }
  if (m.validUntil <= m.validFrom) {
    throw new DomainError(
      "validUntil",
      `validity window is empty: ${m.validFrom}..${m.validUntil}`,
    );
  }

  if (m.quietHours !== null) {
    requireMinuteOfDay(m.quietHours.startMinute, "quietHours.startMinute");
    requireMinuteOfDay(m.quietHours.endMinute, "quietHours.endMinute");
    if (
      !Number.isSafeInteger(m.quietHours.offsetMinutes) ||
      Math.abs(m.quietHours.offsetMinutes) > DAY_MINUTES
    ) {
      throw new DomainError(
        "quietHours.offsetMinutes",
        `expected a UTC offset in minutes, received ${m.quietHours.offsetMinutes}`,
      );
    }
  }
}

/** Whether `at` falls inside the mandate's validity window. Half-open: `[validFrom, validUntil)`. */
export function isMandateCurrent(m: Mandate, at: number): boolean {
  return at >= m.validFrom && at < m.validUntil;
}

/** Whether the mandate authorises this kind of action at all. */
export function allowsAction(m: Mandate, kind: ActionKind): boolean {
  return m.allowedActions.includes(kind);
}

/** Minutes elapsed since local midnight at the window's fixed offset. */
function minuteOfDay(q: QuietHours, at: number): number {
  const shifted = at + q.offsetMinutes * 60_000;
  const withinDay = ((shifted % DAY_MS) + DAY_MS) % DAY_MS;
  return Math.floor(withinDay / 60_000);
}

/** Whether `at` falls inside the do-not-disturb window. An empty window covers nothing. */
export function inQuietHours(q: QuietHours, at: number): boolean {
  if (q.startMinute === q.endMinute) return false;
  const minute = minuteOfDay(q, at);
  return q.startMinute < q.endMinute
    ? minute >= q.startMinute && minute < q.endMinute
    : minute >= q.startMinute || minute < q.endMinute;
}

/**
 * When the quiet window next ends, given a time inside it.
 *
 * A refusal that also says *when* is the difference between a bound and an obstacle: the scheduler
 * uses this to move the action to the edge of the window rather than polling until it opens.
 */
export function quietHoursEndAt(q: QuietHours, at: number): number {
  if (!inQuietHours(q, at)) return at;
  const minute = minuteOfDay(q, at);
  const minutesToWait =
    minute < q.endMinute ? q.endMinute - minute : DAY_MINUTES - minute + q.endMinute;
  return at + minutesToWait * 60_000;
}
