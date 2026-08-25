import { createHash } from "node:crypto";
import type { ActionKind, CasualtyId, CustomerRef, IncidentId } from "@kairos/domain";
import { canonicalize } from "@kairos/ledger";

export interface ActionIdentity {
  readonly kind: ActionKind;
  readonly customer: CustomerRef;
  readonly casualty: CasualtyId | null;
  readonly incident: IncidentId | null;
  /** Which attempt at this action this is. The term that makes a deliberate retry a *new* action. */
  readonly attemptNo: number;
}

/**
 * The deterministic key for one action.
 *
 * Two things ride on this being a pure function of the action's identity rather than a random id.
 *
 * **Crash safety.** A worker that reserves budget, dies, and restarts derives the same key and gets
 * its own reservation back instead of committing a second one. There is no recovery protocol to get
 * wrong, because there is no state to reconcile — the key *is* the reconciliation.
 *
 * **Idempotency at the gateway.** The same value is passed to Razorpay and to the messaging
 * provider as their idempotency key, so a crash-and-retry cannot double-charge a customer or send
 * the same message twice, and where a provider offers no such key the ledger is consulted instead.
 *
 * `attemptNo` is what keeps a deliberate second attempt distinguishable from an accidental repeat
 * of the first: a genuine retry increments it and is a new action with new authority; a replay does
 * not, and gets the original grant.
 */
export function actionKey(identity: ActionIdentity): string {
  const canonical = canonicalize({
    kind: identity.kind,
    customer: identity.customer,
    casualty: identity.casualty,
    incident: identity.incident,
    attemptNo: identity.attemptNo,
  });
  return createHash("sha256")
    .update("kairos.action.v1\n", "utf8")
    .update(canonical, "utf8")
    .digest("hex")
    .slice(0, 32);
}
