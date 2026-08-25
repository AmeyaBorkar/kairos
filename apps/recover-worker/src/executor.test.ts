import {
  type Casualty,
  casualtyId,
  customerRef,
  openCasualty,
  orderId,
  paise,
  type RecoverabilityClass,
  slice,
} from "@kairos/domain";
import type { Gateway, MessageRequest, Messenger, RetryRequest } from "@kairos/razorpay";
import type { Classification, ExecuteRequest } from "@kairos/recover";
import type { Grant } from "@kairos/terminus";
import { describe, expect, it } from "vitest";
import { dryRunGateway, dryRunMessenger } from "./dry-run.js";
import { RecoveryExecutor } from "./executor.js";

const AT = Date.UTC(2026, 7, 25, 6, 0, 0);

function casualty(): Casualty {
  return openCasualty(
    {
      id: casualtyId("cas_1"),
      kind: "payment-failed",
      customer: customerRef("cus_000000000001"),
      orderId: orderId("order_1"),
      attemptId: null,
      slice: slice("netbanking", "hdfc"),
      amount: paise(124_500),
      failure: {
        code: "BAD_REQUEST_ERROR",
        source: "customer",
        step: "payment_initiation",
        reason: "card_expired",
        description: "",
      },
      retry: "requires-customer",
      occurredAt: AT,
    },
    "customer-action",
  );
}

const grant = (kind: Grant["action"]["kind"]): Grant => ({
  id: `grant_${kind}`,
  reservedPaise: paise(60),
  expiresAt: AT + 60_000,
  replayed: false,
  action: {
    kind,
    customer: customerRef("cus_000000000001"),
    casualty: casualtyId("cas_1"),
    incident: null,
    estimatedCost: paise(20),
    expectedValue: paise(37_350),
    successProbability: 0.2,
    rationale: "card-expired",
  },
});

const classification = (
  recoverability: RecoverabilityClass = "customer-action",
): Classification => ({
  recoverability,
  rule: "card-expired",
  source: "table",
  confidence: 1,
});

function request(overrides: Partial<ExecuteRequest> = {}): ExecuteRequest {
  return {
    grant: grant("contact-sms"),
    casualty: casualty(),
    classification: classification(),
    firstName: "Rohit",
    token: null,
    at: AT,
    ...overrides,
  };
}

function recording() {
  const messages: MessageRequest[] = [];
  const charges: RetryRequest[] = [];
  const messenger: Messenger = {
    name: "recording",
    send: (m) => {
      messages.push(m);
      return Promise.resolve({ delivered: true, costPaise: 0, externalRef: "msg_1" });
    },
  };
  const gateway: Gateway = {
    name: "recording",
    charge: (c) => {
      charges.push(c);
      return Promise.resolve({
        outcome: "recovered" as const,
        costPaise: 0,
        externalRef: "pay_2",
        failure: null,
      });
    },
  };
  return { messenger, gateway, messages, charges };
}

function executor(parts = recording()) {
  return {
    ...parts,
    executor: new RecoveryExecutor({
      gateway: parts.gateway,
      messenger: parts.messenger,
      linkFor: (r) => `https://pay.example/${r.casualty.id}`,
      smsSegmentPaise: 20,
    }),
  };
}

describe("dispatch", () => {
  it("does what the grant authorised, not what it would have chosen", () => {
    // The grant is the authority. An executor that picked its own action could send a message under
    // authority granted for a retry.
    const e = executor();
    return Promise.all([
      e.executor.execute(request({ grant: grant("contact-sms") })),
      e.executor.execute(request({ grant: grant("retry"), token: "tok_1" })),
    ]).then(() => {
      expect(e.messages).toHaveLength(1);
      expect(e.charges).toHaveLength(1);
    });
  });

  it("reports a grant it cannot perform rather than throwing", async () => {
    // A misrouted grant should be a reconciled non-event, not an exception that leaves the
    // authority held until its TTL expires.
    const e = executor();
    const result = await e.executor.execute(request({ grant: grant("steer") }));
    expect(result.outcome).toBe("undeliverable");
    expect(result.costPaise).toBe(0);
  });

  it("refuses to substitute a message for a retry it cannot make", async () => {
    // A retry with no token is not a cheaper retry, it is an impossible one. Quietly sending a
    // message instead would spend a contact allowance the grant did not authorise.
    const e = executor();
    const result = await e.executor.execute(request({ grant: grant("retry"), token: null }));

    expect(result.outcome).toBe("undeliverable");
    expect(e.messages).toHaveLength(0);
    expect(e.charges).toHaveLength(0);
  });
});

