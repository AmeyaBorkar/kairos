/**
 * How many SMS segments a message costs, and therefore what it costs in rupees.
 *
 * This is the concrete thing behind the abstraction in Terminus. A reservation is taken before the
 * message exists, the price is per segment, and the number of segments is not knowable until the
 * text is final — so the kernel reserves a ceiling and reconciles against the truth. Everything
 * here is the truth half.
 */

/**
 * GSM 03.38, the seven-bit alphabet an SMS uses when it can.
 *
 * Written out rather than expressed as ranges because it is not a range: it is a historical
 * committee's list, with Greek capitals that happen to look like Latin ones missing and a handful
 * of currency symbols present. Getting one character wrong silently changes the price of every
 * message containing it.
 */
const GSM_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
  "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§" +
  "¿abcdefghijklmnopqrstuvwxyzäöñüà";

/** Characters reachable only through the escape sequence, and therefore costing two units each. */
const GSM_EXTENDED = "\f^{}\\[~]|€";

const BASIC = new Set(GSM_BASIC);
const EXTENDED = new Set(GSM_EXTENDED);

/** Message sizes in the two encodings, single and concatenated. */
export const SEGMENT_LIMITS = {
  /** A single GSM-7 message. */
  gsmSingle: 160,
  /** Each part of a concatenated GSM-7 message: seven bytes go to the header. */
  gsmMulti: 153,
  /** A single UCS-2 message. */
  ucsSingle: 70,
  /** Each part of a concatenated UCS-2 message. */
  ucsMulti: 67,
} as const;

export type SmsEncoding = "gsm-7" | "ucs-2";

export interface SmsCost {
  readonly encoding: SmsEncoding;
  /** Billable units: GSM-7 extended characters count twice, and astral characters twice again. */
  readonly units: number;
  readonly segments: number;
}

/**
 * Whether every character in the text survives the seven-bit alphabet.
 *
 * One character that does not — a rupee sign, a smart quote, a Devanagari letter — moves the whole
 * message to UCS-2 and cuts its capacity from 160 characters to 70. There is no partial encoding.
 */
export function encodingFor(text: string): SmsEncoding {
  for (const character of text) {
    if (!BASIC.has(character) && !EXTENDED.has(character)) return "ucs-2";
  }
  return "gsm-7";
}

/**
 * Segment count and encoding for a message.
 *
 * The asymmetry this exposes is the whole reason Terminus reserves a ceiling rather than an
 * estimate: **the same sentence costs one segment in Latin script and three in Devanagari**, and
 * which one it is may not be decided by the merchant at all. A template is composed with a
 * customer's own name in it, and a customer is free to be called रोहित.
 */
export function smsCost(text: string): SmsCost {
  const encoding = encodingFor(text);
  const units = encoding === "gsm-7" ? gsmUnits(text) : ucsUnits(text);

  const [single, multi] =
    encoding === "gsm-7"
      ? [SEGMENT_LIMITS.gsmSingle, SEGMENT_LIMITS.gsmMulti]
      : [SEGMENT_LIMITS.ucsSingle, SEGMENT_LIMITS.ucsMulti];

  if (units === 0) return { encoding, units, segments: 0 };
  const segments = units <= single ? 1 : Math.ceil(units / multi);
  return { encoding, units, segments };
}

/** GSM-7 billable units: extended characters occupy two. */
function gsmUnits(text: string): number {
  let units = 0;
  for (const character of text) units += EXTENDED.has(character) ? 2 : 1;
  return units;
}

/**
 * UCS-2 billable units: one per sixteen-bit code unit.
 *
 * So an emoji outside the basic plane costs two, which `[...text].length` would report as one. The
 * difference has put real messages over a segment boundary, so it is counted the way a carrier
 * counts it rather than the way JavaScript's iterator does.
 */
function ucsUnits(text: string): number {
  return text.length;
}

/** What a message costs in paise, given a per-segment price. */
export function smsCostPaise(text: string, pricePerSegmentPaise: number): number {
  return smsCost(text).segments * pricePerSegmentPaise;
}
