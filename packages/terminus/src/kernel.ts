import {
  allowsAction,
  type BindingAxis,
  type CasualtyStatus,
  inQuietHours,
  isContact,
  isMandateCurrent,
  isWorthDoing,
  type Mandate,
  type Paise,
  type ProposedAction,
  paise,
  quietHoursEndAt,
  validateMandate,
} from "@kairos/domain";
import type { JsonValue } from "@kairos/ledger";
import type { Store } from "throttlekit";
import { type ContactLedger, contactLedger } from "./caps.js";
import { actionKey } from "./identity.js";
import {
  type AuditSink,
  type Clock,
  type KillSwitch,
  openKillSwitch,
  systemClock,
} from "./ports.js";
import { clampReservation, type Sizer, worstCaseSizer } from "./reservation.js";
import { verifyMandate } from "./signature.js";
import { DEFAULT_STOP_CONFIG, describeStop, type StopConfig, stopReasonFor } from "./stops.js";
import { BudgetLedger, type BudgetSnapshot } from "./store.js";

/** One request for authority. */
export interface AdmissionRequest {
  readonly action: ProposedAction;
  /** Everything the stopping rules need. Pure input, so the decision replays exactly (P4). */
  readonly status: CasualtyStatus;
  /** Which attempt at this action this is. Increment for a genuine retry; keep for a replay. */
  readonly attemptNo: number;
}

/** Authority granted. Must be reconciled with {@link Terminus.settle} or {@link Terminus.abandon}. */
export interface Grant {
  readonly id: string;
  readonly reservedPaise: Paise;
  readonly action: ProposedAction;
  readonly expiresAt: number;
  /** True when this grant was an existing reservation replayed rather than a fresh one. */
  readonly replayed: boolean;
}

export type Admission =
  | {
      readonly allowed: true;
      readonly grant: Grant;
      readonly availablePaise: Paise;
      readonly reason: string;
    }
  | {
      readonly allowed: false;
      readonly axis: BindingAxis;
      readonly reason: string;
      /** When the same request could succeed, if it ever could. `null` means never. */
      readonly retryAfterMs: number | null;
    };

export interface SettleReceipt {
  readonly grantId: string;
  readonly reservedPaise: Paise;
  readonly actualPaise: Paise;
  readonly overrunPaise: Paise;
  /** False when the reservation had lapsed before the action reported its cost. */
  readonly recognised: boolean;
  /** True when an adapter reported a cost above the mandate's per-action ceiling. */
  readonly exceededActionCap: boolean;
  readonly availablePaise: Paise;
  readonly outcome: string;
  readonly externalRef: string | null;
}

/**
 * The money was booked but the record of it was not written.
 *
 * Thrown rather than swallowed because the two halves fail differently: losing a settlement record
 * leaves a spend nobody can explain, which is exactly the state the ledger exists to make
 * impossible. The receipt rides along so the caller can complete the missing half with
 * {@link Terminus.recordSettlement} — calling {@link Terminus.settle} again would book the money
 * twice.
 */
export class SettlementUnrecordedError extends Error {
  readonly receipt: SettleReceipt;

  constructor(receipt: SettleReceipt, cause: unknown) {
    super(`settlement ${receipt.grantId} was booked but could not be recorded`);
    this.name = "SettlementUnrecordedError";
    this.receipt = receipt;
    this.cause = cause;
  }
}

export interface TerminusOptions {
  readonly mandate: Mandate;
  /** The key the mandate was signed with. A mandate that does not verify is never acted on. */
  readonly secret: string;
  readonly store: Store;
  readonly audit: AuditSink;
  /** Who is deciding, e.g. `recover-worker/3`. Written to every record. */
  readonly actor: string;
  readonly clock?: Clock;
  readonly killSwitch?: KillSwitch;
  readonly sizer?: Sizer;
  readonly stops?: StopConfig;
  readonly keyPrefix?: string;
  /** Overrides the store-backed contact cap. A port, so an adapter or a test can supply its own. */
  readonly contacts?: ContactLedger;
}

