/**
 * One thing the system can say, and what it costs to say it.
 *
 * A variant is copy with holes in it. The model writes the sentence; the holes are filled at send
 * time by a pure function. That split is not a convenience — it is what keeps a customer's name,
 * amount and link out of every prompt this system will ever send, and what makes the whole copy
 * library reviewable as a committed file rather than trusted as a stream of generated text.
 *
 * The greeting is deliberately not the model's to write. "Hi," reads as spam and "Hi Rohit," does
 * not, but "Hi ," reads as broken, and the branch between them is exactly the kind of thing that
 * belongs in code with a test on it rather than in a sentence a model produced at three in the
 * morning. The model writes the body.
 */

import { createHash } from "node:crypto";
import {
  type CopyVariables,
  formatINR,
  LANGUAGE_SPECS,
  type Language,
  type Paise,
  paise,
  SEGMENT_LIMITS,
  type SmsCost,
  smsCost,
} from "@kairos/domain";
import type { ContactChannel, CopySegment } from "./segment.js";

/** The holes a variant may contain. Anything else is a rejection — see {@link file://./gauntlet.ts}. */
export const PLACEHOLDERS = ["amount", "link", "institution"] as const;

export type Placeholder = (typeof PLACEHOLDERS)[number];

export interface CopyVariant {
  /**
   * Stable across regenerations of unchanged copy, and different the moment the text changes.
   *
   * Derived from the segment and a hash of the text rather than from a position in a list, because
   * the exploration bandit accumulates a conversion rate against this id. An id keyed on position
   * would silently attach one sentence's measured performance to a different sentence the next time
   * the library was rebuilt; an id keyed on the text starts a new arm, which is the honest thing to
   * do when the copy has changed.
   */
  readonly id: string;
  readonly segment: string;
  readonly body: string;
  /** Email only. `null` for SMS and WhatsApp, and the gauntlet enforces both directions. */
  readonly subject: string | null;
  /** Segments a typical customer's message costs. What the copy was written to fit. */
  readonly typicalSegments: number;
  /**
   * Segments the most expensive customer's message costs. What Terminus must reserve.
   *
   * Higher than {@link typicalSegments} for a reason that is a fact about customers rather than
   * about copy: a message is composed with a customer's own name in it, and a customer is free to
   * be called रोहित. One Devanagari character moves an otherwise Latin message to UCS-2 and cuts
   * its capacity from 160 characters to 70.
   *
   * So copy is *written* to the typical budget and *priced* at the worst case. That is not a
   * compromise between the two, it is what reserve-then-reconcile is for: writing to the worst case
   * would throw away the shorter language's advantage on the great majority of customers who do not
   * trigger it.
   */
  readonly worstCaseSegments: number;
}

/**
 * The most expensive customer this copy could be sent to.
 *
 * Not a hypothetical. A long name in a script that forces UCS-2, an amount wide enough to carry
 * lakh-level digit grouping, a link at its full length, and an institution with a long name. Every
 * field is chosen to be the worst realistic case rather than the worst imaginable one — a bound
 * nobody could hit is a bound that prices every message out of existence.
 */
export interface WorstCase {
  readonly firstName: string;
  readonly amount: Paise;
  readonly link: string;
  readonly institution: string;
}

export const DEFAULT_WORST_CASE: WorstCase = {
  firstName: "प्रियदर्शिनी",
  amount: paise(9_99_999_00),
  link: "https://rzp.io/i/XXXXXXXX",
  institution: "Kotak Mahindra Bank",
};

/**
 * How a message opens, in each language.
 *
 * Written here rather than generated, because the greeting is the one part of a message where
 * getting the register wrong is unrecoverable and the cost of a human writing four short strings is
 * four short strings.
 */
const GREETINGS: Readonly<
  Record<Language, { readonly named: string; readonly anonymous: string }>
> = {
  en: { named: "Hi {name}, ", anonymous: "Hi, " },
  hi: { named: "नमस्ते {name}, ", anonymous: "नमस्ते, " },
  mr: { named: "नमस्कार {name}, ", anonymous: "नमस्कार, " },
  ta: { named: "வணக்கம் {name}, ", anonymous: "வணக்கம், " },
};

/** What a message calls a bank it cannot name. */
const GENERIC_INSTITUTION: Readonly<Record<Language, string>> = {
  en: "bank",
  hi: "बैंक",
  mr: "बँक",
  ta: "வங்கி",
};

