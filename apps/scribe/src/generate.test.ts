import { type Mandate, mandateId, paise } from "@kairos/domain";
import { MemoryLedger } from "@kairos/ledger";
import type {
  ComposeRequest,
  Composer,
  CopySegment,
  ModelPrice,
  ModelResult,
  ProposedCopy,
} from "@kairos/reason";
import { bodyBudget, requiredSegments } from "@kairos/reason";
import { ManualClock, sealMandate, Terminus } from "@kairos/terminus";
import { MemoryStore } from "throttlekit";
import { describe, expect, it } from "vitest";
import { generate } from "./generate.js";
import { COVERAGE, MAX_WORST_CASE_SEGMENTS, segmentsFor, worstCaseSegmentsFor } from "./policy.js";

const DAY = 24 * 60 * 60 * 1000;
const SECRET = "test-secret";

const PRICE: ModelPrice = {
  model: "test-model",
  inputPaisePerMillion: 2400,
  outputPaisePerMillion: 14_400,
  cacheReadShare: 0.1,
  derivation: "test",
};

function segment(overrides: Partial<CopySegment> = {}): CopySegment {
  return {
    recoverability: "transient",
    channel: "contact-sms",
    language: "en",
    method: null,
    ...overrides,
  };
}

function mandate(overrides: Partial<Parameters<typeof sealMandate>[0]> = {}): Mandate {
  return sealMandate(
    {
      id: mandateId("mnd_test"),
      merchantId: "m",
      campaignId: "copy-library",
      budgetPaise: paise(100_000, "budget"),
      maxActionCostPaise: paise(1000, "ceiling"),
      maxInFlight: 1,
      reservationTtlMs: 60_000,
      contactCap: { limit: 1, windowMs: DAY },
      quietHours: null,
      allowedActions: ["reason"],
      validFrom: 0,
      validUntil: DAY,
      killSwitch: false,
      ...overrides,
    },
    SECRET,
  );
}

function kernel(overrides: Partial<Parameters<typeof sealMandate>[0]> = {}) {
  const ledger = new MemoryLedger();
  const clock = new ManualClock(1000);
  const terminus = new Terminus({
    mandate: mandate(overrides),
    secret: SECRET,
    store: new MemoryStore(),
    audit: ledger,
    actor: "scribe/test",
    clock,
  });
  return { terminus, ledger, clock };
}

/** A composer that answers with whatever it is told to, and counts how often it was asked. */
function composer(
  answer: (request: ComposeRequest, at: number) => readonly ProposedCopy[] | Error,
): Composer & { asked: () => number } {
  let at = 0;
  return {
    model: "test-model",
    asked: () => at,
    compose(request): Promise<ModelResult<readonly ProposedCopy[]>> {
      const produced = answer(request, at++);
      if (produced instanceof Error) return Promise.reject(produced);
      return Promise.resolve({
        value: produced,
        usage: { inputTokens: 600, outputTokens: 120, cachedInputTokens: 0 },
        model: "test-model",
      });
    },
  };
}

const GOOD = "the {institution} problem that stopped your {amount} payment is fixed. Pay: {link}";
const ALSO_GOOD = "{institution} is working again. Finish your {amount} payment here: {link}";
const NO_LINK = "your {amount} payment did not go through. Please try again at your convenience.";

/** Copy in the script the segment asked for. Latin text for a Hindi segment is a rejection. */
const IN_LANGUAGE: Readonly<Record<string, string>> = {
  en: GOOD,
  hi: "{institution} की समस्या ठीक हो गई है। अपना {amount} भुगतान यहाँ पूरा करें: {link}",
  mr: "{institution} ची अडचण दूर झाली आहे. तुमचे {amount} पेमेंट इथे पूर्ण करा: {link}",
  ta: "{institution} சிக்கல் சரி செய்யப்பட்டது. உங்கள் {amount} கட்டணத்தை இங்கே முடிக்கவும்: {link}",
};

const good = (request: ComposeRequest): readonly ProposedCopy[] => [
  { body: IN_LANGUAGE[request.segment.language] ?? GOOD, subject: null },
];