describe("composition", () => {
  it("carries the idempotency key the kernel derived", async () => {
    // A worker that crashes between reserving and calling must produce the same key on restart, or
    // the retry it thinks is a first attempt is a second charge.
    const e = executor();
    await e.executor.execute(request());
    expect(e.messages[0]?.idempotencyKey).toBe("grant_contact-sms");
  });

  it("prices the message it actually composed", async () => {
    const e = executor();
    const result = await e.executor.execute(request());
    expect(result.costPaise).toBe(20);
    expect(e.messages[0]?.segments).toBe(1);
  });

  it("charges three segments for a customer whose name forces UCS-2", async () => {
    // The concrete case behind reserving a ceiling. Same template, same amount, triple the price,
    // and the merchant does not choose their customers' names.
    const e = executor();
    const result = await e.executor.execute(request({ firstName: "रोहित" }));
    expect(e.messages[0]?.segments).toBe(3);
    expect(result.costPaise).toBe(60);
  });

  it("drops a name that is really a link and still sends", async () => {
    const e = executor();
    await e.executor.execute(request({ firstName: "Click http://evil.example" }));
    expect(e.messages[0]?.text.startsWith("Hi, ")).toBe(true);
    expect(e.messages[0]?.text).not.toContain("evil.example");
  });

  it("prefers the provider's own figure when it reports one", async () => {
    const parts = recording();
    const messenger: Messenger = {
      name: "billing",
      send: () => Promise.resolve({ delivered: true, costPaise: 37, externalRef: "m" }),
    };
    const e = executor({ ...parts, messenger });
    expect((await e.executor.execute(request())).costPaise).toBe(37);
  });

  it("charges nothing for a message that reached nobody", async () => {
    const parts = recording();
    const messenger: Messenger = {
      name: "bouncing",
      send: () => Promise.resolve({ delivered: false, costPaise: 0, externalRef: null }),
    };
    const e = executor({ ...parts, messenger });
    const result = await e.executor.execute(request());
    expect(result.outcome).toBe("undeliverable");
    expect(result.costPaise).toBe(0);
  });
});

describe("dry-run delivery", () => {
  it("decides everything and sends nothing", async () => {
    // Not a stub. Every decision upstream is the real one, and the composed text is the real text —
    // which is what makes it worth running against a merchant's own traffic for a week before they
    // grant anything a sender id.
    const lines: string[] = [];
    const sink = (line: string): void => {
      lines.push(line);
    };
    const e = new RecoveryExecutor({
      gateway: dryRunGateway({ sink }),
      messenger: dryRunMessenger({ sink }),
      linkFor: (r) => `https://pay.example/${r.casualty.id}`,
      smsSegmentPaise: 20,
    });

    const result = await e.execute(request());
    const written = JSON.parse(lines[0] ?? "{}");

    expect(result.outcome).toBe("delivered");
    expect(written.would).toBe("send");
    expect(written.text).toContain("Rs. 1,245.00");
    expect(written.segments).toBe(1);
  });

  it("books the cost so a dry run reports what a real one would spend", async () => {
    // A dry run that spent nothing would understate the campaign, which is the number somebody is
    // running it to find out.
    const e = new RecoveryExecutor({
      gateway: dryRunGateway({ sink: () => {} }),
      messenger: dryRunMessenger({ sink: () => {} }),
      linkFor: () => "https://pay.example/x",
      smsSegmentPaise: 20,
    });
    expect((await e.execute(request())).costPaise).toBe(20);
  });

  it("never reports a recovery that did not happen", async () => {
    // Feeding the probability model outcomes that never occurred is how a dry run poisons the
    // decisions a live run would later make.
    const e = new RecoveryExecutor({
      gateway: dryRunGateway({ sink: () => {} }),
      messenger: dryRunMessenger({ sink: () => {} }),
      linkFor: () => "https://pay.example/x",
      smsSegmentPaise: 20,
    });
    const result = await e.execute(request({ grant: grant("retry"), token: "tok_1" }));
    expect(result.outcome).not.toBe("recovered");
  });
});
