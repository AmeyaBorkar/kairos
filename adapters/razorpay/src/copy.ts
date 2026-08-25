import { formatINR, type Paise, type RecoverabilityClass } from "@kairos/domain";
import { type SmsCost, smsCost } from "./segments.js";

/**
 * What a recovery message is allowed to say, and what it is allowed to know.
 *
 * Four variables and nothing else. Not a restriction imposed on the copy for tidiness — it is the
 * PII boundary from §13 made structural. A template that cannot reference a phone number cannot
 * leak one, and a composer that takes this struct rather than a casualty cannot reach for a field
 * that seemed useful at the time.
 *
 * The first name is the one concession, because "Hi," reads as spam and "Hi Rohit," does not.
 */
export interface CopyVariables {
  /** The customer's first name, or `null` to address them impersonally. */
  readonly firstName: string | null;
  readonly amount: Paise;
  /** A short, single-use URL back to the payment. Never a raw order id. */
  readonly link: string;
  /** The institution, for a message that names it. Already translated from a slice. */
  readonly institution: string | null;
}

export interface ComposedMessage {
  readonly text: string;
  /** Whether the message tells the customer specifically what to do, or merely that something broke. */
  readonly guided: boolean;
  readonly cost: SmsCost;
}

/**
 * The deterministic copy, one template per class.
 *
 * These are the fallback the architecture promises when a model is slow, unavailable, or returns
 * something that does not validate — and they are also what ships by default, because a template
 * that has been read by a human is worth more than a sentence generated at three in the morning.
 *
 * `guided` marks the templates that tell the customer what is actually wrong. The distinction is
 * worth its own field because it is worth real money: a message naming the problem recovers several
 * times what a message reporting a failure does, which is the second way classification pays for
 * itself.
 */
const TEMPLATES: Readonly<Record<RecoverabilityClass, (v: CopyVariables) => ComposedMessage>> = {
  transient: (v) =>
    build(
      `${greeting(v)}the ${v.institution ?? "bank"} issue that stopped your ${rupeesAscii(v.amount)} payment is fixed. Finish it here: ${v.link}`,
      true,
    ),

  timed: (v) =>
    build(
      `${greeting(v)}your ${rupeesAscii(v.amount)} payment didn't complete. Whenever you're ready: ${v.link}`,
      false,
    ),

  "customer-action": (v) =>
    build(
      `${greeting(v)}your saved payment method has expired, so your ${rupeesAscii(v.amount)} payment couldn't go through. Update it here: ${v.link}`,
      true,
    ),

  "customer-retry": (v) =>
    build(
      `${greeting(v)}your ${rupeesAscii(v.amount)} payment wasn't completed. Pick up where you left off: ${v.link}`,
      false,
    ),

  unknown: (v) =>
    build(
      `${greeting(v)}your ${rupeesAscii(v.amount)} payment didn't go through. Try again here: ${v.link}`,
      false,
    ),

  // Never sent. Present so the table is total and a future class cannot silently fall through to
  // an empty message — a message with no text still costs a segment and still annoys somebody.
  dead: (v) =>
    build(`${greeting(v)}your ${rupeesAscii(v.amount)} payment could not be completed.`, false),
};

/**
 * Rupees, written so an SMS can carry them at seven bits.
 *
 * `formatINR` renders a rupee sign, and U+20B9 is not in the GSM-7 alphabet. One of them moves the
 * entire message to UCS-2, cutting its capacity from 160 characters to 70 and taking a typical
 * recovery message from one segment to three. Writing `Rs.` instead is not a style preference: it
 * is a two-thirds saving on every SMS the system will ever send, and it is invisible until somebody
 * counts segments.
 *
 * The Indian digit grouping is kept, because that is what the number is supposed to look like to
 * the person reading it.
 */
export function rupeesAscii(amount: Paise): string {
  return formatINR(amount).replace("₹", "Rs. ");
}

function greeting(v: CopyVariables): string {
  return v.firstName === null ? "Hi, " : `Hi ${v.firstName}, `;
}

function build(text: string, guided: boolean): ComposedMessage {
  return { text, guided, cost: smsCost(text) };
}

/**
 * Compose the message for a casualty of this class.
 *
 * The composed text is what determines the price, and the price is therefore partly a fact about
 * the customer: **a template that costs one segment for "Rohit" costs three for "रोहित"**, because
 * one non-GSM character moves the whole message to UCS-2 and cuts its capacity from 160 characters
 * to 70. The merchant does not choose their customers' names, so the cost of a message genuinely
 * cannot be known before it is composed — which is precisely why Terminus reserves a ceiling and
 * reconciles against what actually happened rather than trusting an estimate.
 */
export function compose(
  recoverability: RecoverabilityClass,
  variables: CopyVariables,
): ComposedMessage {
  return TEMPLATES[recoverability](variables);
}

/**
 * Whether a name is safe to interpolate into a message.
 *
 * Untrusted input reaching a template is a smaller problem than untrusted input reaching a prompt,
 * but it is not nothing: a "name" containing a URL turns a legitimate message into a phishing
 * vector delivered over the merchant's own sender id. Reject rather than sanitise, and fall back to
 * addressing the customer impersonally, because a slightly colder message is a much better outcome
 * than a clever escaping bug.
 */
export function acceptableFirstName(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 24) return null;
  // Letters, marks and spaces from any script — Devanagari included, deliberately. What is excluded
  // is punctuation, digits and anything that could be read as a link or a control sequence.
  return /^[\p{L}\p{M}][\p{L}\p{M} '.-]*$/u.test(trimmed) ? trimmed : null;
}
