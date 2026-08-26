/**
 * How many tokens a prompt will be, before anybody has been asked.
 *
 * Needed because a Terminus reservation is taken *before* the call and the input side of the price
 * depends on the prompt's length. The provider will tell us exactly what it was — afterwards, in
 * `usageMetadata`, which is what settlement reconciles against. This is only ever the ceiling.
 *
 * ## Why not ask
 *
 * There is a `countTokens` endpoint and it is exact. It is also a second network round trip per
 * segment, on a tier whose binding constraint is requests rather than money — so using it would
 * halve the number of segments a day's quota can cover, in order to make a *ceiling* precise. A
 * ceiling does not need to be precise. It needs to be a ceiling.
 *
 * ## The constant is measured
 *
 * `countTokens` on real recovery copy in all four languages, on `gemini-3.6-flash`:
 *
 * | language | chars | tokens | chars/token |
 * |----------|-------|--------|-------------|
 * | English  | 132   | 31     | 4.26        |
 * | Hindi    | 140   | 36     | 3.89        |
 * | Marathi  | 131   | 37     | **3.54**    |
 * | Tamil    | 143   | 31     | 4.61        |
 *
 * Three is the divisor, which clears the densest script measured by about a sixth. Worth noting
 * that the intuition this replaces — "Devanagari will tokenise far worse than Latin" — was wrong by
 * enough to matter: the real spread is 3.54 to 4.61, and Tamil is *cheaper* than English.
 */

/** Characters per token, at the worst measured script, rounded down. */
const CHARS_PER_TOKEN = 3;

/** Framing the request carries whatever the text is: roles, part wrappers, schema. */
const ENVELOPE_TOKENS = 64;

/**
 * An over-estimate of the tokens some text will cost.
 *
 * Over, always: it is the input to a reservation, and a reservation that under-states is not a
 * bound. Settlement corrects it downward with the provider's own number.
 */
export function estimateTokens(...texts: readonly string[]): number {
  const chars = texts.reduce((sum, text) => sum + text.length, 0);
  return Math.ceil(chars / CHARS_PER_TOKEN) + ENVELOPE_TOKENS;
}
