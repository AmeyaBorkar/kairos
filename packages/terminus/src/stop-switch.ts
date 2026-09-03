import type { Mandate } from "@kairos/domain";
import type { ApplyOutcome, Store, Transform } from "throttlekit";
import type { KillSwitch } from "./ports.js";

/**
 * The out-of-band stop, in the store the fleet already shares.
 *
 * The second of the two stops. The signed one is a field on the mandate: set `killSwitch`, re-seal,
 * and everything halts the moment each worker verifies the new mandate. It cannot be cleared by
 * anybody who cannot sign, which is right for a decision somebody should have to be authorised to
 * reverse — and wrong for the situation a stop is actually for. The moment you most need to halt a
 * campaign is the moment you least want to be re-signing authority and rolling processes.
 *
 * This one is a flag in the same store the budget and the contact caps live in, so it is flipped by
 * one command, is visible to every worker and every sentry, and takes effect on the next admission
 * with no redeploy and nothing re-signed. Either stop halts everything; neither can be bypassed by
 * a process that has forgotten to check, because the check is inside `admit`.
 *
 * ## A read that fails counts as engaged
 *
 * P2 applied to the stop itself. If the store is unreachable we cannot tell whether somebody has
 * told us to stop, and the only safe reading of "I do not know" is that we have been told to stop.
 * This is the one place in Kairos where losing the database halts spending rather than falling back
 * to a local decision — which is correct, and worth being explicit about, because it means a
 * database outage stops the recovery arm. That is the trade the kill switch exists to make.
 *
 * ## Scoped to the campaign, not the deployment
 *
 * Keyed by merchant and campaign. An operator stopping one campaign is not asking to stop every
 * other campaign that happens to share a database, and a switch that could not be aimed would be
 * one nobody dares use.
 */
export interface StopSwitchState {
  readonly engagedAt: number | null;
  /** Free text from whoever engaged it. Read back by `status`, so it is worth writing well. */
  readonly reason: string | null;
  readonly by: string | null;
}

const CLEAR: StopSwitchState = { engagedAt: null, reason: null, by: null };

/**
 * A year.
 *
 * The store's contract has no "never": `ttlMs` is required and zero means gone immediately. So the
 * honest thing is to state a number and say why this one. A stop that lapsed while its campaign was
 * still running would be the worst bug this file could have, and a year is far longer than any
 * campaign Kairos is meant to run — mandates are authored in days and weeks. If one ever did lapse,
 * every worker resumes under authority that is still signed and still valid, which is why this is
 * the number that matters rather than a detail.
 */
const STOP_TTL_MS = 365 * 86_400_000;

export function stopSwitchKey(merchantId: string, campaignId: string): string {
  return `kairos:stop:${merchantId}:${campaignId}`;
}

function transform<R>(
  op: (state: StopSwitchState) => { state: StopSwitchState; result: R; persist: boolean },
): Transform<StopSwitchState, R> {
  return (prior: StopSwitchState | undefined): ApplyOutcome<StopSwitchState, R> => {
    const { state, result, persist } = op(prior ?? CLEAR);
    return { state, result, ttlMs: STOP_TTL_MS, persist };
  };
}

export class StopSwitch implements KillSwitch {
  readonly #store: Store;

  constructor(store: Store) {
    this.#store = store;
  }

  /**
   * Whether this mandate's campaign has been stopped.
   *
   * Never throws. A caller of this is inside an admission decision, and an exception there would
   * propagate as a failure rather than as a refusal — which is a different thing to the operator
   * reading the ledger, and the wrong thing when the answer we are unsure about is "stop".
   */
  async engaged(mandate: Mandate): Promise<boolean> {
    try {
      return (await this.read(mandate.merchantId, mandate.campaignId)).engagedAt !== null;
    } catch {
      return true;
    }
  }

  /** The switch as it stands, for an operator rather than for an admission. Throws if unreadable. */
  read(merchantId: string, campaignId: string): Promise<StopSwitchState> {
    return this.#store.apply(
      stopSwitchKey(merchantId, campaignId),
      transform((state) => ({ state, result: state, persist: false })),
    );
  }

  /**
   * Stop the campaign.
   *
   * Idempotent, and deliberately does not overwrite an existing stop: the first reason is the one
   * that matters, and a second operator arriving to help should not quietly replace the account of
   * why everything halted. Returns the state in force, which is the first one if there was one.
   */
  engage(
    merchantId: string,
    campaignId: string,
    at: number,
    reason: string,
    by: string,
  ): Promise<StopSwitchState> {
    return this.#store.apply(
      stopSwitchKey(merchantId, campaignId),
      transform((prior) => {
        if (prior.engagedAt !== null) return { state: prior, result: prior, persist: false };
        const state: StopSwitchState = { engagedAt: at, reason, by };
        return { state, result: state, persist: true };
      }),
    );
  }

  /** Let it run again. Returns what was in force, so the caller can report what it released. */
  release(merchantId: string, campaignId: string): Promise<StopSwitchState> {
    return this.#store.apply(
      stopSwitchKey(merchantId, campaignId),
      transform((prior) => ({ state: CLEAR, result: prior, persist: true })),
    );
  }
}
