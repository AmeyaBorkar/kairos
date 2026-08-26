/**
 * The generation loop: ask, validate, keep, settle.
 *
 * Small, and the interesting part is what it refuses to do.
 *
 * ## Every call is admitted, reserved and reconciled
 *
 * Not because a copy-generation run is a plausible way to lose money, but because the claim this
 * whole system rests on is that *nothing* spends without signed authority — and an exception carved
 * out for the cheap channel is not a bound, it is a habit. So the loop takes a Terminus grant before
 * each call, at a ceiling computed from the prompt it is about to send, and settles it against the
 * tokens the provider says were consumed. A budget that runs out stops the run mid-library, which is
 * a legitimate outcome and the reason the next section exists.
 *
 * ## Stopping early is normal
 *
 * Three things stop this run and none of them is an error: the campaign budget, the provider's daily
 * quota, and somebody pressing ctrl-C. All three leave a partial library, and a partial library is a
 * working one — `Copy.variantsFor` returns nothing for a segment nobody wrote, and the recovery arm
 * falls back to the hand-written template for exactly those situations. So the loop writes what it
 * has, reports where it stopped, and a later run resumes from the segments still missing.
 *
 * On a free tier that is not a nicety. Fifteen requests a minute and a few hundred a day means a
 * full library is a run that can plausibly be interrupted, and a generator that could only work
 * atomically would never finish one.
 *
 * ## A rejection is data
 *
 * Copy that fails the gauntlet is counted by rejection code and reported. `reason.fallbackRate` is a
 * gated metric, and a rate that climbs is only actionable if the report can say the model started
 * writing URLs rather than merely that it started failing.
 */

import { customerRef, type Paise, paise } from "@kairos/domain";
import type {
  Composer,
  CopySegment,
  CopyVariant,
  ModelPrice,
  RejectionCode,
  Usage,
} from "@kairos/reason";
import { priceOf, reservationFor, segmentKey, validate } from "@kairos/reason";
import { budgetFor } from "@kairos/reasoner-gemini";
import { CLEAN_STATUS, type Terminus } from "@kairos/terminus";
import { gauntletFor, requestFor } from "./policy.js";

export interface GenerateOptions {
  readonly terminus: Terminus;
  readonly composer: Composer;
  readonly price: ModelPrice;
  /** What to write. Already filtered to what is missing — see {@link Copy.missing}. */
  readonly segments: readonly CopySegment[];
  readonly deadlineMs: number;
  readonly onEvent?: (event: SegmentOutcome) => void;
}

export interface SegmentOutcome {
  readonly segment: CopySegment;
  readonly key: string;
  readonly accepted: readonly CopyVariant[];
  readonly rejected: readonly { readonly body: string; readonly codes: readonly RejectionCode[] }[];
  /** Set when nothing was asked, because something refused before the call. */
  readonly refusal: string | null;
  readonly spentPaise: number;
}

export interface GenerateResult {
  readonly variants: readonly CopyVariant[];
  readonly rejections: ReadonlyMap<RejectionCode, number>;
  readonly proposed: number;
  readonly calls: number;
  readonly spentPaise: number;
  readonly usage: Usage;
  /** Why the run ended before the list did, or `null` if it did not. */
  readonly stoppedBecause: string | null;
  /** Segments never attempted, because the run stopped. */
  readonly unattempted: readonly CopySegment[];
}

const NOTHING: Usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };

export async function generate(options: GenerateOptions): Promise<GenerateResult> {
  const { terminus, composer, price, segments, deadlineMs } = options;

  const variants: CopyVariant[] = [];
  const rejections = new Map<RejectionCode, number>();
  let proposed = 0;
  let calls = 0;
  let spentPaise = 0;
  let usage = NOTHING;
  let stoppedBecause: string | null = null;

  for (const [index, segment] of segments.entries()) {
    if (stoppedBecause !== null) {
      return {
        variants,
        rejections,
        proposed,
        calls,
        spentPaise,
        usage,
        stoppedBecause,
        unattempted: segments.slice(index),
      };
    }

    const key = segmentKey(segment);
    const request = requestFor(segment);
    const { inputTokens, outputTokens } = budgetFor(request);
    const ceiling = reservationFor(inputTokens, outputTokens, price);

    const admission = await terminus.admit({
      action: {
        kind: "reason",
        // A model call has no customer, and this is the reference that says so rather than a
        // borrowed one that would put a segment key where an audit reader expects a person. The
        // kernel already exempts `reason` from the contact cap, so this is never a cap key.
        customer: customerRef(`segment:${key}`),
        casualty: null,
        incident: null,
        estimatedCost: ceiling,
        expectedValue: paise(0),
        successProbability: 0,
        rationale: `write ${request.variants} variants for ${key}`,
      },
      status: CLEAN_STATUS,
      attemptNo: 1,
    });

    if (!admission.allowed) {
      // The refusal ends the run rather than skipping the segment. Every axis that can refuse a
      // `reason` action here — budget, kill switch, mandate validity — is a condition the next
      // segment would meet too, so continuing would be a hundred and eighty identical refusals
      // written to the ledger.
      stoppedBecause = `${admission.axis}: ${admission.reason}`;
      options.onEvent?.({
        segment,
        key,
        accepted: [],
        rejected: [],
        refusal: stoppedBecause,
        spentPaise: 0,
      });
      continue;
    }

    const grant = admission.grant;
    let outcome: SegmentOutcome;

    try {
      const result = await composer.compose(request, deadlineMs);
      calls++;
      usage = add(usage, result.usage);

      const actual = priceOf(result.usage, price);
      await terminus.settle(grant, actual, "composed", key);
      spentPaise += actual;

      const accepted: CopyVariant[] = [];
      const rejected: { body: string; codes: RejectionCode[] }[] = [];

      for (const proposal of result.value) {
        proposed++;
        const verdict = validate(
          proposal.body,
          proposal.subject,
          segment,
          key,
          gauntletFor(segment),
        );
        if (verdict.ok) {
          accepted.push(verdict.variant);
        } else {
          const codes = verdict.rejections.map((rejection) => rejection.code);
          for (const code of codes) rejections.set(code, (rejections.get(code) ?? 0) + 1);
          rejected.push({ body: proposal.body, codes });
        }
      }

      // Two variants with identical text are one arm the bandit will explore twice. The model is
      // asked for genuinely different versions and mostly obliges; this is what happens when it
      // does not, and it is cheaper to drop the duplicate than to measure it twice.
      const unique = accepted.filter(
        (variant, at) => accepted.findIndex((other) => other.id === variant.id) === at,
      );
      variants.push(...unique);

      outcome = { segment, key, accepted: unique, rejected, refusal: null, spentPaise: actual };
    } catch (error: unknown) {
      // The grant is handed back rather than settled: no tokens were reported, so there is nothing
      // to reconcile, and a reservation left to expire would hold budget for its whole TTL while
      // the run carried on spending against what is left.
      await terminus.abandon(grant, "the model call failed");
      const message = error instanceof Error ? error.message : String(error);
      if (isTerminal(error)) stoppedBecause = message;
      outcome = { segment, key, accepted: [], rejected: [], refusal: message, spentPaise: 0 };
    }

    options.onEvent?.(outcome);
  }

  return {
    variants,
    rejections,
    proposed,
    calls,
    spentPaise,
    usage,
    stoppedBecause,
    unattempted: [],
  };
}

function add(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
  };
}

/**
 * Whether a failure means the next segment would fail too.
 *
 * A `throttled` error from the pacer is the day's quota, not a hiccup — the transport has already
 * exhausted its retries and the shaper has already waited. Carrying on would spend the rest of the
 * list discovering the same thing a hundred and seventy times.
 *
 * Read off the adapter's `kind` structurally rather than by importing its error class, so that a
 * second provider's adapter is a drop-in without this file learning about it.
 */
function isTerminal(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const kind = (error as { kind?: unknown }).kind;
  return kind === "throttled" || kind === "unauthorised";
}

/** What the run cost, at list rate, whoever was billed. */
export function costOf(usage: Usage, price: ModelPrice): Paise {
  return priceOf(usage, price);
}
