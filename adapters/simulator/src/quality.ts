/**
 * How good a recovery message is, judged from the message.
 *
 * This function exists because of a specific way the harness could have lied. Until now the world
 * was told whether copy was "guided" by a boolean the *benchmark* set from the failure class — so a
 * new arm could have claimed better copy simply by passing `true`, and the measured uplift would
 * have been the author's opinion of their own work with a number attached to it.
 *
 * So the boolean is gone and the text is scored instead. **Nothing here takes an argument saying
 * which arm wrote the message.** It cannot: the signature is text and situation, and every arm's
 * copy goes through the same four checks. A hand-written template that names the bank scores exactly
 * what a generated sentence naming the same bank scores. If generated copy wins, it wins by having
 * properties you can read off the text, and anyone doubting the result can read the copy library and
 * check.
 *
 * ## What it rewards, and why those things
 *
 * Chosen before any generated copy existed, and defensible without reference to it:
 *
 * 1. **It names what went wrong** — the bank, or the rail. A person who understands the problem acts
 *    on it; a person told only that "something failed" assumes it will fail again.
 * 2. **It names what to do** — enter the PIN, wait for the OTP, log in, update the card. The single
 *    most useful thing a recovery message can contain, and the reason classification pays for
 *    itself twice.
 * 3. **They can read it** — an Indian merchant's customers do not all read English.
 * 4. **It fits** — a message that spills into a second segment costs twice as much and is read
 *    less.
 *
 * ## The part that is a guess
 *
 * The *weights* are invented, and so is {@link ILLEGIBLE_PENALTY}. Their ordering is defensible;
 * their levels are not measured, because measuring them needs customers rather than a simulator.
 * They are set deliberately conservatively — a message somebody cannot read is scored at half
 * effectiveness rather than zero, which is the choice that makes the multilingual case *harder* to
 * win rather than easier. See the caveats in `docs/MEASUREMENT.md`.
 */

import { isInScript, type Language, type PaymentMethod, smsCost } from "@kairos/domain";

export type MessageChannelKind = "contact-sms" | "contact-whatsapp" | "contact-email";

export interface MessageExpectation {
  /** What this customer actually reads. Not what the merchant happens to write in. */
  readonly language: Language;
  /** The institution the payment died on, where the failure had one. */
  readonly institution: string | null;
  readonly method: PaymentMethod;
  readonly channel: MessageChannelKind;
}

export interface MessageQuality {
  /** Names the bank or the rail, rather than reporting that something failed. */
  readonly namesCause: boolean;
  /** Names the thing the customer physically does next on that rail. */
  readonly namesAction: boolean;
  /** Written in a script this customer reads. */
  readonly legible: boolean;
  /** Fits the channel it is being sent on. */
  readonly concise: boolean;
  /** The weighted result, in [0,1]. What a fix rate is interpolated along. */
  readonly guidance: number;
}

/**
 * What a rail is called, in the words a message would use.
 *
 * Mostly Latin even inside Hindi and Tamil copy, because that is how Indians write about payments:
 * "UPI", "OTP" and "PIN" are loan words that stay in Latin script in an otherwise Devanagari
 * sentence. The Devanagari and Tamil entries cover the words that do get translated.
 */
const RAIL_TERMS: Readonly<Record<PaymentMethod, readonly string[]>> = {
  upi: ["upi", "यूपीआई", "யுபிஐ"],
  card: ["card", "कार्ड", "அட்டை"],
  netbanking: ["netbanking", "net banking", "नेटबैंकिंग", "நெட் பேங்கிங்"],
  wallet: ["wallet", "वॉलेट", "பணப்பை"],
  emi: ["emi", "ईएमआई", "இஎம்ஐ"],
  paylater: ["pay later", "paylater", "पे लेटर"],
};

/**
 * What the customer physically does, on each rail.
 *
 * The list a message has to hit to count as telling somebody what to do. Deliberately concrete —
 * "complete your payment" is not on it, because it is what every unhelpful message already says.
 */
const ACTION_TERMS: Readonly<Record<PaymentMethod, readonly string[]>> = {
  upi: ["pin", "approve", "पिन", "स्वीकृत", "பின்"],
  card: ["otp", "expired", "expiry", "update", "ओटीपी", "समाप्त", "अपडेट", "ஓடிபி"],
  netbanking: ["log in", "login", "sign in", "लॉगिन", "लॉग इन", "உள்நுழை"],
  wallet: ["top up", "top-up", "recharge", "re-link", "रिचार्ज", "ரீசார்ஜ்"],
  emi: ["re-confirm", "reconfirm", "confirm", "पुष्टि", "உறுதி"],
  paylater: ["authorise", "authorize", "approve", "अधिकृत", "அங்கீகரி"],
};

/** How much of a message's effect survives arriving in a script the reader does not use. */
export const ILLEGIBLE_PENALTY = 0.5;

const WEIGHTS = { namesCause: 0.4, namesAction: 0.4, concise: 0.2 } as const;

/** Segments a message may occupy on each channel before length starts costing it readers. */
function fits(text: string, channel: MessageChannelKind): boolean {
  // Email is not billed or read in segments, so length is not the constraint there.
  if (channel === "contact-email") return true;
  const segments = smsCost(text).segments;
  return channel === "contact-whatsapp" ? segments <= 2 : segments <= 1;
}

function mentions(text: string, terms: readonly string[]): boolean {
  // Both sides lowered: the term tables are already lowercase, but an institution name arrives as
  // the merchant writes it ("HDFC"), and comparing that against lowered text matches nothing.
  const lowered = text.toLowerCase();
  return terms.some((term) => lowered.includes(term.toLowerCase()));
}

/**
 * Score a rendered message.
 *
 * Takes the text a customer would actually receive — after substitution, with the real bank name and
 * the real amount in it — because that is what they read. Scoring a template with its holes still in
 * would credit copy for a bank name it never printed.
 */
export function scoreMessage(text: string, expectation: MessageExpectation): MessageQuality {
  const namesCause =
    (expectation.institution !== null && mentions(text, [expectation.institution])) ||
    mentions(text, RAIL_TERMS[expectation.method]);

  const namesAction = mentions(text, ACTION_TERMS[expectation.method]);
  const legible = isInScript(text, expectation.language);
  const concise = fits(text, expectation.channel);

  const earned =
    (namesCause ? WEIGHTS.namesCause : 0) +
    (namesAction ? WEIGHTS.namesAction : 0) +
    (concise ? WEIGHTS.concise : 0);

  return {
    namesCause,
    namesAction,
    legible,
    concise,
    guidance: legible ? earned : earned * ILLEGIBLE_PENALTY,
  };
}

/** A message nobody sent, for the paths that ask what would have happened without one. */
export const NO_MESSAGE: MessageQuality = {
  namesCause: false,
  namesAction: false,
  legible: false,
  concise: false,
  guidance: 0,
};