/**
 * The governance kernel: one gate, no path around it.
 *
 * Every bound the system claims is enforced here, in one method, in a fixed order, against a signed
 * mandate. Nothing else in Kairos may spend money or contact a person — not because that is the
 * convention, but because nothing else holds a reservation, and the adapters take a {@link Grant}
 * rather than an amount.
 *
 * ## Ordering, and why refusals are cheap
 *
 * The checks run cheapest-and-most-absolute first, and the *consuming* ones run last. A refusal on
 * quiet hours must not burn a contact allowance; a refusal on the contact cap must not strand
 * budget. The contact cap is therefore read non-consumingly before any budget is taken, and only
 * then consumed for real — the read keeps a doomed request from holding an in-flight slot that
 * would refuse a live one, and the consume is what actually enforces the cap. Should another worker
 * take the last allowance in between, the budget reservation is released exactly, because it is the
 * one resource that can be handed back.
 *
 * ## Failing closed, and failing loud
 *
 * Admission never throws. Every failure, including one from the audit sink or the kill switch, is a
 * refusal with a named axis, because a request that cannot be evaluated must not be acted on (P2).
 *
 * Settlement is the opposite: it throws, because by then the money has already moved and the only
 * remaining question is whether anyone will be able to explain it (P8). Admission fails closed;
 * settlement fails loud.
 */
export class Terminus {
  readonly #mandate: Mandate;
  readonly #secret: string;
  readonly #clock: Clock;
  readonly #audit: AuditSink;
  readonly #actor: string;
  readonly #killSwitch: KillSwitch;
  readonly #sizer: Sizer;
  readonly #stops: StopConfig;
  readonly #budget: BudgetLedger;
  readonly #contacts: ContactLedger;