/**
 * Whether the rupee sign is free here.
 *
 * `formatINR` renders U+20B9, which is not in the GSM-7 alphabet, and one of them moves an entire
 * SMS to UCS-2 — which is why the template system writes `Rs.` instead and why that is worth two
 * thirds of the price of every message.
 *
 * The saving only exists where there was something to save. A Hindi SMS is UCS-2 whatever it
 * contains, and WhatsApp and email have no seven-bit alphabet to fall out of, so in three of the
 * four cases the sign costs nothing and writing `Rs.` would be a needless anglicism in somebody
 * else's language.
 */
function rupeeSignIsFree(channel: ContactChannel, language: Language): boolean {
  return channel !== "contact-sms" || !LANGUAGE_SPECS[language].gsm7;
}

function money(amount: Paise, channel: ContactChannel, language: Language): string {
  const formatted = formatINR(amount);
  return rupeeSignIsFree(channel, language) ? formatted : formatted.replace("₹", "Rs. ");
}

export interface RenderedMessage {
  readonly subject: string | null;
  readonly text: string;
  readonly cost: SmsCost;
}

/**
 * Fill a variant's holes.
 *
 * Pure, total, and the only place customer data meets generated text. Every substitution is a
 * value the caller already held; nothing here can reach for a field it was not given.
 */
export function render(
  variant: CopyVariant,
  segment: CopySegment,
  variables: CopyVariables,
): RenderedMessage {
  const { language, channel } = segment;
  const greeting = GREETINGS[language];
  const opening =
    variables.firstName === null
      ? greeting.anonymous
      : greeting.named.replace("{name}", variables.firstName);

  const body = variant.body
    .replaceAll("{amount}", money(variables.amount, channel, language))
    .replaceAll("{link}", variables.link)
    .replaceAll("{institution}", variables.institution ?? GENERIC_INSTITUTION[language]);

  const text = `${opening}${body}`;
  return { subject: variant.subject, text, cost: smsCost(text) };
}

/** A typical customer: a Latin name, a modest amount, a short bank, a real link. */
const TYPICAL: CopyVariables = {
  firstName: "Rohit",
  amount: paise(1_245_00),
  link: "https://rzp.io/i/aB3xQ",
  institution: "HDFC",
};

export interface BodyBudget {
  /**
   * Characters the template may occupy, counting `{amount}` and `{link}` as the eight and six
   * characters they are written as.
   *
   * Directly checkable by whoever is writing: no subtraction, no knowledge of what a Razorpay short
   * link is, no arithmetic on a greeting nobody has seen. That is the whole point of the number.
   */
  readonly characters: number;
  /** The greeting, which is written by code and paid for before any copy. */
  readonly greeting: number;
  /** Billable units the whole message may reach. */
  readonly capacity: number;
  /** What each hole costs *beyond* its written form, once filled with a typical customer's values. */
  readonly placeholders: Readonly<Record<Placeholder, number>>;
}

/**
 * How much room the copy actually has, once everything else in the message is paid for.
 *
 * The function this package was missing, and its absence was a real defect rather than an omission:
 * the prompt used to state the *segment* capacity and add "including the greeting that will be added
 * before your text and the values that replace the placeholders", which asks a model to subtract
 * four numbers it was never given. It cannot know that the Hindi greeting is fourteen characters or
 * that a Razorpay short link is twenty-two. So it guessed, and it guessed high — eleven per cent of
 * the first recorded batch survived the gauntlet, almost all of the rest rejected for length.
 *
 * ## What the arithmetic shows
 *
 * Stating the real number exposes something worth knowing, which the old prompt hid. For a Hindi
 * SMS at one segment: seventy units of capacity, less a fourteen-unit greeting, a twenty-two-unit
 * link and a nine-unit amount, leaves **about twenty-five characters of Hindi**. That is not a
 * message a better prompt can fit into — it is two words. A single-segment recovery SMS in an Indic
 * script is not a demanding target, it is an impossible one, and the honest response is to let the
 * caller buy a second segment rather than to keep asking for the impossible and calling the refusals
 * a fallback rate.
 *
 * Which is a cost, stated plainly: **multilingual SMS recovery costs twice as much per message
 * before anybody writes a word.** Whether the extra readability pays for the extra segment is a
 * question for the benchmark, not for this function.
 */
