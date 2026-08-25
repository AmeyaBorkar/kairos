import type { CasualtyKind, FailureDetail, RecoverabilityClass } from "@kairos/domain";

/**
 * Where a classification came from, and therefore how much weight it deserves.
 *
 * Not decoration. The source is written to the ledger so a merchant can ask "how many of these
 * decisions did a language model make?" and get a number, and it drives the confidence discount
 * that flows into the expected-value gate.
 */
export type ClassificationSource =
  /** An exact rule matched Razorpay's reason. The classification is as good as the rule table. */
  | "table"
  /** No reason matched, but source and step say who broke it and where. Weaker, and honestly so. */
  | "structure"
  /** A language model classified a residual the table could not. Weaker still, and never gates money. */
  | "model"
  /** Nothing matched at all. */
  | "default";

export interface Classification {
  readonly recoverability: RecoverabilityClass;
  /** The rule that fired, by name. Written verbatim to the ledger — this is the *why*. */
  readonly rule: string;
  readonly source: ClassificationSource;
  /**
   * How much to trust it, in `(0, 1]`.
   *
   * Consumed by the recovery-probability model, which shrinks toward the population base rate in
   * proportion to `1 - confidence`. That is the whole mechanism by which uncertainty about *what
   * went wrong* becomes caution about *what to spend*: a guess and a certainty produce different
   * expected values through the same gate, with no special case anywhere.
   */
  readonly confidence: number;
}

interface Rule {
  readonly id: string;
  /** Exact match against the normalised reason. */
  readonly reason?: string;
  /** Substring match against the normalised reason, for families Razorpay spells several ways. */
  readonly contains?: string;
  readonly source?: string;
  readonly step?: string;
  readonly recoverability: RecoverabilityClass;
  readonly confidence: number;
}

/**
 * Razorpay spells the same cause more than one way.
 *
 * `payment_failed_due_to_insufficient_funds` and `insufficient_funds` are the same event reported
 * by different parts of their stack, and a table keyed on the literal strings would classify one
 * and miss the other. Stripping the prefix and lower-casing costs nothing and removes a whole class
 * of silent misclassification.
 */
function normalise(reason: string): string {
  return reason
    .trim()
    .toLowerCase()
    .replace(/^payment_failed_due_to_/, "")
    .replace(/^payment_failed_because_/, "")
    .replace(/\s+/g, "_");
}

/**
 * The rule table, in precedence order. First match wins.
 *
 * Ordered most specific to least, and grouped by the answer rather than by the cause, because the
 * answer is what the table is for. A reason that appears under two headings would be a bug, and
 * a test asserts every rule id is unique and every rule is reachable.
 *
 * Confidence is 1 for an exact reason match and lower for the structural fallbacks below, which
 * reason from `source` and `step` alone. That is not false modesty: `source: bank` at
 * `payment_authorization` really does mean the customer did not cause it, but it does not
 * distinguish a bank that timed out from a bank that blocked the account, and those want opposite
 * treatments.
 */
