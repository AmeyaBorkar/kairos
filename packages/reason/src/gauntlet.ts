/**
 * Everything a model writes has to get past this before it can become a message.
 *
 * The premise is that generated text is untrusted output, in the same way that a gateway's error
 * description is untrusted input. Not because a model is malicious, but because the failure modes
 * are ordinary and the consequences are not: a hallucinated rupee figure in an SMS is a false
 * statement about somebody's money sent under the merchant's own sender id, and a stray URL is a
 * phishing link the merchant paid to deliver.
 *
 * So the boundary is a whitelist, and every rejection has a name. The names matter as much as the
 * rejections: `reason.fallbackRate` is a gated metric, and a rate that climbs is only actionable if
 * the report can say the model started writing URLs rather than merely that it started failing.
 *
 * **Nothing here is a substitute for the ones that come after it.** A variant that passes still has
 * to clear the expected-value gate, the contact cap, the quiet-hours window and the campaign budget
 * before a single message is sent, and none of those can be reached from here. This is the check
 * that keeps a prompt injection a copy-quality problem; the kernel is what keeps it from being a
 * solvency one.
 */

import { isInScript } from "@kairos/domain";
import type { CopySegment } from "./segment.js";
import { type CopyVariant, makeVariant, measure, PLACEHOLDERS, type WorstCase } from "./variant.js";

export type RejectionCode =
  /** Nothing, whitespace, or too short to carry a sentence. */
  | "empty"
  /** A `{hole}` that render would not fill, and would therefore send literally. */
  | "unknown-placeholder"
  /** A hole the copy needs and does not have — most often the link. */
  | "missing-placeholder"
  /** A rupee figure the model invented rather than deferring to `{amount}`. */
  | "invented-amount"
  /** A digit run long enough to be a phone number, card number or reference. */
  | "long-number"
  /** A link the model wrote itself. */
  | "unexpected-url"
  /** Not written in the script the language uses. */
  | "wrong-script"
  /** Costs more than the segment budget allows even for a typical customer. */
  | "too-long"
  /** More than the mandate's ceiling would ever reserve. */
  | "exceeds-reservation"
  /** A subject line on an SMS, or the absence of one on an email. */
  | "subject-mismatch"
  /** A promise the merchant has not authorised, or a threat. */
  | "prohibited-phrase"
  /** Newlines beyond what the channel should carry. */
  | "layout";

export interface Rejection {
  readonly code: RejectionCode;
  /** One line, quoting the offending fragment where there is one. Goes into the report. */
  readonly detail: string;
}

export type Verdict =
  | { readonly ok: true; readonly variant: CopyVariant }
  | { readonly ok: false; readonly rejections: readonly Rejection[] };

export interface GauntletOptions {
  /**
   * Segments a typical customer's message may cost.
   *
   * One, for SMS, in every language. A two-segment recovery message doubles the postage on the
   * largest line item the arm has, and a model told it has room for two will use two.
   */
  readonly maxTypicalSegments: number;
  /**
   * Segments the worst case may reach, from the mandate's `maxActionCostPaise`.
   *
   * The number Terminus would have to reserve. Copy that could cost more than the kernel is willing
   * to authorise is not copy that can be sent, however good it is.
   */
  readonly maxWorstCaseSegments: number;
  readonly worstCase?: WorstCase;
  /** Phrases the merchant has not authorised anyone to say on their behalf. */
  readonly prohibited: readonly string[];
}

/**
 * Things a recovery message must never say.
 *
 * Two kinds, and both have cost somebody a regulator's attention. The first is a promise the
 * merchant did not make — a refund, a guarantee, a discount invented to close a sale. The second is
 * manufactured urgency, which is the house style of every payment scam in India and therefore the
 * fastest way to teach customers to ignore a merchant's real messages.
 */
export const DEFAULT_PROHIBITED: readonly string[] = [
  "guarantee",
  "guaranteed",
  "refund",
  "cashback",
  "free gift",
  "account will be closed",
  "account will be blocked",
  "last chance",
  "act now",
  "urgent",
  "immediately or",
  // Asking for a credential, not mentioning one. "Your bank will send you an OTP" is the copy that
  // earns the guided-message uplift on a card retry, and banning the word outright would forbid the
  // most useful sentence the system can send in order to prevent one nobody writes.
  "share your",
  "send us your",
  "tell us your",
  "confirm your otp",
  "enter your password",
  "password",
];

const PLACEHOLDER_PATTERN = /\{([a-zA-Z]*)\}/g;
const URL_PATTERN = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|in|io|co|net|org|me)\b)/i;
const LONG_NUMBER = /\d{6,}/;

