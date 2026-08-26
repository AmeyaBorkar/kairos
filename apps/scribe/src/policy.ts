/**
 * How much message each situation is allowed to buy, and what the answers have to clear.
 *
 * Two decisions, both economic rather than editorial, and both stated here rather than buried in a
 * prompt so that changing them is a reviewable diff with a number in it.
 *
 * ## An Indic SMS gets two segments. An English one gets one.
 *
 * Not a concession to a model that writes long. The arithmetic, from
 * `bodyBudget`:
 *
 * | language | 1 segment | 2 segments |
 * |----------|-----------|------------|
 * | English  | 116 characters of text | — |
 * | Hindi    | **25** | 89 |
 * | Marathi  | **24** | 88 |
 * | Tamil    | **24** | 88 |
 *
 * Twenty-five characters is two words. There is no prompt that fits a recovery message into it and
 * no model that could; the first recorded batch failed for length on every single Indic variant,
 * and it would have failed on copy written by a person too. UCS-2 carries 70 characters per segment
 * against GSM-7's 160, and the greeting, the link and the amount are charged before the first word.
 *
 * So the second segment is bought deliberately, and the cost is stated plainly: **a recovery SMS in
 * an Indic language costs twice what the English one costs, before anybody writes a word.** Whether
 * a message somebody can read is worth twice a message they cannot is exactly the question the
 * benchmark's fourth arm exists to answer — `scoreMessage` already prices both sides of it, since a
 * two-segment message loses the `concise` term and an unreadable one is halved outright.
 *
 * ## The worst case is derived, and it is three
 *
 * `maxWorstCaseSegments` is what Terminus would have to reserve. It is computed rather than chosen —
 * see {@link worstCaseSegmentsFor} — and it comes out at three for every language and every channel,
 * because the worst case combines four extremes that have nothing to do with the copy: a
 * twelve-character Devanagari first name, a lakh-scale amount, a full-length link, and
 * `Kotak Mahindra Bank`. One Devanagari character in the *name* moves an otherwise Latin English
 * message to UCS-2 and cuts its capacity from 160 to 70, so even English copy written to one segment
 * reserves three. Hard-coding two, which looks conservative, forbids all copy in every language;
 * that is what the first dry run discovered by rejecting sixteen of eighteen variants.
 */

import { LANGUAGE_SPECS, LANGUAGES, PAYMENT_METHODS } from "@kairos/domain";
import {
  bodyBudget,
  CONTACT_CHANNELS,
  type ContactChannel,
  type CopySegment,
  type Coverage,
  DEFAULT_PROHIBITED,
  type GauntletOptions,
  measure,
} from "@kairos/reason";

/**
 * The whole product's coverage: every language, every rail, every channel.
 *
 * A hundred and eighty segments, against 5,719 messages in a four-hour window — which is the
 * arithmetic the entire design rests on and the reason it fits a free tier at all.
 */
export const COVERAGE: Coverage = {
  languages: [...LANGUAGES],
  methods: [...PAYMENT_METHODS],
  channels: [...CONTACT_CHANNELS],
};

/** Where the committed library lives. At the repository root, because its diff is the review. */
export const LIBRARY_PATH = "data/copy-library.json";

/**
 * Which channel to write first, when the day's quota may not reach the end of the list.
 *
 * SMS before WhatsApp before email, because a run that stops halfway should stop having finished
 * the channel that carries the most messages and has the tightest budget — the one where a missing
 * segment costs the most and a hand-written template fits the worst. Ordering the work by what
 * survives an interruption is cheaper than making the interruption impossible.
 */
const CHANNEL_ORDER: readonly ContactChannel[] = [
  "contact-sms",
  "contact-whatsapp",
  "contact-email",
];

export function inWritingOrder(segments: readonly CopySegment[]): readonly CopySegment[] {
  return [...segments].sort(
    (a, b) => CHANNEL_ORDER.indexOf(a.channel) - CHANNEL_ORDER.indexOf(b.channel),
  );
}

/**
 * Segments a message may occupy for a typical customer.
 *
 * Email is not billed or read in segments, so it gets a nominal figure that the gauntlet never
 * applies — the channel rules in the prompt are what bound an email's length.
 */
export function segmentsFor(segment: CopySegment): number {
  if (segment.channel === "contact-email") return 1;
  // WhatsApp is billed per conversation rather than per segment, so the constraint is what somebody
  // will read on a phone rather than what it costs. Two, in every language, for that reason.
  if (segment.channel === "contact-whatsapp") return 2;
  return LANGUAGE_SPECS[segment.language].gsm7 ? 1 : 2;
}

