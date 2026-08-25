/**
 * What a run needs to record about itself for the numbers to mean anything later.
 *
 * `ARCHITECTURE.md` §10 promises an `experiments` table that "pins the seed, config hash, and code
 * revision for every harness run, so a scorecard is reproducible from the row". This is that row.
 *
 * The config hash does more work than provenance usually does. It is not decoration on a report: it
 * is what stops the regression gate from comparing two different experiments and calling the
 * difference a regression. Change `attemptsPerMinute` from 300 to 200 and every metric moves. That
 * is not a regression, it is a new question, and a gate that cannot tell the two apart trains people
 * to ignore it. See {@link file://./compare.ts}.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

export interface Provenance {
  /** Which experiment this is — `quick`, `full`. Part of what the hash covers. */
  readonly profile: string;
  /** Over the redacted configuration below. Two runs with the same hash are comparable. */
  readonly configHash: string;
  /** Informational only, and never gated: it changes on every commit by design. */
  readonly codeRevision: string;
  readonly node: string;
  /**
   * The configuration, redacted for publication.
   *
   * This is written into `docs/results/`, which is a public repository, so it must not carry the
   * mandate signing secret or anything else that would be a credential in a real deployment. The
   * harness hands over a summary it has already redacted rather than its live config object,
   * because the safe default for "serialise the config" is to serialise nothing.
   */
  readonly config: JsonValue;
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * Deterministic JSON: object keys sorted, array order preserved.
 *
 * Array order is preserved because it carries meaning here — `thresholds: [6, 8, 10]` is a
 * different experiment from `[10, 8, 6]` only in presentation, but `contactLadderMs: [0, 1d, 3d]`
 * is a different experiment from `[3d, 1d, 0]` in fact, and the canonicaliser has no way to know
 * which it is holding. Sorting would silently merge them.
 *
 * Non-finite numbers throw rather than serialising: `JSON.stringify` turns `NaN` and `Infinity`
 * into `null`, so a config with a broken number would hash identically to one with an explicit
 * null, and the hash would certify a run that never happened.
 */
export function canonicalise(value: JsonValue, path = "config"): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${path} is ${value}, which cannot be canonicalised`);
    }
    // `-0` and `0` are the same configuration and must not hash differently.
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry, i) => canonicalise(entry, `${path}[${i}]`)).join(",")}]`;
  }

  const record = value as { readonly [key: string]: JsonValue };
  const keys = Object.keys(record).sort();
  const body = keys
    .map(
      (key) => `${JSON.stringify(key)}:${canonicalise(record[key] as JsonValue, `${path}.${key}`)}`,
    )
    .join(",");
  return `{${body}}`;
}

/**
 * A short, stable fingerprint of an experiment's configuration.
 *
 * Truncated to sixteen hex characters, which is sixty-four bits. This is not a security boundary —
 * nobody gains anything by colliding with a benchmark configuration — so the length is chosen for a
 * human comparing two lines in a diff.
 */
export function configHash(config: JsonValue): string {
  return createHash("sha256").update(canonicalise(config), "utf8").digest("hex").slice(0, 16);
}

/** Runs a command and returns its trimmed stdout, or `null` if it cannot be run at all. */
export type Runner = (command: string, args: readonly string[]) => string | null;

const gitRunner: Runner = (command, args) => {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
};

/**
 * The commit this ran at, marked `-dirty` when the tree has uncommitted changes.
 *
 * Injectable rather than hard-wired to `git` so the behaviour is testable without a repository, and
 * degrades to `"unknown"` rather than throwing: a scorecard produced from a source tarball, or
 * inside a container that did not copy `.git`, is still a valid scorecard. It is simply one whose
 * provenance you have to establish some other way, and saying so is better than failing.
 */
export function codeRevision(run: Runner = gitRunner): string {
  const head = run("git", ["rev-parse", "--short", "HEAD"]);
  if (head === null || head === "") return "unknown";
  const status = run("git", ["status", "--porcelain"]);
  return status === null || status === "" ? head : `${head}-dirty`;
}

export function provenance(
  profile: string,
  config: JsonValue,
  run: Runner = gitRunner,
): Provenance {
  return {
    profile,
    configHash: configHash(config),
    codeRevision: codeRevision(run),
    node: process.version,
    config,
  };
}