describe("generating a library", () => {
  it("keeps what clears the gauntlet and counts what does not, by name", async () => {
    const result = await generate({
      ...kernel(),
      composer: composer(() => [
        { body: GOOD, subject: null },
        { body: NO_LINK, subject: null },
      ]),
      price: PRICE,
      segments: [segment()],
      deadlineMs: 1000,
    });

    expect(result.variants).toHaveLength(1);
    expect(result.proposed).toBe(2);
    // The name is the point. `reason.fallbackRate` climbing is only actionable if the report can
    // say the model started writing URLs rather than merely that it started failing.
    expect([...result.rejections]).toEqual([["missing-placeholder", 1]]);
  });

  it("drops a duplicate rather than giving the bandit one arm twice", async () => {
    const result = await generate({
      ...kernel(),
      composer: composer(() => [
        { body: GOOD, subject: null },
        { body: GOOD, subject: null },
        { body: ALSO_GOOD, subject: null },
      ]),
      price: PRICE,
      segments: [segment()],
      deadlineMs: 1000,
    });
    expect(result.variants).toHaveLength(2);
  });

  it("throws away perfectly good English copy asked for in Hindi", async () => {
    // Found by a test fixture, which is the right place to find it. A model that answers an ask for
    // Hindi in English has not written a cheap message, it has written the wrong one — and the copy
    // reads fine, so nothing but the script check would catch it.
    const result = await generate({
      ...kernel(),
      composer: composer(() => [{ body: GOOD, subject: null }]),
      price: PRICE,
      segments: [segment({ language: "hi" })],
      deadlineMs: 1000,
    });
    expect(result.variants).toHaveLength(0);
    expect([...result.rejections]).toContainEqual(["wrong-script", 1]);
  });

  it("reserves before the call and settles against what was actually consumed", async () => {
    const { terminus, ledger } = kernel();
    const result = await generate({
      terminus,
      composer: composer(() => [{ body: GOOD, subject: null }]),
      price: PRICE,
      segments: [segment()],
      deadlineMs: 1000,
    });

    // 600 input at 2400 paise/M plus 120 output at 14,400 paise/M, rounded up.
    expect(result.spentPaise).toBe(4);
    const settled = ledger.records.filter((record) => record.action === "reason");
    expect(settled.length).toBeGreaterThan(0);
  });

  it("stops when the budget is gone, and says so rather than failing", async () => {
    // A partial library is a working one: a segment nobody wrote falls back to the hand-written
    // template. So budget exhaustion ends the run, it does not break it.
    const segments = [segment(), segment({ language: "hi" }), segment({ language: "ta" })];
    const result = await generate({
      ...kernel({ budgetPaise: paise(5, "budget"), maxActionCostPaise: paise(5, "ceiling") }),
      composer: composer(good),
      price: PRICE,
      segments,
      deadlineMs: 1000,
    });

    expect(result.stoppedBecause).toContain("budget");
    expect(result.unattempted.length).toBeGreaterThan(0);
    expect(result.variants.length).toBeLessThan(segments.length);
  });

  it("stops on the day's quota without trying every remaining segment", async () => {
    // A `throttled` failure has already been through the transport's retries and the pacer's
    // waiting. Carrying on would spend the rest of the list discovering the same thing.
    const throttled = Object.assign(new Error("the day's quota is spent"), { kind: "throttled" });
    const asking = composer((request, at) => (at === 0 ? good(request) : throttled));

    const result = await generate({
      ...kernel(),
      composer: asking,
      price: PRICE,
      segments: [segment(), segment({ language: "hi" }), segment({ language: "ta" })],
      deadlineMs: 1000,
    });

    expect(result.stoppedBecause).toContain("quota");
    expect(asking.asked()).toBe(2);
    expect(result.unattempted).toHaveLength(1);
  });

  it("carries on past a failure that says nothing about the next segment", async () => {
    const asking = composer((request, at) =>
      at === 1 ? new Error("the answer was not JSON") : good(request),
    );
    const result = await generate({
      ...kernel(),
      composer: asking,
      price: PRICE,
      segments: [segment(), segment({ language: "hi" }), segment({ language: "ta" })],
      deadlineMs: 1000,
    });

    expect(result.stoppedBecause).toBeNull();
    expect(asking.asked()).toBe(3);
    expect(result.variants).toHaveLength(2);
  });

  it("hands a grant back when the call fails, rather than leaving it to expire", async () => {
    // A reservation left to lapse holds budget for its whole TTL while the run carries on spending
    // what is left. With `maxInFlight: 1` a stranded grant would also refuse every later segment.
    const asking = composer((request, at) =>
      at === 0 ? new Error("socket closed") : good(request),
    );
    const result = await generate({
      ...kernel({ maxInFlight: 1 }),
      composer: asking,
      price: PRICE,
      segments: [segment(), segment({ language: "hi" })],
      deadlineMs: 1000,
    });

    expect(result.variants).toHaveLength(1);
    expect(result.stoppedBecause).toBeNull();
  });

  it("cannot send a message even if something asked it to", async () => {
    // The mandate this run spends under allows `reason` and nothing else, so the generator could
    // not contact a customer if its code tried. That is the lever the whole design claims exists.
    const { terminus } = kernel();
    const admission = await terminus.admit({
      action: {
        kind: "contact-sms",
        customer: "cust_test" as never,
        casualty: null,
        incident: null,
        estimatedCost: paise(28),
        expectedValue: paise(10_000),
        successProbability: 0.5,
        rationale: "should never be allowed",
      },
      status: {
        recovered: false,
        optedOut: false,
        disputed: false,
        consecutiveHardDeclines: 0,
        recoverability: "transient",
      },
      attemptNo: 1,
    });
    expect(admission.allowed).toBe(false);
  });
});