/**
 * A currency figure written into the text rather than deferred to `{amount}`.
 *
 * Targets the actual risk instead of banning digits outright. "within 24 hours" and "3 days" are
 * ordinary recovery copy and rejecting them would leave the model unable to write a deadline; a
 * number next to a currency marker is a claim about somebody's money, and the system already has a
 * placeholder that carries the true one.
 */
const INVENTED_AMOUNT = /(?:₹|rs\.?|inr)\s*[\d,]+|[\d,]+\s*(?:₹|rupees?|rs\.?|inr|रुपये|रुपए|ரூபாய்)/i;

/** The shortest text that could plausibly be a message rather than a fragment. */
const MIN_BODY_LENGTH = 20;

export function validate(
  body: string,
  subject: string | null,
  segment: CopySegment,
  segmentKey: string,
  options: GauntletOptions,
): Verdict {
  const rejections: Rejection[] = [];
  const reject = (code: RejectionCode, detail: string): void =>
    void rejections.push({ code, detail });

  const trimmed = body.trim();

  if (trimmed.length < MIN_BODY_LENGTH) {
    reject("empty", `body is ${trimmed.length} characters, under the ${MIN_BODY_LENGTH} minimum`);
    // Everything below reads the text. There is nothing to read.
    return { ok: false, rejections };
  }

  // ── Placeholders ────────────────────────────────────────────────────────────────────────────
  const found = new Set<string>();
  for (const match of trimmed.matchAll(PLACEHOLDER_PATTERN)) {
    const name = match[1] ?? "";
    found.add(name);
    if (!(PLACEHOLDERS as readonly string[]).includes(name)) {
      reject("unknown-placeholder", `{${name}} is not a placeholder render would fill`);
    }
  }
  if (!found.has("link")) {
    reject("missing-placeholder", "no {link}: a recovery message with nothing to tap is not one");
  }
  if (!found.has("amount")) {
    reject("missing-placeholder", "no {amount}: an unspecified sum reads as a scam");
  }

  // ── Invented facts ──────────────────────────────────────────────────────────────────────────
  const withoutPlaceholders = trimmed.replace(PLACEHOLDER_PATTERN, " ");
  const invented = INVENTED_AMOUNT.exec(withoutPlaceholders);
  if (invented !== null) {
    reject("invented-amount", `wrote a currency figure itself: "${invented[0]}"`);
  }
  const longNumber = LONG_NUMBER.exec(withoutPlaceholders);
  if (longNumber !== null) {
    reject("long-number", `wrote a ${longNumber[0].length}-digit number: "${longNumber[0]}"`);
  }
  const url = URL_PATTERN.exec(withoutPlaceholders);
  if (url !== null) {
    reject("unexpected-url", `wrote a link of its own: "${url[0]}"`);
  }

  // ── Language ────────────────────────────────────────────────────────────────────────────────
  if (!isInScript(trimmed, segment.language)) {
    reject("wrong-script", `not written in the script ${segment.language} uses`);
  }

  const lowered = withoutPlaceholders.toLowerCase();
  for (const phrase of options.prohibited) {
    if (lowered.includes(phrase.toLowerCase())) {
      reject("prohibited-phrase", `contains "${phrase}"`);
    }
  }

  // ── Shape ───────────────────────────────────────────────────────────────────────────────────
  const isEmail = segment.channel === "contact-email";
  if (isEmail && (subject === null || subject.trim().length === 0)) {
    reject("subject-mismatch", "an email needs a subject line");
  }
  if (!isEmail && subject !== null) {
    reject("subject-mismatch", `a ${segment.channel} message has nowhere to put a subject`);
  }

  const newlines = (trimmed.match(/\n/g) ?? []).length;
  const maxNewlines = isEmail ? 8 : 1;
  if (newlines > maxNewlines) {
    reject("layout", `${newlines} line breaks, more than ${maxNewlines} for ${segment.channel}`);
  }

  // ── Price ───────────────────────────────────────────────────────────────────────────────────
  //
  // Email is billed per message rather than per segment, so a segment budget would be a limit on
  // nothing. It still gets every check above: the reason not to invent a rupee figure has nothing
  // to do with what it costs to send.
  if (!isEmail) {
    const priced = measure(trimmed, subject, segment, options.worstCase);
    if (priced.typicalSegments > options.maxTypicalSegments) {
      reject(
        "too-long",
        `${priced.typicalSegments} segments for a typical customer, over ${options.maxTypicalSegments}`,
      );
    }
    if (priced.worstCaseSegments > options.maxWorstCaseSegments) {
      reject(
        "exceeds-reservation",
        `${priced.worstCaseSegments} segments at worst, over the ${options.maxWorstCaseSegments} the mandate would reserve`,
      );
    }
  }

  if (rejections.length > 0) return { ok: false, rejections };
  return {
    ok: true,
    variant: makeVariant(segment, segmentKey, trimmed, subject, options.worstCase),
  };
}
