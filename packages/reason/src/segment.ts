/**
 * The unit a model is asked to write for, and the reason this integration is affordable.
 *
 * A recovery arm sends thousands of messages and there are not thousands of things to say. Every
 * message is one of a small number of *situations* — this class of failure, on this rail, to
 * somebody who reads this language, through this channel — with four values substituted into it. So
 * the model is asked once per situation, its answer is validated, stored and reused, and rendering
 * is a pure function afterwards.
 *
 * The arithmetic is the whole argument. Generating per message would be 5,719 calls for a four-hour
 * window; generating per segment is about 180, which is a quarter of an hour once and nothing
 * thereafter. On a metered account that is the difference between two dollars and a hundred. On a
 * free tier it is the difference between fitting inside a daily quota and not running at all.
 *
 * A segment deliberately does **not** include anything about a person. It cannot: a segment is what
 * the model sees, and the model does not see customers. See {@link file://./variant.ts}.
 */

import type { ActionKind, PaymentMethod, RecoverabilityClass } from "@kairos/domain";
import type { Language } from "./language.js";

/**
 * The contact kinds, derived from the domain's closed action vocabulary rather than restated.
 *
 * Typed off `ActionKind` so that a channel added to the vocabulary Terminus admits against cannot
 * be forgotten here — the copy library would fail to cover it and say so, instead of the system
 * discovering at send time that it has nothing to say.
 */
export type ContactChannel = Extract<ActionKind, `contact-${string}`>;

export const CONTACT_CHANNELS = ["contact-sms", "contact-whatsapp", "contact-email"] as const;

/**
 * Classes whose copy has to name the payment method, because the customer's next move depends on it.
 *
 * `customer-action` and `customer-retry` are the two where the message's job is to say *what to do*,
 * and what to do genuinely differs: open your UPI app and enter your PIN, wait for the OTP on your
 * card, log in to your bank. Getting that specific is where the guided-copy uplift comes from, and
 * you cannot be specific without knowing the rail.
 *
 * The other three do not need it. `transient` says the outage is over, `timed` says finish when
 * you're ready and `unknown` says it did not go through — the next move is the same link in all
 * three, whatever the payment was made with. Keying them by method would multiply the library
 * sixfold for copy that would come back identical.
 */
const METHOD_SPECIFIC: ReadonlySet<RecoverabilityClass> = new Set([
  "customer-action",
  "customer-retry",
]);

/** Classes a message is ever sent for. `dead` is not one: the whole point of `dead` is silence. */
export const SENDING_CLASSES: readonly RecoverabilityClass[] = [
  "transient",
  "timed",
  "customer-action",
  "customer-retry",
  "unknown",
];

export interface CopySegment {
  readonly recoverability: RecoverabilityClass;
  readonly channel: ContactChannel;
  readonly language: Language;
  /** `null` where the copy does not name a rail — see {@link METHOD_SPECIFIC}. */
  readonly method: PaymentMethod | null;
}

/**
 * A stable string for a segment, used as a cache key, a library index, and a ledger reference.
 *
 * Field order is fixed and the format is flat, because this string ends up in a committed JSON file
 * and in audit records. A key whose format depends on iteration order would make a library diff
 * unreadable.
 */
export function segmentKey(segment: CopySegment): string {
  return [segment.recoverability, segment.method ?? "any", segment.language, segment.channel].join(
    "/",
  );
}

export function parseSegmentKey(key: string): CopySegment | null {
  const parts = key.split("/");
  if (parts.length !== 4) return null;
  const [recoverability, method, language, channel] = parts as [string, string, string, string];
  if (!SENDING_CLASSES.includes(recoverability as RecoverabilityClass)) return null;
  if (!(CONTACT_CHANNELS as readonly string[]).includes(channel)) return null;
  return {
    recoverability: recoverability as RecoverabilityClass,
    method: method === "any" ? null : (method as PaymentMethod),
    language: language as Language,
    channel: channel as ContactChannel,
  };
}

export interface Coverage {
  readonly languages: readonly Language[];
  readonly methods: readonly PaymentMethod[];
  readonly channels: readonly ContactChannel[];
}

/**
 * Every segment a library must cover to serve this population, and nothing more.
 *
 * Enumerated rather than generated on demand so that the size of the ask is a number somebody can
 * look at before spending a quota on it, and so that a library can report exactly which segments it
 * is missing rather than discovering a gap at send time.
 */
export function requiredSegments(coverage: Coverage): readonly CopySegment[] {
  const segments: CopySegment[] = [];

  for (const recoverability of SENDING_CLASSES) {
    const methods: readonly (PaymentMethod | null)[] = METHOD_SPECIFIC.has(recoverability)
      ? coverage.methods
      : [null];

    for (const method of methods) {
      for (const language of coverage.languages) {
        for (const channel of coverage.channels) {
          segments.push({ recoverability, method, language, channel });
        }
      }
    }
  }

  return segments;
}