/**
 * Segments the most expensive customer's message may occupy — what Terminus would have to reserve.
 *
 * Derived rather than chosen: take the longest template this segment's budget permits, render it
 * with every substituted value at its worst realistic extreme, and count. That is exactly the
 * number a mandate would have to authorise, and it moves on its own when a budget or a greeting
 * changes instead of waiting for somebody to notice.
 *
 * It comes out at {@link MAX_WORST_CASE_SEGMENTS} for every language and every channel, which is
 * the point: the worst case is dominated by the *values* — a twelve-character Devanagari first
 * name, a lakh-scale amount, a full-length link — rather than by the copy, and those are the same
 * whatever language the copy is in. Hard-coding two, which looks conservative, forbids all copy
 * everywhere. That is how the number was found.
 */
export function worstCaseSegmentsFor(segment: CopySegment): number {
  const budget = bodyBudget(segment, segmentsFor(segment));
  // The longest template the budget permits: both mandatory holes plus filler. `x` because it is
  // one unit in either encoding, so the filler measures length and nothing else.
  const holes = "{amount}{link}";
  const longest = holes + "x".repeat(Math.max(0, budget.characters - holes.length));
  return measure(longest, null, segment).worstCaseSegments;
}

/**
 * What that derivation comes out at today, so a change to it is visible rather than absorbed.
 *
 * Not used to compute anything — {@link worstCaseSegmentsFor} does that. It is here so a test can
 * assert the derived number, which makes an unexpected move in the greeting, the budget or the
 * worst case fail a build instead of quietly widening what the kernel is asked to reserve.
 */
export const MAX_WORST_CASE_SEGMENTS = 3;

/** How many alternatives each situation gets, for the exploration bandit to choose between. */
export const VARIANTS_PER_SEGMENT = 3;

/**
 * Classes where the message must not say why the payment failed.
 *
 * `timed` because the true reason is that the customer was short of money and saying so is cruel;
 * `unknown` because there is no true reason to give. In both, the instruction is not to name a
 * cause — and in both, the model sometimes named one anyway.
 */
const NO_CAUSE: ReadonlySet<string> = new Set(["timed", "unknown"]);

/**
 * The explanation a model invents when it has been told not to explain.
 *
 * Found by reading the first complete library, which is the whole reason it is committed rather
 * than streamed. Six variants in 465 — 1.3%, all in the two classes above — said the payment had
 * failed for *technical* reasons. Not a balance, which the prompt guards heavily and which no
 * variant mentioned; a comforting fiction about a fault at the bank's end. It is still a false
 * statement about somebody's money, sent under the merchant's own sender id.
 *
 * The prompt now forbids it in as many words. This is the part that does not depend on the model
 * having complied: a prohibited phrase is a structural check, and it costs nothing to add to the
 * two classes where none of these words could ever be true.
 *
 * Confined to those two classes deliberately. `transient` copy *should* say the bank had a problem
 * — that is the class where naming the cause is the entire source of the uplift, and 21 of its 32
 * variants do.
 */
const INVENTED_CAUSE: readonly string[] = [
  "technical",
  "server",
  "outage",
  "error",
  "तकनीकी",
  "तांत्रिक",
  "सर्वर",
  "தொழில்நுட்ப",
  "சேவையக",
];

export function gauntletFor(segment: CopySegment): GauntletOptions {
  return {
    maxTypicalSegments: segmentsFor(segment),
    maxWorstCaseSegments: worstCaseSegmentsFor(segment),
    prohibited: NO_CAUSE.has(segment.recoverability)
      ? [...DEFAULT_PROHIBITED, ...INVENTED_CAUSE]
      : DEFAULT_PROHIBITED,
  };
}

/** Everything a compose call needs, derived from the segment and nothing else. */
export function requestFor(segment: CopySegment): {
  readonly segment: CopySegment;
  readonly variants: number;
  readonly budget: ReturnType<typeof bodyBudget>;
} {
  return {
    segment,
    variants: VARIANTS_PER_SEGMENT,
    budget: bodyBudget(segment, segmentsFor(segment)),
  };
}

/** The policy, as a run prints it before spending anything under it. */
export function describePolicy(): string {
  const rows = LANGUAGES.map((language) => {
    const sms: CopySegment = {
      recoverability: "transient",
      channel: "contact-sms",
      language,
      method: null,
    };
    const budget = bodyBudget(sms, segmentsFor(sms));
    return (
      `  ${LANGUAGE_SPECS[language].englishName.padEnd(8)} ` +
      `${segmentsFor(sms)} segment${segmentsFor(sms) === 1 ? " " : "s"}  ` +
      `${String(budget.characters).padStart(3)} characters of copy ` +
      `(${budget.capacity} units, less ${budget.greeting} of greeting and ` +
      `${budget.placeholders.amount + budget.placeholders.link} of placeholder)`
    );
  });

  return [
    "SMS budget by language:",
    ...rows,
    `  worst case reserved at ${MAX_WORST_CASE_SEGMENTS} segments in every language`,
  ].join("\n");
}