const RULES: readonly Rule[] = [
  // ── dead ──────────────────────────────────────────────────────────────────────────────────────
  // Nothing about the future changes these. Chasing costs money and produces a message that either
  // alarms an innocent customer or tips off a guilty one.
  { id: "card-lost-or-stolen", contains: "lost_or_stolen", recoverability: "dead", confidence: 1 },
  { id: "card-stolen", contains: "stolen_card", recoverability: "dead", confidence: 1 },
  { id: "account-blocked", contains: "account_blocked", recoverability: "dead", confidence: 1 },
  { id: "account-frozen", contains: "account_frozen", recoverability: "dead", confidence: 1 },
  { id: "risk-blocked", contains: "risk", recoverability: "dead", confidence: 1 },
  { id: "fraud-suspected", contains: "fraud", recoverability: "dead", confidence: 1 },
  {
    id: "international-not-allowed",
    contains: "international_transaction_not_allowed",
    recoverability: "dead",
    confidence: 1,
  },
  {
    id: "card-not-enabled-online",
    contains: "not_enabled_for_online",
    recoverability: "dead",
    confidence: 1,
  },
  {
    id: "duplicate-transaction",
    contains: "duplicate",
    recoverability: "dead",
    confidence: 1,
  },

  // ── customer-action ───────────────────────────────────────────────────────────────────────────
  // The customer has to change something before any payment can succeed. Worth a message, and the
  // message can say precisely what to do, which is what makes these the most valuable contacts
  // Kairos sends.
  {
    id: "card-expired",
    contains: "card_expired",
    recoverability: "customer-action",
    confidence: 1,
  },
  {
    id: "card-invalid",
    contains: "invalid_card",
    recoverability: "customer-action",
    confidence: 1,
  },
  { id: "vpa-invalid", contains: "invalid_vpa", recoverability: "customer-action", confidence: 1 },
  {
    id: "account-invalid",
    contains: "invalid_account",
    recoverability: "customer-action",
    confidence: 1,
  },
  {
    id: "mandate-revoked",
    contains: "mandate",
    recoverability: "customer-action",
    confidence: 1,
  },
  {
    id: "emi-not-available",
    contains: "emi_not_available",
    recoverability: "customer-action",
    confidence: 1,
  },
  {
    id: "card-not-supported",
    contains: "card_not_supported",
    recoverability: "customer-action",
    confidence: 1,
  },

  // ── timed ─────────────────────────────────────────────────────────────────────────────────────
  // The instrument works and the money is not there yet. These are the only failures where waiting
  // is itself the strategy, and the only place a salary-cycle prior earns its keep.
  {
    id: "insufficient-funds",
    contains: "insufficient_funds",
    recoverability: "timed",
    confidence: 1,
  },
  {
    id: "insufficient-balance",
    contains: "insufficient_balance",
    recoverability: "timed",
    confidence: 1,
  },
  {
    id: "insufficient-wallet-balance",
    contains: "insufficient_wallet",
    recoverability: "timed",
    confidence: 1,
  },
  {
    id: "credit-limit-exhausted",
    contains: "credit_limit",
    recoverability: "timed",
    confidence: 1,
  },
  {
    id: "limit-exceeded",
    contains: "limit_exceeded",
    recoverability: "timed",
    confidence: 1,
  },

  // ── customer-retry ────────────────────────────────────────────────────────────────────────────
  // Nothing is broken and nothing needs fixing. One nudge, and only one: a person who cancelled a
  // payment and then receives three reminders has been harassed, not recovered.
  {
    id: "cancelled-by-user",
    contains: "cancelled_by_user",
    recoverability: "customer-retry",
    confidence: 1,
  },
  {
    id: "cancelled",
    contains: "payment_cancelled",
    recoverability: "customer-retry",
    confidence: 1,
  },
  {
    id: "incorrect-upi-pin",
    contains: "incorrect_upi_pin",
    recoverability: "customer-retry",
    confidence: 1,
  },
  {
    id: "incorrect-otp",
    contains: "incorrect_otp",
    recoverability: "customer-retry",
    confidence: 1,
  },
  {
    id: "authentication-failed",
    contains: "authentication_failed",
    recoverability: "customer-retry",
    confidence: 1,
  },
  {
    id: "collect-request-expired",
    contains: "collect_request_expired",
    recoverability: "customer-retry",
    confidence: 1,
  },
  {
    id: "customer-dropped-off",
    contains: "dropped_off",
    recoverability: "customer-retry",
    confidence: 1,
  },

  // ── transient ─────────────────────────────────────────────────────────────────────────────────
  // Something upstream broke. These are the casualties the detector already knows about, and the
  // only ones where "wait for the rail to heal" is a real strategy rather than a hope.
  {
    id: "issuer-unavailable",
    contains: "issuer_not_available",
    recoverability: "transient",
    confidence: 1,
  },
  {
    id: "bank-server-down",
    contains: "bank_server_down",
    recoverability: "transient",
    confidence: 1,
  },
  {
    id: "bank-not-responding",
    contains: "not_responding",
    recoverability: "transient",
    confidence: 1,
  },
  { id: "timed-out", contains: "timed_out", recoverability: "transient", confidence: 1 },
  { id: "timeout", contains: "timeout", recoverability: "transient", confidence: 1 },
  {
    id: "gateway-technical-error",
    contains: "technical_error",
    recoverability: "transient",
    confidence: 1,
  },
  {
    id: "auth-service-unavailable",
    contains: "service_unavailable",
    recoverability: "transient",
    confidence: 1,
  },
  { id: "npci-unavailable", contains: "npci", recoverability: "transient", confidence: 1 },
  { id: "server-error", contains: "server_error", recoverability: "transient", confidence: 1 },

  // ── the ambiguous one ─────────────────────────────────────────────────────────────────────────
  // A bare "declined by bank" carries almost no information: it covers a risk decision, a velocity
  // limit and a transient authorisation failure with the same string. It sits here, after every
  // specific rule, and is classified as the thing a bank decline most often is — a soft decline
  // that may well succeed later — at reduced confidence, so the expected-value gate prices the
  // doubt rather than the table pretending it away.
  {
    id: "declined-by-bank",
    contains: "declined",
    recoverability: "transient",
    confidence: 0.5,
  },

  // ── structural fallbacks ──────────────────────────────────────────────────────────────────────
  // Reached when the reason is one nobody has mapped — a new Razorpay code, or a gateway string
  // that changed. `source` and `step` still say who broke it and where, and that is real evidence.
  // These are why the table degrades rather than collapsing when Razorpay adds an error tomorrow.
  {
    id: "structural-bank-authorization",
    source: "bank",
    step: "payment_authorization",
    recoverability: "transient",
    confidence: 0.6,
  },
  {
    id: "structural-issuer",
    source: "issuer",
    recoverability: "transient",
    confidence: 0.6,
  },
  { id: "structural-gateway", source: "gateway", recoverability: "transient", confidence: 0.6 },
  { id: "structural-network", source: "network", recoverability: "transient", confidence: 0.6 },
  {
    id: "structural-customer-initiation",
    source: "customer",
    step: "payment_initiation",
    recoverability: "customer-action",
    confidence: 0.5,
  },
  {
    id: "structural-customer-authentication",
    source: "customer",
    step: "payment_authentication",
    recoverability: "customer-retry",
    confidence: 0.5,
  },
];

