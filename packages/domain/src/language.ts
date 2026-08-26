/**
 * The languages recovery copy is written in, and what each one costs to send.
 *
 * Language is not a localisation detail here, it is a pricing decision. An SMS uses the seven-bit
 * GSM alphabet when every character fits it and sixteen-bit UCS-2 when one does not, and there is no
 * partial encoding — so a message in Devanagari or Tamil carries **70 characters per segment where
 * the same message in Latin script carries 160**. The Hindi version of a sentence costs two or three
 * times what the English version costs, every time it is sent.
 *
 * That has two consequences the rest of this package is built around. A model writing Hindi has to
 * be told its budget in characters rather than in words, and the budget it is told is not the one an
 * English writer would be given. And a validator that checks length without checking script will
 * pass a message that costs three times what it was priced at.
 *
 * Which is also why the script is checked at all: a model asked for Tamil that answers in English
 * has not produced a cheap message, it has produced the wrong one.
 */

/** ISO 639-1, because that is what a merchant's customer table already stores. */
export type Language = "en" | "hi" | "mr" | "ta";

export const LANGUAGES = ["en", "hi", "mr", "ta"] as const;

export type Script = "latin" | "devanagari" | "tamil";

export interface LanguageSpec {
  readonly code: Language;
  /** The endonym, because that is what belongs in a prompt asking for the language. */
  readonly name: string;
  readonly englishName: string;
  readonly script: Script;
  /**
   * Whether text in this script survives the seven-bit alphabet.
   *
   * `false` means every message in this language is UCS-2 and its per-segment capacity is 70
   * characters rather than 160. What that leaves for the copy itself, once a greeting and the
   * substituted values are paid for, is `bodyBudget` in `@kairos/reason` — and the answer for an
   * Indic SMS at one segment is about twenty-five characters, which is why they are given two.
   */
  readonly gsm7: boolean;
}

export const LANGUAGE_SPECS: Readonly<Record<Language, LanguageSpec>> = {
  en: { code: "en", name: "English", englishName: "English", script: "latin", gsm7: true },
  hi: { code: "hi", name: "हिन्दी", englishName: "Hindi", script: "devanagari", gsm7: false },
  mr: { code: "mr", name: "मराठी", englishName: "Marathi", script: "devanagari", gsm7: false },
  ta: { code: "ta", name: "தமிழ்", englishName: "Tamil", script: "tamil", gsm7: false },
};

export function isLanguage(value: string): value is Language {
  return (LANGUAGES as readonly string[]).includes(value);
}

// Ranges rather than exhaustive sets: unlike GSM 03.38, these *are* contiguous blocks, and the
// Unicode standard is the authority on where they start and stop.
const DEVANAGARI = /[ऀ-ॿ꣠-ꣿ]/;
const TAMIL = /[஀-௿]/;
const LATIN_LETTER = /[A-Za-zÀ-ɏ]/;

/** Anything a caller will substitute later, and which is therefore not evidence of any script. */
const PLACEHOLDER = /\{[a-z]+\}/g;

export interface ScriptTally {
  readonly devanagari: number;
  readonly tamil: number;
  readonly latin: number;
  readonly total: number;
}

/**
 * Count the letters of each script, ignoring everything that is not evidence.
 *
 * Placeholders are stripped first and this is the whole reason the function exists: `{amount}` and
 * `{link}` are Latin, they appear in every message in every language, and counting them would make
 * a short Hindi message look like a Latin one. Digits, punctuation and whitespace are ignored for
 * the same reason — they are shared by every script and carry no signal.
 */
export function tallyScripts(text: string): ScriptTally {
  const stripped = text.replace(PLACEHOLDER, " ");
  let devanagari = 0;
  let tamil = 0;
  let latin = 0;

  for (const character of stripped) {
    if (DEVANAGARI.test(character)) devanagari++;
    else if (TAMIL.test(character)) tamil++;
    else if (LATIN_LETTER.test(character)) latin++;
  }

  return { devanagari, tamil, latin, total: devanagari + tamil + latin };
}

/**
 * The share of a language must reach before its copy is accepted as being in that language.
 *
 * Not one, deliberately. Real Indian recovery copy code-switches — "UPI", "OTP", "HDFC" and the
 * merchant's own name stay in Latin script inside an otherwise Hindi sentence, and that is how
 * people actually write. Demanding a pure script would reject the copy a native writer would
 * produce. Two thirds is enough to catch a model that answered in the wrong language and loose
 * enough to permit the loan words that belong.
 */
export const SCRIPT_MAJORITY = 2 / 3;

/**
 * Whether text is written in the script its language uses.
 *
 * Empty text is not in any script, and says so rather than passing by vacuous truth — a validator
 * that accepts an empty message is a validator that will one day let one be sent.
 */
export function isInScript(text: string, language: Language): boolean {
  const tally = tallyScripts(text);
  if (tally.total === 0) return false;

  const expected = LANGUAGE_SPECS[language].script;
  const observed =
    expected === "devanagari" ? tally.devanagari : expected === "tamil" ? tally.tamil : tally.latin;

  return observed / tally.total >= SCRIPT_MAJORITY;
}
