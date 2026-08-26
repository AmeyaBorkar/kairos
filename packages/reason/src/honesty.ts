/**
 * Whether an explanation only used figures it was given.
 *
 * The gauntlet's sibling, and it exists for the same reason: a model asked to explain why a payment
 * was not retried will produce fluent, plausible prose whether or not it has the facts, and the
 * failure mode is not gibberish — it is a confident sentence containing a number nobody recorded.
 * "We had already contacted them 4 times that week" reads exactly like the truth and is a fabricated
 * claim about a real person's account, published in an interface an operator is expected to trust.
 *
 * ## The rule
 *
 * **Every figure in the answer must appear, character for character, in what the model was shown.**
 * Not "approximately", not "derivable from" — present. That is a strong constraint and it is the
 * point: it makes the check decidable, and it makes the failure loud rather than subtle.
 *
 * The cost is that the model may not compute. It cannot say "three of those four attempts" unless
 * the source said "three" somewhere, and it cannot convert 124500 paise into ₹1,245.00 on its own.
 * Both are handled where they should be — the retrieval formats figures the way an answer should
 * quote them, so the model is given `₹1,245.00` and has no reason to reach for arithmetic. A model
 * that must not calculate should never be handed a number it would have to calculate with.
 *
 * ## Why this is not a prompt instruction
 *
 * It is *also* a prompt instruction. But a prompt is a request and this is a check, and the
 * difference is the entire argument of `gauntlet.ts`: a rule enforced only by asking politely is a
 * rule that holds until the day it does not, silently, in front of a customer. Six variants in the
 * first complete copy library invented a cause the prompt had explicitly forbidden.
 */

/**
 * One maximal run of digits, with the separators that belong inside a figure.
 *
 * Anchored on a digit at both ends so a sentence-ending full stop is not swallowed. The first
 * version of this regex was `[\d.,:-]{2,}`, which captured `2026-08-24.` — including the stop — and
 * reported a truthful explanation as a fabrication. A check on honesty being less careful than its
 * subject is its own failure mode.
 */
const FIGURE = /\d[\d.,:-]*\d|\d/g;

/**
 * A token whose digits are part of a name, not a quantity.
 *
 * This exists because the check had a laundering hole, and the hole was found by a test that should
 * have failed and passed. The subject of a question is an identifier like `cas_9f21`, identifiers
 * are part of what the model is shown, and a naive digit scan reads `9` and `21` out of that id and
 * adds them to the set of figures an answer may use. So "the customer had already received 9
 * contacts" — a fabricated claim about a real account — verified clean, because the number nine
 * happened to appear in their casualty id.
 *
 * Any token containing `_` or `/` is a name: casualty ids (`cas_9f21`), mandate ids (`mnd_test`),
 * actors (`recover-worker/3`), URLs. None of them carry quantities, and the same rule is applied to
 * the answer as to the sources, so an answer quoting an id back is neither credited nor blamed for
 * the digits inside it.
 *
 * Letter-adjacent digits go the same way, except for an ordinal suffix: `9f21` is a name and `4th`
 * is a quantity, and a model writing "the 4th attempt" should have to justify the four.
 */
const NAMELIKE = new RegExp(
  [
    "[_\\/]", // ids and paths: cas_9f21, recover-worker/3
    "[A-Za-z](?<!\\d(?:st|nd|rd|th))\\d", // a letter running into a digit: 9f21
    "\\d(?!st\\b|nd\\b|rd\\b|th\\b)[A-Za-z]", // a digit running into a letter, ordinals excepted
  ].join("|"),
);

export interface HonestyVerdict {
  readonly ok: boolean;
  /**
   * Figures the answer used that its sources do not contain.
   *
   * Reported rather than merely counted, because the operator-facing failure is "this sentence
   * cannot be shown" and the developer-facing question is immediately "which number?".
   */
  readonly unsupported: readonly string[];
  /** Every distinct figure the answer used, supported or not. Useful when nothing is wrong. */
  readonly cited: readonly string[];
}

/**
 * Check an explanation against everything the model was shown.
 *
 * `sources` is every string that went into the request — the timeline, the bounds, the subject and
 * the operator's own question. The question is included deliberately: an operator who asks "why was
 * cas_9f21 not retried on 2026-08-24" has supplied those tokens, and an answer repeating them back
 * is quoting, not inventing.
 */
export function verifyExplanation(prose: string, sources: readonly string[]): HonestyVerdict {
  const known = new Set<string>();
  for (const source of sources) {
    for (const figure of figuresIn(source)) known.add(figure.normalised);
  }

  const cited: string[] = [];
  const unsupported: string[] = [];
  const seen = new Set<string>();

  for (const figure of figuresIn(prose)) {
    if (seen.has(figure.normalised)) continue;
    seen.add(figure.normalised);
    cited.push(figure.written);
    if (!known.has(figure.normalised)) unsupported.push(figure.written);
  }

  return { ok: unsupported.length === 0, unsupported, cited };
}

/**
 * Every quantity in a piece of text, skipping the tokens that are names.
 *
 * Whitespace-tokenised first and scanned second, in that order, because whether a digit is a
 * quantity is a property of the word it sits in rather than of its neighbouring characters. The
 * same function serves both sides of the comparison, which is what keeps the rule symmetric.
 */
function figuresIn(text: string): { written: string; normalised: string }[] {
  const found: { written: string; normalised: string }[] = [];
  for (const token of text.split(/\s+/)) {
    if (NAMELIKE.test(token)) continue;
    for (const match of token.matchAll(FIGURE)) {
      found.push({ written: match[0], normalised: normalise(match[0]) });
    }
  }
  return found;
}

/**
 * Strip the punctuation a figure can be written with but does not mean.
 *
 * `1,245` and `1245` are the same quantity written two ways, and an answer that drops a thousands
 * separator has not invented anything. Everything else — the digits themselves, a date's hyphens, a
 * time's colon — is significant and is kept.
 */
function normalise(figure: string): string {
  return figure.replaceAll(",", "");
}
