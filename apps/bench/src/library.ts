/**
 * Loading the committed copy library, for the arm that uses it.
 *
 * Separate from the benchmark itself because the benchmark should have no opinion about where a
 * library lives — `runRecovery` takes a `Copy` or takes nothing, and a test hands it three variants
 * rather than four hundred. This is the one place that knows about a path on disk.
 *
 * ## A missing library is not a failure
 *
 * It returns `null` and the run proceeds with four arms instead of five. That is deliberate and it
 * matches how the rest of the system treats generated copy: the library is an artifact produced by
 * a run against a metered API that somebody has to choose to make, and a checkout that has not made
 * it is a checkout where the recovery arm sends hand-written templates — which is exactly what
 * Kairos did for its first five phases. A benchmark that refused to run without one would make an
 * optional artifact mandatory for measuring the parts that do not use it.
 *
 * A library that is *present but invalid* is a different matter and throws. That is a corrupted
 * file or a hand-edit that broke the schema, and continuing would silently measure a template arm
 * while reporting a generated one.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Copy, parseLibrary } from "@kairos/reason";

/** Relative to this package, resolved from the module URL so the cwd does not matter. */
const LIBRARY_PATH = "../../../data/copy-library.json";

export interface LoadedLibrary {
  readonly copy: Copy | null;
  /** What to print when there is no library, so a four-arm scorecard explains itself. */
  readonly note: string;
}

export function loadLibrary(): LoadedLibrary {
  const path = fileURLToPath(new URL(LIBRARY_PATH, import.meta.url));

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {
      copy: null,
      note: "no copy library at data/copy-library.json — running template arms only",
    };
  }

  const copy = new Copy(parseLibrary(JSON.parse(raw)));
  return {
    copy,
    note: `copy library: ${copy.size} segments, written by ${copy.provenance.model} on ${copy.provenance.generatedAt}`,
  };
}
