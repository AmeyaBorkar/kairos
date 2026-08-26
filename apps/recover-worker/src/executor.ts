import { type ActionKind, acceptableFirstName, type Paise, smsCostPaise } from "@kairos/domain";
import { compose, type Gateway, type MessageChannel, type Messenger } from "@kairos/razorpay";
import type { ExecuteRequest, ExecuteResult, Executor } from "@kairos/recover";

export interface RecoveryExecutorOptions {
  readonly gateway: Gateway;
  readonly messenger: Messenger;
  /** Builds the single-use URL a message points at. A port, because it is a merchant's own domain. */
  readonly linkFor: (request: ExecuteRequest) => string;
  /** Price per SMS segment, in paise. Everything else bills per message. */
  readonly smsSegmentPaise: number;
  /** Human names for institutions, for the copy that mentions one. */
  readonly institutionName?: (issuer: string | null) => string | null;
}

/**
 * Turns an authorised grant into a charge or a message.
 *
 * The last mile, and the only place in the recovery arm that touches the outside world. Everything
 * that decided *whether* to do this is upstream and pure; everything downstream reconciles what it
 * cost. This layer's whole job is to be the thin, boring part.
 *
 * It reads the action kind off the grant rather than deciding anything itself. That is deliberate:
 * the grant is what Terminus authorised, and an executor that chose its own action could send a
 * message under authority granted for a retry.
 */
export class RecoveryExecutor implements Executor {
  readonly #options: RecoveryExecutorOptions;

  constructor(options: RecoveryExecutorOptions) {
    this.#options = options;
  }

  execute(request: ExecuteRequest): Promise<ExecuteResult> {
    const kind = request.grant.action.kind;
    if (kind === "retry") return this.#charge(request);
    if (isMessageChannel(kind)) return this.#message(request, kind);
    // `steer` and `escalate` are in the action vocabulary and are not this executor's to perform.
    // Reporting rather than throwing keeps a misrouted grant a reconciled non-event instead of an
    // exception that leaves the authority held until its TTL expires.
    return Promise.resolve({
      outcome: "undeliverable",
      costPaise: 0,
      externalRef: null,
      optedOut: false,
    });
  }

  /**
   * Charge the payment again.
   *
   * A retry without a token is not a cheaper retry, it is an impossible one — see ADR 0004. Rather
   * than falling back to a message, this reports the action as undeliverable and lets the decision
   * layer choose again with the correct information next time. Silently substituting a contact for
   * a retry would spend a contact allowance the grant did not authorise.
   */
  async #charge(request: ExecuteRequest): Promise<ExecuteResult> {
    if (request.token === null) {
      return { outcome: "undeliverable", costPaise: 0, externalRef: null, optedOut: false };
    }

    const result = await this.#options.gateway.charge({
      idempotencyKey: request.grant.id,
      orderId: request.casualty.orderId,
      customer: request.casualty.customer,
      amount: request.casualty.amount,
      token: request.token,
    });

    return {
      outcome: result.outcome,
      costPaise: result.costPaise,
      externalRef: result.externalRef,
      optedOut: false,
    };
  }

  /**
   * Compose and send.
   *
   * Composition happens before dispatch so the cost is known before the money moves, and the
   * segment count is passed along rather than recomputed downstream — a provider that counts
   * differently is a discrepancy worth seeing in the ledger rather than one worth hiding.
   */
  async #message(request: ExecuteRequest, channel: MessageChannel): Promise<ExecuteResult> {
    const message = compose(request.classification.recoverability, {
      // Rejected rather than sanitised: a "name" carrying a URL is a phishing campaign sent over the
      // merchant's own sender id.
      firstName: acceptableFirstName(request.firstName),
      amount: request.casualty.amount as Paise,
      link: this.#options.linkFor(request),
      institution: this.#institution(request.casualty.slice.issuer),
    });

    const result = await this.#options.messenger.send({
      idempotencyKey: request.grant.id,
      channel,
      customer: request.casualty.customer,
      text: message.text,
      segments: message.cost.segments,
    });

    // The provider's own figure is authoritative when it gives one; the composed estimate is the
    // fallback, because a cost nobody reported is still a cost that was incurred.
    const costPaise =
      result.costPaise > 0
        ? result.costPaise
        : channel === "contact-sms"
          ? smsCostPaise(message.text, this.#options.smsSegmentPaise)
          : 0;

    return {
      outcome: result.delivered ? "delivered" : "undeliverable",
      costPaise: result.delivered ? costPaise : 0,
      externalRef: result.externalRef,
      optedOut: false,
    };
  }

  #institution(issuer: string | null): string | null {
    if (issuer === null) return null;
    const named = this.#options.institutionName?.(issuer);
    return named ?? issuer.toUpperCase();
  }
}

/** The contact kinds this executor can actually deliver, narrowed for the type system. */
function isMessageChannel(kind: ActionKind): kind is MessageChannel {
  return kind === "contact-sms" || kind === "contact-whatsapp" || kind === "contact-email";
}