describe("the policy the library is written under", () => {
  it("buys a second segment for a script that cannot fit a message in one", () => {
    // Twenty-five characters is two words. Not a demanding target — an impossible one.
    expect(segmentsFor(segment({ language: "en" }))).toBe(1);
    for (const language of ["hi", "mr", "ta"] as const) {
      expect(segmentsFor(segment({ language }))).toBe(2);
      expect(bodyBudget(segment({ language }), 1).characters).toBeLessThan(40);
      expect(bodyBudget(segment({ language }), 2).characters).toBeGreaterThan(80);
    }
  });

  it("derives the reservation ceiling instead of asserting it, and gets three everywhere", () => {
    // The worst case is the customer, not the copy: a twelve-character Devanagari first name, a
    // lakh-scale amount and a full-length link cost the same whatever language the sentence is in.
    // Deriving it means a change to a greeting or a budget moves this number and fails here, rather
    // than quietly widening what the kernel is asked to reserve.
    for (const language of ["en", "hi", "mr", "ta"] as const) {
      for (const channel of ["contact-sms", "contact-whatsapp"] as const) {
        expect(worstCaseSegmentsFor(segment({ language, channel }))).toBe(MAX_WORST_CASE_SEGMENTS);
      }
    }
  });

  it("forbids inventing a cause where the message must not name one", async () => {
    // Found by reading the first complete library: six variants in 465 said the payment failed for
    // technical reasons. Not a balance, which the prompt guards heavily and which nothing mentioned
    // — a comforting fiction about a fault at the bank's end, which is still a false statement
    // about somebody's money sent under the merchant's sender id.
    const invented = "{amount} could not be completed due to a technical error. Retry: {link}";
    const timed = await generate({
      ...kernel(),
      composer: composer(() => [{ body: invented, subject: null }]),
      price: PRICE,
      segments: [segment({ recoverability: "timed" })],
      deadlineMs: 1000,
    });
    // Two, not one: "technical" and "error" are both on the list, and the sentence has both.
    expect(timed.rejections.get("prohibited-phrase")).toBeGreaterThan(0);
    expect(timed.variants).toHaveLength(0);

    // And permits it where naming the cause is the entire point. Twenty-one of thirty-two
    // `transient` variants name the bank's problem, and they should.
    const transient = await generate({
      ...kernel(),
      composer: composer(() => [
        {
          body: "the {institution} technical problem is fixed. Pay your {amount}: {link}",
          subject: null,
        },
      ]),
      price: PRICE,
      segments: [segment({ recoverability: "transient" })],
      deadlineMs: 1000,
    });
    expect(transient.variants).toHaveLength(1);
  });

  it("covers every situation the product claims to serve, and no more", () => {
    const required = requiredSegments(COVERAGE);
    expect(required).toHaveLength(180);
    expect(required.some((s) => s.recoverability === "dead")).toBe(false);
  });
});
