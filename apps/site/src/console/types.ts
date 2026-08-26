/**
 * The shape of a recorded console run.
 *
 * `apps/console` exposes a rich read model; this is that model after `scripts/capture-run.mjs` has
 * squeezed it into something a page can carry. Floats are rounded to the precision the interface
 * displays, static fields are hoisted out of the per-frame arrays, and ledger entries — which repeat
 * in every frame's window — are stored once against the frame they first appear in.
 *
 * Positional tuples rather than objects, deliberately: the payload is a hundred-odd frames across
 * six scenarios, and field names repeated twenty thousand times are most of the file. The cost is
 * that the indices are meaningful, which is what the named accessors below are for.
 */

export const RAIL_STATES = ["healthy", "watching", "degraded"] as const;
export type RailState = (typeof RAIL_STATES)[number];

export const STEER_MODES = ["none", "demoted", "suppressed"] as const;
export type SteerMode = (typeof STEER_MODES)[number];

/** `[key, method, issuer]` — identity, fixed for the whole run. */
export type RailKey = readonly [string, string, string | null];

/** `[axis, limit]` — the bound's name and its ceiling as text. */
export type BoundAxis = readonly [string, string];

/**
 * `[railIndex, attempts, failureRate, stateIndex, statistic, steerIndex]`
 *
 * The index comes first because it is identity, and identity has to travel with the reading: a rail
 * with no attempts in the current window is absent from a snapshot altogether, so position in the
 * array means nothing from one frame to the next.
 */
export type RailReading = readonly [number, number, number, number, number, number];

/** `[id, slice, openedAt, closedAt, detectionLatencyMs, peakFailureRate, casualties]` */
export type IncidentRow = readonly [
  string,
  string,
  number,
  number | null,
  number | null,
  number,
  number,
];

/** `[utilisation, refusals, current]` */
export type BoundReading = readonly [number, number, string];

/** `[firstFrame, at, action, allowed, reason, binding]` */
export type LedgerRow = readonly [number, string, string, 0 | 1, string, string | null];

export interface Frame {
  /** The simulated instant, in epoch milliseconds. Not the wall clock. */
  readonly at: number;
  readonly rails: readonly RailReading[];
  readonly inc: readonly IncidentRow[];
  readonly bounds: readonly BoundReading[];
  readonly records: number;
  readonly verified: 0 | 1;
}

export interface Scenario {
  readonly premise: string;
  readonly watchFor: string;
  readonly budgetPaise: number;
  readonly seed: number;
  readonly threshold: number;
  readonly railKeys: readonly RailKey[];
  readonly boundAxes: readonly BoundAxis[];
  readonly ledger: readonly LedgerRow[];
  readonly frames: readonly Frame[];
}

export interface RecordedRun {
  /** Simulated milliseconds per engine step. */
  readonly tickMs: number;
  /** One frame was kept every this many steps. */
  readonly keptEvery: number;
  readonly scenarios: Readonly<Record<string, Scenario>>;
}

/** Order the scenarios are offered in, and the one-line hook each gets on its button. */
export const DECK: ReadonlyArray<readonly [string, string]> = [
  ["issuer-outage", "one rail fails"],
  ["invisible-issuer", "it can only demote"],
  ["two-at-once", "two at the same time"],
  ["budget-exhaustion", "a ₹20 budget"],
  ["kill-switch", "everything refused"],
  ["calm", "nothing happens"],
];

/**
 * How to describe a record whose `allowed` is false.
 *
 * `allowed` is overloaded: the kernel refusing an action, the policy layer declining to propose one,
 * and a controller releasing authority it no longer needs all write the same false. Only the first
 * names a binding axis, so that is the discriminator available here — the same one the CLI uses. It
 * separates a real refusal from the other two and cannot separate a decline from a release, so both
 * are reported as declined rather than guessed at.
 */
export function verdictOf(allowed: boolean, binding: string | null): readonly [string, string] {
  if (allowed) return ["ok", "allowed"];
  return binding === null ? ["de", "declined"] : ["no", "REFUSED"];
}

/** `netbanking|hdfc|` reads as `netbanking hdfc`. */
export function railLabel(key: string): string {
  return key.split("|").filter(Boolean).join(" ");
}
