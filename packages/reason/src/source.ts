/**
 * Where a recovery message's words come from.
 *
 * The seam the copy library was built for and, until now, did not have. `data/copy-library.json`
 * held 468 validated variants in four languages and nothing in the running system read it: the
 * executor called one hand-written English template per failure class and always had. This is the
 * interface that closes that gap, and it is deliberately narrow — a source is handed a situation
 * and returns words. It cannot send, cannot spend, and cannot call a model.
 *
 * ## Why it is a port rather than a function
 *
 * Because the benchmark's whole argument depends on being able to swap it. Two arms that differ
 * *only* in their `CopySource` — same scheduling, same expected-value gate, same seed, same
 * customers, same world — isolate the effect of the copy to the copy. Anything else measures
 * generated text against a differently-configured system and calls the difference language.
 *
 * ## Selection is deterministic, and that is not a performance choice
 *
 * A segment usually has three variants and the source must pick one. It picks by hashing a caller-
 * supplied key, so the same casualty and attempt always yield the same words. Two reasons, and
 * neither is about speed:
 *
 * 1. **A retry must not change the message.** The executor's idempotency key protects the *send*;
 *    it does nothing about the text. A source that picked randomly would let a replayed attempt
 *    compose a longer variant, occupy more segments, and reconcile against a reservation that was
 *    sized for a different sentence.
 * 2. **A benchmark that reproduces exactly needs every input reproduced exactly** — see ADR 0005.
 *
 * What this is *not* is an exploration bandit. ARCHITECTURE §7 describes one accumulating a
 * conversion rate per variant id; it is not built. Hashing spreads traffic across variants roughly
 * evenly and learns nothing from the outcome, which is uniform exploration with no exploitation at
 * all. Stated here rather than in a commit message because a reader who sees three variants and a
 * chooser will reasonably assume the chooser is smarter than it is.
 */

import type {
  CopyVariables,
  Language,
  PaymentMethod,
  RecoverabilityClass,
  SmsCost,
} from "@kairos/domain";
import type { Copy } from "./library.js";
import type { ContactChannel } from "./segment.js";
import { segmentFor } from "./segment.js";
import { render } from "./variant.js";

export interface CopyRequest {
  readonly recoverability: RecoverabilityClass;
  readonly method: PaymentMethod;
  /**
   * What the customer reads. Not what the merchant writes in.
   *
   * Required rather than defaulted. A default here would be English, and a customer silently
   * assumed to read English is the exact failure the library exists to fix — it would produce a
   * system that looks multilingual, passes its tests, and sends Latin script to everybody.
   */
  readonly language: Language;
  readonly channel: ContactChannel;
  readonly variables: CopyVariables;
  /**
   * Stable per message, and the same on every replay of it.
   *
   * The casualty id and attempt ordinal are the natural value. Anything derived from a clock or a
   * random source breaks both properties above.
   */
  readonly pick: string;
}

export interface SelectedCopy {
  readonly text: string;
  /** Email only, and `null` everywhere else — the gauntlet enforces both directions. */
  readonly subject: string | null;
  readonly cost: SmsCost;
  /**
   * The library variant that produced these words, or `null` when a template did.
   *
   * The field `reason.fallbackRate` is computed from. A source that quietly substituted a template
   * would otherwise be indistinguishable from one that found what it was looking for, and the
   * headline number would be an average over a population half of which never saw the treatment.
   */
  readonly variantId: string | null;
}

export interface CopySource {
  /** Named so a scorecard can say which source produced an arm's copy. */
  readonly name: string;
  select(request: CopyRequest): SelectedCopy;
}

/**
 * Serve copy from a generated library, falling back to `fallback` where nothing was written.
 *
 * The fallback is not a safety net bolted on afterwards, it is the operating assumption. A library
 * is generated against a free-tier quota by a run that can be interrupted, so partial coverage is
 * the normal state and a missing segment is an ordinary condition rather than an error — see
 * ADR 0006. The consequence is worth stating plainly: **the fallback is in English**, so a Tamil
 * customer whose segment is missing receives Latin script and is scored as unable to read it. That
 * is the honest behaviour. Silently promoting them to a different language's copy would hide a
 * coverage gap inside a metric that is supposed to reveal it.
 */
export function libraryCopy(copy: Copy, fallback: CopySource): CopySource {
  return {
    name: `library(${copy.provenance.model}) → ${fallback.name}`,

    select(request) {
      const segment = segmentFor(request);
      const variants = copy.variantsFor(segment);
      if (variants.length === 0) return fallback.select(request);

      const chosen = variants[index(request.pick, variants.length)];
      // Unreachable — `index` is bounded by the length checked above — but `noUncheckedIndexedAccess`
      // is right to make it say so, and falling back is the correct answer if it ever were.
      if (chosen === undefined) return fallback.select(request);

      const rendered = render(chosen, segment, request.variables);
      return {
        text: rendered.text,
        subject: rendered.subject,
        cost: rendered.cost,
        variantId: chosen.id,
      };
    },
  };
}

/**
 * Which variant, from a key.
 *
 * FNV-1a: small, dependency-free, and adequate for spreading a handful of ids across three buckets.
 * Not a cryptographic choice and nothing here needs one — the input is an internal id and the
 * output selects a sentence.
 */
function index(pick: string, count: number): number {
  let hash = 0x811c9dc5;
  for (let at = 0; at < pick.length; at++) {
    hash ^= pick.charCodeAt(at);
    hash = Math.imul(hash, 0x01000193);
  }
  return Math.abs(hash) % count;
}
