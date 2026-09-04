import { StopSwitch, type StopSwitchState } from "@kairos/terminus";
import type { Store } from "throttlekit";

/**
 * The stop, as an operator uses it.
 *
 * Deliberately in this app rather than a new one. A mandate is authority granted; the stop is
 * authority withdrawn in a hurry, and somebody who needs the second at three in the morning should
 * not have to remember that it lives somewhere else.
 *
 * It needs the database and not the signing key, which is the opposite of every other command here
 * and is the whole point. Stopping a campaign must not require the ability to mint one — the person
 * on call is not necessarily the person who holds the key, and a stop nobody on shift can reach is
 * not a stop.
 */
export interface StopTarget {
  readonly merchantId: string;
  readonly campaignId: string;
}

export type StopReport = readonly string[];

function stamp(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19).replace("T", " ")}Z`;
}

function describe(state: StopSwitchState, now: number): StopReport {
  if (state.engagedAt === null) {
    return ["RUNNING", "  No stop is in force. Workers admit actions subject to the usual bounds."];
  }
  const heldFor = Math.max(0, now - state.engagedAt);
  return [
    "STOPPED",
    `  Since   ${stamp(state.engagedAt)}   (${duration(heldFor)} ago)`,
    `  By      ${state.by ?? "unrecorded"}`,
    `  Reason  ${state.reason ?? "unrecorded"}`,
    "",
    "  Every admission under this campaign is refused, fleet-wide, on the next pass.",
    "  Nothing has been un-signed: release it and the same mandate is in force again.",
  ];
}

function duration(ms: number): string {
  if (ms >= 86_400_000) return `${Math.round(ms / 86_400_000)}d`;
  if (ms >= 3_600_000) return `${Math.round(ms / 3_600_000)}h`;
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 1000)}s`;
}

export async function status(store: Store, target: StopTarget, now: number): Promise<StopReport> {
  const state = await new StopSwitch(store).read(target.merchantId, target.campaignId);
  return [`Campaign ${target.merchantId}/${target.campaignId}`, "", ...describe(state, now)];
}

export async function engage(
  store: Store,
  target: StopTarget,
  now: number,
  reason: string,
  by: string,
): Promise<StopReport> {
  const state = await new StopSwitch(store).engage(
    target.merchantId,
    target.campaignId,
    now,
    reason,
    by,
  );
  const already = state.engagedAt !== now;
  return [
    `Campaign ${target.merchantId}/${target.campaignId}`,
    "",
    ...describe(state, now),
    "",
    already
      ? "  It was already stopped, so your reason was not recorded over the first one."
      : "  Engaged now. It takes effect on each worker's next admission, not on a redeploy.",
  ];
}

export async function release(store: Store, target: StopTarget, now: number): Promise<StopReport> {
  const was = await new StopSwitch(store).release(target.merchantId, target.campaignId);
  if (was.engagedAt === null) {
    return [
      `Campaign ${target.merchantId}/${target.campaignId}`,
      "",
      "RUNNING",
      "  Nothing was stopped. Released anyway, which changes nothing.",
    ];
  }
  return [
    `Campaign ${target.merchantId}/${target.campaignId}`,
    "",
    "RUNNING",
    `  Released a stop engaged ${stamp(was.engagedAt)} by ${was.by ?? "unrecorded"}.`,
    `  Its reason was: ${was.reason ?? "unrecorded"}`,
    "",
    "  Workers resume on their next pass, under the mandate that was always in force.",
    "  Anything the queue held while stopped is still queued; nothing was dropped.",
  ];
}