/** Structural rules are identified by their id, so the two cannot drift apart. */
const STRUCTURAL_PREFIX = "structural-";

/** Rules that match on the reason string. Everything else is a structural fallback. */
function matchesReason(rule: Rule, reason: string): boolean {
  if (rule.reason !== undefined) return reason === rule.reason;
  if (rule.contains !== undefined) return reason.includes(rule.contains);
  return false;
}

function matchesStructure(rule: Rule, failure: FailureDetail): boolean {
  if (rule.source === undefined && rule.step === undefined) return false;
  if (rule.source !== undefined && rule.source !== failure.source.toLowerCase()) return false;
  if (rule.step !== undefined && rule.step !== failure.step.toLowerCase()) return false;
  return true;
}

const UNCLASSIFIED: Classification = {
  recoverability: "unknown",
  rule: "unclassified",
  source: "default",
  confidence: 0.25,
};

/**
 * Decide what can be done about a failure, deterministically.
 *
 * **No model gets a vote here.** Where the taxonomy is unambiguous the answer is a table lookup,
 * because a money decision that depends on a model is a money decision that depends on a prompt
 * (P1). The model's only role is on the residual this function reports as `unknown`, and even there
 * it is validated into the same closed enum and discounted for having been guessed.
 *
 * A casualty with no failure to read is not a gap in the table — an abandoned checkout and an
 * overdue invoice are perfectly well understood, they simply have no error to describe.
 */
export function classify(
  failure: FailureDetail | null,
  kind: CasualtyKind = "payment-failed",
): Classification {
  if (failure === null) {
    return kind === "checkout-abandoned"
      ? {
          recoverability: "customer-retry",
          rule: "checkout-abandoned",
          source: "table",
          confidence: 1,
        }
      : {
          recoverability: "customer-action",
          rule: "invoice-overdue",
          source: "table",
          confidence: 1,
        };
  }

  const reason = normalise(failure.reason);

  for (const rule of RULES) {
    const matched =
      rule.reason !== undefined || rule.contains !== undefined
        ? matchesReason(rule, reason)
        : matchesStructure(rule, failure);
    if (!matched) continue;
    return {
      recoverability: rule.recoverability,
      rule: rule.id,
      source: rule.id.startsWith(STRUCTURAL_PREFIX) ? "structure" : "table",
      confidence: rule.confidence,
    };
  }

  return UNCLASSIFIED;
}

/** Whether this classification is one the residual path is allowed to reconsider. */
export function isResidual(classification: Classification): boolean {
  return classification.source === "default";
}

/** Every rule id in the table, in precedence order. Exposed so a test can prove each is reachable. */
export function ruleIds(): readonly string[] {
  return RULES.map((r) => r.id);
}
