/**
 * What a recovery message is allowed to know about the person receiving it.
 *
 * Four values and nothing else. This lives in the domain rather than beside either of the two
 * things that render it, because it is one boundary and it must have one definition: the
 * hand-written templates in the Razorpay adapter and the model-generated library in `@kairos/reason`
 * fill exactly these holes, and a field added to one copy of this type and not the other would be a
 * PII boundary that had quietly moved in one place only.
 */

import type { Paise } from "./money.js";

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
