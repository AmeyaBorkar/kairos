import { MemoryLedger } from "@kairos/ledger";
import type { Explainer, ExplanationRequest, ModelResult } from "@kairos/reason";
import { describe, expect, it } from "vitest";
import { explain } from "./explain.js";
import { retrieve } from "./retrieve.js";

const AT = Date.UTC(2026, 7, 24, 9, 15);

function ledgerWith(): MemoryLedger {
  const ledger = new MemoryLedger();
  ledger.append({
    at: AT,
    actor: "recover-worker/3",
    action: "contact-sms",
    target: "cas_9f21",
    allowed: false,
    reason: "declined: already received 3 contacts in 7 days",
    binding: "contact-cap",
    externalRef: "pay_LEAKME",
    outcome: null,
    meta: { customerEmail: "rohit@example.com", attempt: 4 },
  });
  ledger.append({
    at: AT + 60_000,
    actor: "recover-worker/3",
    action: "contact-sms",
    target: "cas_other",
    allowed: true,
    reason: "sent",
    binding: null,
    externalRef: null,
    outcome: "delivered",
    meta: {},
  });
  return ledger;
}

/** An explainer that says exactly what the test tells it to. */
function saying(prose: string): Explainer {
  return {
    model: "test-model",
    explain(_request: ExplanationRequest): Promise<ModelResult<string>> {
      return Promise.resolve({
        value: prose,
        usage: { inputTokens: 10, outputTokens: 10, cachedInputTokens: 0 },
        model: "test-model",
      });
    },
  };
}

const BOUNDS = ["contact cap: 3 contacts per customer per 7 days"];

describe("retrieving a subject's history", () => {
  it("matches the target exactly rather than by prefix", () => {
    // A casualty id is opaque, and a substring match would let `cas_9f2` pull in `cas_9f21`'s
    // history — which is not a formatting bug, it is one customer's record inside another's answer.
    expect(retrieve(ledgerWith(), { target: "cas_9f2" }).timeline).toHaveLength(0);
    expect(retrieve(ledgerWith(), { target: "cas_9f21" }).timeline).toHaveLength(1);
  });

  it("drops everything that was not explicitly allowed through", () => {
    // An allowlist, not a filter. `meta` is an open map, so a filter over it would be a promise
    // about every key anybody ever adds; dropping it wholesale is a promise the code can keep.
    const serialised = JSON.stringify(retrieve(ledgerWith(), { target: "cas_9f21" }));
    expect(serialised).not.toContain("rohit@example.com");
    expect(serialised).not.toContain("pay_LEAKME");
    expect(serialised).toContain("contact-cap");
  });

  it("reports truncation rather than performing it silently", () => {
    // An answer built from half a history can be confidently wrong about the other half.
    const retrieved = retrieve(ledgerWith(), { target: "cas_9f21", limit: 0 });
    expect(retrieved.truncated).toBe(1);
    expect(retrieved.timeline).toHaveLength(0);
  });
});

describe("answering a question about a casualty", () => {
  it("returns the answer when every figure in it came from a record", async () => {
    const result = await explain({
      source: ledgerWith(),
      explainer: saying("It was not sent: the customer had already received 3 contacts in 7 days."),
      bounds: BOUNDS,
      target: "cas_9f21",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model).toBe("test-model");
    expect(result.cited).toContain("3");
  });

  it("refuses an answer that invented a figure, rather than captioning it", async () => {
    // The design decision worth arguing with. A warning printed above fluent prose is read by
    // nobody — an operator looking at an incident at two in the morning reads the sentence and acts
    // on it. If the check cannot vouch for the numbers there is no answer.
    const result = await explain({
      source: ledgerWith(),
      explainer: saying("It was held back after 9 previous attempts."),
      bounds: BOUNDS,
      target: "cas_9f21",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.why).toBe("unsupported-figures");
    expect(result.detail).toContain("9");
    // The rejected prose is kept, because the developer's next question is "what did it say?".
    expect(result.rejected).toContain("9 previous attempts");
  });

  it("does not ask a model to explain a history that does not exist", async () => {
    // Asking for an explanation of an empty timeline is an invitation to invent one, and the fix
    // for a wrong id is not a better prompt.
    let asked = false;
    const result = await explain({
      source: ledgerWith(),
      explainer: {
        model: "test-model",
        explain: () => {
          asked = true;
          return Promise.reject(new Error("should not be called"));
        },
      },
      bounds: BOUNDS,
      target: "cas_nothing",
    });

    expect(asked).toBe(false);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.why).toBe("no-records");
  });

  it("lets an answer quote a bound it was given, not only a record", async () => {
    // A refusal is explained with the limit that bound it, and the limit's figures live in the
    // mandate rather than in the audit record. An answer citing the cap is quoting.
    const result = await explain({
      source: ledgerWith(),
      explainer: saying("The cap is 3 contacts per customer per 7 days, and it bound here."),
      bounds: BOUNDS,
      target: "cas_9f21",
    });
    expect(result.ok).toBe(true);
  });
});