/** Every hole, so the encoding is measured on a message that carries what will really be sent. */
const HOLES = "{amount}{link}{institution}";

export function bodyBudget(
  segment: CopySegment,
  maxSegments: number,
  typical: CopyVariables = TYPICAL,
): BodyBudget {
  const empty: CopyVariant = {
    id: "",
    segment: "",
    body: "",
    subject: null,
    typicalSegments: 0,
    worstCaseSegments: 0,
  };

  const greeting = render(empty, segment, typical).cost.units;

  // The encoding is decided by the *whole* message, so it has to be measured on a message that has
  // the substituted values in it. Measuring the greeting alone was a real defect and it had a real
  // victim: on WhatsApp the rupee sign is free, so `money` writes ₹ (U+20B9) — which is not in
  // GSM-7 — and an English WhatsApp message is therefore UCS-2 with 134 units, not GSM-7 with 306.
  // The budget said 279 characters, the truth was 103, and every English WhatsApp variant in the
  // first full run was rejected for a length the prompt had told the model it had.
  const filled = render({ ...empty, body: HOLES }, segment, typical);
  const [single, multi] =
    filled.cost.encoding === "gsm-7"
      ? [SEGMENT_LIMITS.gsmSingle, SEGMENT_LIMITS.gsmMulti]
      : [SEGMENT_LIMITS.ucsSingle, SEGMENT_LIMITS.ucsMulti];
  const capacity = maxSegments <= 1 ? single : maxSegments * multi;

  // What a hole costs *beyond* the characters somebody types to write it. `{link}` is six
  // characters on the page and twenty-two on the wire, so it carries a surcharge of sixteen;
  // `{institution}` is thirteen characters and usually expands to four, so it carries none.
  const surcharge = (placeholder: Placeholder, filled: string): number =>
    Math.max(0, smsCost(filled).units - (placeholder.length + 2));

  const placeholders = {
    amount: surcharge("amount", money(typical.amount, segment.channel, segment.language)),
    link: surcharge("link", typical.link),
    institution: surcharge(
      "institution",
      typical.institution ?? GENERIC_INSTITUTION[segment.language],
    ),
  };

  // `{amount}` and `{link}` are both mandatory, so their surcharges are certain and are taken out
  // here rather than left as arithmetic for the writer. `{institution}` is optional and its
  // surcharge is zero in every case measured, so it is only ever mentioned.
  const mandatory = placeholders.amount + placeholders.link;

  return {
    characters: Math.max(0, capacity - greeting - mandatory),
    greeting,
    capacity,
    placeholders,
  };
}

/** What this copy costs a typical customer and the most expensive one, in segments. */
export function measure(
  body: string,
  subject: string | null,
  segment: CopySegment,
  worst: WorstCase = DEFAULT_WORST_CASE,
): { typicalSegments: number; worstCaseSegments: number } {
  const draft: CopyVariant = {
    id: "",
    segment: "",
    body,
    subject,
    typicalSegments: 0,
    worstCaseSegments: 0,
  };

  const worstVariables: CopyVariables = {
    firstName: worst.firstName,
    amount: worst.amount,
    link: worst.link,
    institution: worst.institution,
  };

  return {
    typicalSegments: render(draft, segment, TYPICAL).cost.segments,
    worstCaseSegments: render(draft, segment, worstVariables).cost.segments,
  };
}

/**
 * Build a variant from text a model produced, having already been validated.
 *
 * Not exported as a way to bypass the gauntlet: {@link file://./gauntlet.ts} calls this at the end
 * of a successful validation, which is the only path by which text becomes a variant.
 */
export function makeVariant(
  segment: CopySegment,
  segmentKey: string,
  body: string,
  subject: string | null,
  worst: WorstCase = DEFAULT_WORST_CASE,
): CopyVariant {
  const { typicalSegments, worstCaseSegments } = measure(body, subject, segment, worst);
  const digest = createHash("sha256")
    .update(`${subject ?? ""} ${body}`, "utf8")
    .digest("hex")
    .slice(0, 8);

  return {
    id: `${segmentKey}#${digest}`,
    segment: segmentKey,
    body,
    subject,
    typicalSegments,
    worstCaseSegments,
  };
}