  constructor(options: TerminusOptions) {
    validateMandate(options.mandate);

    this.#mandate = options.mandate;
    this.#secret = options.secret;
    this.#clock = options.clock ?? systemClock;
    this.#audit = options.audit;
    this.#actor = options.actor;
    this.#killSwitch = options.killSwitch ?? openKillSwitch;
    this.#sizer = options.sizer ?? worstCaseSizer(options.mandate.maxActionCostPaise);
    this.#stops = options.stops ?? DEFAULT_STOP_CONFIG;

    const prefix = options.keyPrefix ?? "kairos";
    const scope = `${prefix}:${options.mandate.merchantId}:${options.mandate.campaignId}`;

    this.#budget = new BudgetLedger({
      store: options.store,
      key: `${scope}:budget`,
      budgetPaise: options.mandate.budgetPaise,
      // Long enough to outlive the campaign plus any settlement still in flight when it closes.
      // Sized from the mandate's own duration rather than from `now`, so a quiet period inside the
      // campaign can never let the key lapse and resurrect the budget at zero spent.
      stateTtlMs:
        options.mandate.validUntil -
        options.mandate.validFrom +
        options.mandate.reservationTtlMs * 2,
    });

    this.#contacts =
      options.contacts ??
      contactLedger({
        cap: options.mandate.contactCap,
        store: options.store,
        clock: this.#clock,
        prefix: `${scope}:contact`,
      });
  }

  get mandate(): Mandate {
    return this.#mandate;
  }

  /** The sizer in force, named. Reported in the scorecard next to the overspend it permitted. */
  get sizerName(): string {
    return this.#sizer.name;
  }

  /**
   * Decide whether an action may proceed, and hold the authority for it if so.
   *
   * @returns an allow carrying a {@link Grant}, or a refusal naming exactly one binding axis.
   */
  async admit(request: AdmissionRequest): Promise<Admission> {
    const now = this.#clock.now();
    const m = this.#mandate;
    const { action } = request;

    // The signature first: after this line, every field of the mandate is trusted, and a forged one
    // has cost us an HMAC rather than a round trip.
    if (!verifyMandate(m, this.#secret)) {
      return this.#refuse(
        action,
        "mandate-signature",
        "the mandate's signature does not verify",
        null,
        now,
      );
    }

    if (m.killSwitch) {
      return this.#refuse(action, "kill-switch", "the mandate's kill switch is engaged", null, now);
    }

    // A kill switch we cannot read is a kill switch we must assume is engaged (P2).
    let switchEngaged: boolean;
    try {
      switchEngaged = await this.#killSwitch.engaged(m);
    } catch {
      switchEngaged = true;
    }
    if (switchEngaged) {
      return this.#refuse(action, "kill-switch", "the operator kill switch is engaged", null, now);
    }

    if (!isMandateCurrent(m, now)) {
      const retry = now < m.validFrom ? m.validFrom - now : null;
      return this.#refuse(
        action,
        "mandate-validity",
        `the mandate is not in force at ${now}`,
        retry,
        now,
      );
    }

    if (!allowsAction(m, action.kind)) {
      return this.#refuse(
        action,
        "action-not-allowed",
        `the mandate does not authorise ${action.kind}`,
        null,
        now,
      );
    }

    const stop = stopReasonFor(request.status, this.#stops);
    if (stop !== null) {
      return this.#refuse(action, "stop-rule", describeStop(stop, this.#stops), null, now, {
        stopReason: stop,
      });
    }

    if (!isWorthDoing(action)) {
      return this.#refuse(
        action,
        "expected-value",
        `expected return ${Math.round(action.successProbability * action.expectedValue)} paise does not clear a cost of ${action.estimatedCost}`,
        null,
        now,
      );
    }

    const contact = isContact(action.kind);

    if (contact && m.quietHours !== null && inQuietHours(m.quietHours, now)) {
      return this.#refuse(
        action,
        "quiet-hours",
        "the customer's local time falls inside the do-not-disturb window",
        quietHoursEndAt(m.quietHours, now) - now,
        now,
      );
    }

    // Read the contact cap before taking any budget. This is not only about saving a round trip on
    // a request that was always going to be refused: a reservation held for the moment it takes to
    // discover the cap is full occupies an in-flight slot, and under contention that slot refuses
    // *other* workers on the concurrency axis. A doomed request should not cost a live one.
    if (contact) {
      const seen = await this.#contacts.peek(action.customer);
      if (!seen.allowed) return this.#cappedRefusal(action, seen.retryAfterMs, seen.remaining, now);
    }

    const id = actionKey({
      kind: action.kind,
      customer: action.customer,
      casualty: action.casualty,
      incident: action.incident,
      attemptNo: request.attemptNo,
    });

    const amountPaise = clampReservation(this.#sizer.size(action), m.maxActionCostPaise);
    const reserved = await this.#budget.reserve({
      id,
      amountPaise,
      maxInFlight: m.maxInFlight,
      ttlMs: m.reservationTtlMs,
      now,
    });

    if (!reserved.ok) {
      const reason =
        reserved.axis === "budget"
          ? `${amountPaise} paise exceeds the ${reserved.availablePaise} paise still available`
          : `${reserved.inFlight} actions already in flight, cap ${m.maxInFlight}`;
      return this.#refuse(action, reserved.axis, reason, null, now, {
        availablePaise: reserved.availablePaise,
        inFlight: reserved.inFlight,
      });
    }

    // The peek above is advisory; this is the authority. Between the two, another worker may have
    // taken the last allowance, so the cap is consumed atomically here and the budget reservation —
    // the one resource that *can* be handed back exactly — is released if it loses that race.
    if (contact) {
      const cap = await this.#contacts.consume(action.customer);
      if (!cap.allowed) {
        await this.#budget.release(id, now);
        return this.#cappedRefusal(action, cap.retryAfterMs, cap.remaining, now);
      }
    }

    const grant: Grant = {
      id,
      reservedPaise: paise(reserved.reservedPaise, "reservation"),
      action,
      expiresAt: reserved.expiresAt,
      replayed: reserved.replayed,
    };

    const reason = `reserved ${reserved.reservedPaise} paise of ${reserved.availablePaise + reserved.reservedPaise} available`;
    try {
      await this.#audit.append({
        at: now,
        actor: this.#actor,
        action: action.kind,
        target: targetOf(action),
        allowed: true,
        reason,
        binding: null,
        externalRef: null,
        outcome: null,
        meta: {
          grant: id,
          reservedPaise: reserved.reservedPaise,
          availablePaise: reserved.availablePaise,
          inFlight: reserved.inFlight,
          replayed: reserved.replayed,
          sizer: this.#sizer.name,
          rationale: action.rationale,
        },
      });
    } catch {
      // An unrecorded decision must not become an action. Release and refuse — note that a contact
      // allowance consumed above is not refunded, which errs toward fewer messages, not more.
      await this.#budget.release(id, now);
      return this.#refuse(
        action,
        "audit",
        "the decision could not be written to the ledger",
        null,
        now,
      );
    }

    return {
      allowed: true,
      grant,
      availablePaise: paise(reserved.availablePaise, "available"),
      reason,
    };
  }

  /**
   * Reconcile a grant against what the action actually cost.
   *
   * Books the money first and records it second, because those are the two things that can fail and
   * only one of them can be retried safely. If the record fails the money is already booked, so
   * this throws {@link SettlementUnrecordedError} carrying the receipt rather than pretending
   * either half did not happen.
   */
  async settle(
    grant: Grant,
    actualPaise: Paise,
    outcome: string,
    externalRef: string | null = null,
  ): Promise<SettleReceipt> {
    const now = this.#clock.now();
    const result = await this.#budget.settle(grant.id, actualPaise, now);
    this.#sizer.observe(actualPaise);

    const receipt: SettleReceipt = {
      grantId: grant.id,
      reservedPaise: paise(result.reservedPaise, "reserved"),
      actualPaise: paise(result.actualPaise, "actual"),
      overrunPaise: paise(result.overrunPaise, "overrun"),
      recognised: result.known,
      exceededActionCap: actualPaise > this.#mandate.maxActionCostPaise,
      availablePaise: paise(result.availablePaise, "available"),
      outcome,
      externalRef,
    };

    try {
      await this.recordSettlement(receipt, grant);
    } catch (cause) {
      throw new SettlementUnrecordedError(receipt, cause);
    }

    return receipt;
  }

  /**
   * Write a settlement's audit record.
   *
   * Split out so a failed record can be retried on its own. Re-running {@link Terminus.settle}
   * would book the spend a second time; this writes only the half that is missing.
   */
  async recordSettlement(receipt: SettleReceipt, grant: Grant): Promise<void> {
    await this.#audit.append({
      at: this.#clock.now(),
      actor: this.#actor,
      action: grant.action.kind,
      target: targetOf(grant.action),
      allowed: true,
      reason: `settled ${receipt.actualPaise} paise against a reservation of ${receipt.reservedPaise}`,
      binding: null,
      externalRef: receipt.externalRef,
      outcome: receipt.outcome,
      meta: {
        grant: receipt.grantId,
        reservedPaise: receipt.reservedPaise,
        actualPaise: receipt.actualPaise,
        overrunPaise: receipt.overrunPaise,
        recognised: receipt.recognised,
        exceededActionCap: receipt.exceededActionCap,
        availablePaise: receipt.availablePaise,
      },
    });
  }

  /**
   * Give a grant back without spending it.
   *
   * The action was refused downstream, or never ran. Distinct from settling zero: nothing was
   * spent, so nothing is recorded as spend.
   */
  async abandon(grant: Grant, reason: string): Promise<void> {
    const now = this.#clock.now();
    const result = await this.#budget.release(grant.id, now);
    await this.#audit.append({
      at: now,
      actor: this.#actor,
      action: grant.action.kind,
      target: targetOf(grant.action),
      allowed: false,
      reason,
      binding: null,
      externalRef: null,
      outcome: "abandoned",
      meta: {
        grant: grant.id,
        releasedPaise: result.releasedPaise,
        availablePaise: result.availablePaise,
      },
    });
  }

  /** The books, without changing them. */
  snapshot(): Promise<BudgetSnapshot> {
    return this.#budget.snapshot(this.#clock.now());
  }

  /** The contact-cap refusal, phrased once so the peek and the consume paths cannot drift apart. */
  #cappedRefusal(
    action: ProposedAction,
    retryAfterMs: number,
    remaining: number,
    now: number,
  ): Promise<Admission> {
    const cap = this.#mandate.contactCap;
    const days = Math.round(cap.windowMs / 86_400_000);
    return this.#refuse(
      action,
      "contact-cap",
      `this customer has had ${cap.limit} contacts in the last ${days} days, cap ${cap.limit}`,
      retryAfterMs > 0 ? retryAfterMs : null,
      now,
      { remainingContacts: remaining },
    );
  }

  /**
   * Record a refusal and return it.
   *
   * A refusal that cannot be written is still a refusal — the system does nothing either way — so
   * unlike the allow path this swallows an audit failure rather than converting one refusal into
   * another. The alternative would report `audit` as the binding axis for a request that was
   * already denied on its merits, which is a worse answer to "why did nothing happen?".
   */
  async #refuse(
    action: ProposedAction,
    axis: BindingAxis,
    reason: string,
    retryAfterMs: number | null,
    now: number,
    meta: Record<string, JsonValue> = {},
  ): Promise<Admission> {
    try {
      await this.#audit.append({
        at: now,
        actor: this.#actor,
        action: action.kind,
        target: targetOf(action),
        allowed: false,
        reason,
        binding: axis,
        externalRef: null,
        outcome: null,
        meta: { ...meta, retryAfterMs, rationale: action.rationale },
      });
    } catch {
      // Deliberately ignored; see the doc comment above.
    }
    return { allowed: false, axis, reason, retryAfterMs };
  }
}

/** What a record is about, as a reference rather than personal data. */
function targetOf(action: ProposedAction): string {
  if (action.casualty !== null) return `casualty:${action.casualty}`;
  if (action.incident !== null) return `incident:${action.incident}`;
  return `customer:${action.customer}`;
}
