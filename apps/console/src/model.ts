/**
 * What an operator can see, as data.
 *
 * The console's read model, defined here and rendered elsewhere. Everything in this file is a
 * plain, serialisable view — no engine, no clock, no ports — so that the interface a UI is built
 * against is a shape somebody can read in one sitting and does not change when a component behind
 * it does.
 *
 * ## It says it is a simulation
 *
 * {@link ConsoleSnapshot.provenance} carries the scenario name and the seed, and every response
 * includes it. That is not a disclaimer bolted on: a dashboard showing red rails and rupee figures
 * is exactly the kind of artifact that gets screenshotted into a slide, and a screenshot that does
 * not say where its numbers came from is a claim about a real merchant. The one place this system
 * must not be casual is in letting simulated money look like collected money.
 *
 * ## Four questions, and nothing else
 *
 * ARCHITECTURE §4 says the console answers: what is the rail health, what incidents are open, which
 * bound is binding, and what does the audit trail say. The model has exactly four sections for
 * those and no fifth for anything that would merely be interesting. A console that grows a chart
 * per available number becomes a thing nobody reads during an incident, which is the only time it
 * matters.
 */

import type { Language } from "@kairos/domain";
import type { TimelineEntry } from "@kairos/reason";

/** Where every number on the page came from. Present on every response. */
export interface Provenance {
  /** `simulated` today, and there is no other value yet. See the note at the top of this file. */
  readonly kind: "simulated";
  readonly scenario: string;
  readonly seed: number;
  /** The simulated instant this snapshot describes, not the wall clock. */
  readonly at: number;
  /** Real milliseconds of simulated time per real second, so a UI can show the speed-up. */
  readonly speed: number;
}

/** One rail, as the detector currently sees it. */
export interface RailView {
  readonly key: string;
  readonly method: string;
  readonly issuer: string | null;
  /** Attempts in the most recent window. A rate over four attempts is not evidence. */
  readonly attempts: number;
  readonly failureRate: number;
  /**
   * What the detector believes, which is deliberately not what is true.
   *
   * `degraded` means an incident is open on this rail or a parent of it. The simulator knows the
   * ground truth and the console does not show it, because a console that displayed both would be
   * showing an operator a comparison no operator will ever have.
   */
  readonly state: "healthy" | "watching" | "degraded";
  /** The detector's running statistic, so a UI can show evidence accumulating before it fires. */
  readonly statistic: number;
  readonly threshold: number;
  /** Whether traffic is currently being steered off this rail, and how. */
  readonly steer: "none" | "demoted" | "suppressed";
}

export interface IncidentView {
  readonly id: string;
  readonly slice: string;
  readonly openedAt: number;
  readonly closedAt: number | null;
  /** How long the detector took from the true onset. Null while the onset is unknown to it. */
  readonly detectionLatencyMs: number | null;
  readonly peakFailureRate: number;
  /** Casualties intake has attributed to this incident so far. */
  readonly casualties: number;
}

/**
 * The bounds in force and how close each is to binding.
 *
 * The section this console exists for. Every other payments dashboard shows what a system did; the
 * claim Kairos makes is about what it *cannot* do, and a claim about limits is worth nothing if the
 * limits are invisible until they fire. `utilisation` is the fraction of the bound consumed, so a
 * UI can show the one that is about to bind rather than the one that already has.
 */
export interface BoundView {
  readonly axis: string;
  readonly limit: string;
  readonly current: string;
  readonly utilisation: number;
  /** How many times this bound has actually refused something in this run. */
  readonly refusals: number;
}

export interface LedgerView {
  /** Whether the chain still hashes end to end, recomputed on read rather than remembered. */
  readonly verified: boolean;
  readonly records: number;
  /** The most recent entries, newest first, already redacted. */
  readonly recent: readonly TimelineEntry[];
}

/** What the recovery arm has done, and in whose language. */
export interface RecoveryView {
  readonly casualties: number;
  readonly queued: number;
  readonly contacted: number;
  readonly recoveredPaise: number;
  readonly spentPaise: number;
  /** Share of messages served by the generated library rather than a template. */
  readonly fromLibrary: number;
  /** Share that reached somebody in a script they read. */
  readonly legible: number;
  readonly byLanguage: Readonly<Record<Language, number>>;
}

export interface ConsoleSnapshot {
  readonly provenance: Provenance;
  readonly rails: readonly RailView[];
  readonly incidents: readonly IncidentView[];
  readonly bounds: readonly BoundView[];
  readonly ledger: LedgerView;
  readonly recovery: RecoveryView;
}

export const EMPTY_RECOVERY: RecoveryView = {
  casualties: 0,
  queued: 0,
  contacted: 0,
  recoveredPaise: 0,
  spentPaise: 0,
  fromLibrary: 0,
  legible: 0,
  byLanguage: { en: 0, hi: 0, mr: 0, ta: 0 },
};
