/**
 * Finding everything the system did about one thing, and making it safe to show a model.
 *
 * Two jobs, kept in one file because separating them would let somebody use the first without the
 * second. Retrieval pulls a subject's records out of the audit chain; redaction turns them into the
 * flat, checked strings a provider is allowed to see. `@kairos/reason` deliberately does not depend
 * on the ledger — its `TimelineEntry` is strings precisely so that redaction is *a step somebody
 * performed* rather than a property somebody hoped for. This is that step.
 *
 * ## What leaves the building
 *
 * A recovery ledger already contains no names, no phone numbers and no payment tokens: everything
 * downstream of intake handles a `CustomerRef`, which is a keyed hash, and the single place a real
 * name is resolved is `CustomerDirectory`, which nothing here touches. So the redaction below is not
 * repairing a leak — it is a second wall in front of one that already holds, and it is built the way
 * a second wall should be: an allowlist.
 *
 * **Only the named fields are copied.** `meta` is dropped wholesale rather than filtered, because
 * `meta` is `Record<string, JsonValue>` and a filter over an open map is a promise about every key
 * anybody will ever add. A dropped field cannot leak; a filtered one leaks the first time somebody
 * writes `meta.customerEmail` in a hurry.
 *
 * ## Figures are formatted here, not by the model
 *
 * Every quantity is rendered the way the answer should quote it — rupees as `₹1,245.00`, times as
 * ISO instants. That is what lets `verifyExplanation` demand character-for-character agreement: a
 * model handed `124500` would have to divide by a hundred to write a sentence, and a model that
 * must not calculate should never be given a number it would have to calculate with.
 */

import { formatINR, type Paise } from "@kairos/domain";
import type { ChainedRecord } from "@kairos/ledger";
import type { TimelineEntry } from "@kairos/reason";

/** Anything that can hand back audit records. The ledger satisfies it; so does a database adapter. */
export interface RecordSource {
  where(predicate: (record: ChainedRecord) => boolean): readonly ChainedRecord[];
}

export interface RetrievalOptions {
  /** The casualty, incident or slice the question is about. */
  readonly target: string;
  /**
   * How many records to include, most recent last.
   *
   * A cap rather than a page: an explanation is a summary, and a subject with four hundred records
   * has a different problem than one an answer will solve. Truncation is reported by
   * {@link Retrieved.truncated} rather than performed silently, because an answer built from half a
   * history is an answer that may be confidently wrong about the other half.
   */
  readonly limit?: number;
}

export interface Retrieved {
  readonly timeline: readonly TimelineEntry[];
  /** Records that matched but did not fit the limit. Non-zero means the answer is partial. */
  readonly truncated: number;
  /** Every string handed to the model, which is exactly what an answer may quote figures from. */
  readonly sources: readonly string[];
}

const DEFAULT_LIMIT = 60;

/**
 * Everything the chain records about one subject, oldest first.
 *
 * Matched on `target` exactly rather than by prefix or substring. A casualty id is opaque and a
 * substring match would let `cas_9f2` pull in `cas_9f21`'s history — which is not a formatting bug,
 * it is one customer's record appearing in another's explanation.
 */
export function retrieve(source: RecordSource, options: RetrievalOptions): Retrieved {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const matched = source.where((record) => record.target === options.target);

  // Oldest first: an explanation is a narrative, and a narrative told backwards is a list.
  const ordered = [...matched].sort((a, b) => a.seq - b.seq);
  const kept = ordered.slice(Math.max(0, ordered.length - limit));

  const timeline = kept.map(redact);
  return {
    timeline,
    truncated: ordered.length - kept.length,
    sources: timeline.flatMap((entry) => [
      entry.at,
      entry.actor,
      entry.action,
      entry.reason,
      entry.binding ?? "",
    ]),
  };
}

/**
 * One record, reduced to what a provider may see.
 *
 * An allowlist by construction: this builds a new object out of six named fields rather than
 * deleting from a copy of the record. `meta`, `externalRef` and the chain hashes never appear —
 * `externalRef` because a gateway's payment id is a join key into a system that *does* hold personal
 * data, and the hashes because they are evidence about the chain rather than about the decision, and
 * nothing an answer says should depend on them.
 */
export function redact(record: ChainedRecord): TimelineEntry {
  return {
    at: instant(record.at),
    actor: record.actor,
    action: record.action,
    allowed: record.allowed,
    reason: record.reason,
    binding: record.binding,
  };
}

/**
 * The bounds in force, in the words an answer is allowed to use.
 *
 * Passed alongside the timeline so a refusal can be explained rather than merely reported: the
 * record says `binding: "contact-cap"`, and this is what turns that into "3 contacts in 7 days".
 * Written as complete phrases with their figures already formatted, for the reason at the top of
 * this file.
 */
export function describeBounds(mandate: {
  readonly budgetPaise: Paise;
  readonly maxActionCostPaise: Paise;
  readonly maxInFlight: number;
  readonly contactCap: { readonly limit: number; readonly windowMs: number };
  readonly quietHours: { readonly startMinute: number; readonly endMinute: number } | null;
}): readonly string[] {
  const bounds = [
    `campaign budget: ${formatINR(mandate.budgetPaise)} total`,
    `most expensive single action allowed: ${formatINR(mandate.maxActionCostPaise)}`,
    `at most ${mandate.maxInFlight} actions in flight at once`,
    `contact cap: ${mandate.contactCap.limit} contacts per customer per ${days(mandate.contactCap.windowMs)} days`,
  ];

  if (mandate.quietHours !== null) {
    bounds.push(
      `quiet hours: nothing sent between ${clock(mandate.quietHours.startMinute)} and ${clock(mandate.quietHours.endMinute)} local time`,
    );
  }
  return bounds;
}

/**
 * A moment, written so its figures can be checked.
 *
 * `2026-08-24 09:15:00 UTC` rather than `2026-08-24T09:15:00.000Z`, and the reason is entirely
 * about the honesty check downstream. That check skips tokens whose digits sit against letters,
 * because those are names — `cas_9f21` must not license the number nine. An ISO instant is one
 * token with letters wedged between its digits, so it would be skipped whole, and an answer quoting
 * the time correctly would be treated as having quoted nothing.
 *
 * Splitting the date, the time and the zone into three plain tokens makes every figure in a
 * timestamp checkable, and reads better in an answer besides.
 */
function instant(at: number): string {
  const iso = new Date(at).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

function days(ms: number): string {
  return String(Math.round(ms / 86_400_000));
}

function clock(minute: number): string {
  const hours = Math.floor(minute / 60) % 24;
  const minutes = minute % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}
