/**
 * The generated copy, as a file.
 *
 * This is the artifact the whole design turns on. A model writes it once, a human reads the diff,
 * it is committed, and every message the system sends afterwards is a lookup and a substitution. No
 * inference happens on the path where money moves.
 *
 * That has three consequences worth naming, because each of them is a property people usually give
 * up when they add a model to a system:
 *
 * - **It is reviewable.** Generated copy that reaches customers is text in a pull request, not a
 *   stream nobody saw. If the model writes something strange, somebody notices before a customer
 *   does.
 * - **It is reproducible.** The recovery benchmark replays a committed library, so the measured
 *   uplift comes from real model output and the run is still deterministic. CI never makes a call.
 * - **It degrades to nothing.** A missing segment is a lookup that returns nothing and a fall back
 *   to the hand-written template. There is no path where an inference endpoint being down stops the
 *   recovery arm.
 *
 * `promptHash` is here for the same reason the scorecard carries a config hash: copy written under
 * one set of instructions says nothing about copy written under another, and a library whose prompt
 * has since changed should say so rather than look current.
 */

import { z } from "zod";
import { LANGUAGES } from "./language.js";
import { CONTACT_CHANNELS, type CopySegment, SENDING_CLASSES, segmentKey } from "./segment.js";
import type { CopyVariant } from "./variant.js";

export interface LibraryProvenance {
  /** Which model wrote it, exactly as the provider names it. Goes into the ledger. */
  readonly model: string;
  /** Date only. A regeneration is deliberate and deserves a date; a clock time would be noise. */
  readonly generatedAt: string;
  /** Over the instructions the model was given. Changed instructions, changed library. */
  readonly promptHash: string;
  /** What it cost to produce, at list rate. */
  readonly spentPaise: number;
  readonly calls: number;
}

export interface CopyLibrary {
  readonly provenance: LibraryProvenance;
  readonly variants: readonly CopyVariant[];
}

const VARIANT = z.strictObject({
  id: z.string().min(1),
  segment: z.string().min(1),
  body: z.string().min(1),
  subject: z.string().min(1).nullable(),
  typicalSegments: z.number().int().nonnegative(),
  worstCaseSegments: z.number().int().nonnegative(),
});

const PROVENANCE = z.strictObject({
  model: z.string().min(1),
  generatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected an ISO date, e.g. 2026-08-26"),
  promptHash: z.string().regex(/^[0-9a-f]{16}$/, "expected sixteen lowercase hex characters"),
  spentPaise: z.number().int().nonnegative(),
  calls: z.number().int().nonnegative(),
});

export const COPY_LIBRARY = z
  .strictObject({ provenance: PROVENANCE, variants: z.array(VARIANT) })
  .superRefine((library, ctx) => {
    // Variant ids index the exploration bandit and appear in audit records. A duplicate would make
    // one arm's measured conversion rate silently stand in for another's.
    const seen = new Set<string>();
    for (const variant of library.variants) {
      if (seen.has(variant.id)) {
        ctx.addIssue({ code: "custom", message: `duplicate variant id ${variant.id}` });
      }
      seen.add(variant.id);
    }
  });

export function parseLibrary(raw: unknown): CopyLibrary {
  const parsed = COPY_LIBRARY.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("\n");
    throw new Error(`the copy library is not valid:\n${issues}`);
  }
  return parsed.data;
}

export function serialiseLibrary(library: CopyLibrary): string {
  const variants = [...library.variants].sort(
    (a, b) => a.segment.localeCompare(b.segment) || a.id.localeCompare(b.id),
  );
  return `${JSON.stringify({ ...library, variants }, null, 2)}\n`;
}

/**
 * A library indexed for lookup.
 *
 * Built once at startup rather than searched per message: the recovery worker asks this thousands of
 * times and the answer never changes within a run.
 */
export class Copy {
  readonly #bySegment: ReadonlyMap<string, readonly CopyVariant[]>;
  readonly provenance: LibraryProvenance;

  constructor(library: CopyLibrary) {
    this.provenance = library.provenance;
    const index = new Map<string, CopyVariant[]>();
    for (const variant of library.variants) {
      const list = index.get(variant.segment) ?? [];
      list.push(variant);
      index.set(variant.segment, list);
    }
    this.#bySegment = index;
  }

  /**
   * Every variant written for a situation, in a stable order.
   *
   * Empty where nothing was written, and the caller falls back to a template. Deliberately not an
   * exception: a gap in a generated library is an ordinary condition, not an error.
   */
  variantsFor(segment: CopySegment): readonly CopyVariant[] {
    return this.#bySegment.get(segmentKey(segment)) ?? [];
  }

  /** Segments that were asked for and are not covered. What a regeneration should target. */
  missing(required: readonly CopySegment[]): readonly CopySegment[] {
    return required.filter((segment) => this.variantsFor(segment).length === 0);
  }

  get size(): number {
    return this.#bySegment.size;
  }
}

export interface LibraryStats {
  readonly segments: number;
  readonly variants: number;
  readonly missing: number;
  /** Share of required segments that have at least one variant. */
  readonly coverage: number;
  readonly averageVariantsPerSegment: number;
}

export function statsFor(copy: Copy, required: readonly CopySegment[]): LibraryStats {
  const missing = copy.missing(required).length;
  const covered = required.length - missing;
  const variants = required.reduce((sum, segment) => sum + copy.variantsFor(segment).length, 0);

  return {
    segments: covered,
    variants,
    missing,
    coverage: required.length === 0 ? 1 : covered / required.length,
    averageVariantsPerSegment: covered === 0 ? 0 : variants / covered,
  };
}

/** Guards a hand-edited library against a segment key that names something that does not exist. */
export function isWellFormedSegmentKey(key: string): boolean {
  const parts = key.split("/");
  if (parts.length !== 4) return false;
  const [recoverability, , language, channel] = parts as [string, string, string, string];
  return (
    (SENDING_CLASSES as readonly string[]).includes(recoverability) &&
    (LANGUAGES as readonly string[]).includes(language) &&
    (CONTACT_CHANNELS as readonly string[]).includes(channel)
  );
}
