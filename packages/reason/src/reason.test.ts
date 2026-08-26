import { paise } from "@kairos/domain";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROHIBITED, type GauntletOptions, validate } from "./gauntlet.js";
import {
  Copy,
  isWellFormedSegmentKey,
  parseLibrary,
  serialiseLibrary,
  statsFor,
} from "./library.js";
import { NO_USAGE, priceOf, reservationFor, usdPerMillionToPaise } from "./price.js";
import { composePrompt, explainPrompt, promptHash } from "./prompt.js";
import {
  type ContactChannel,
  type CopySegment,
  parseSegmentKey,
  requiredSegments,
  segmentKey,
} from "./segment.js";
import { bodyBudget, makeVariant, measure, render } from "./variant.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────────────────────

function segment(overrides: Partial<CopySegment> = {}): CopySegment {
  return {
    recoverability: "transient",
    channel: "contact-sms",
    language: "en",
    method: null,
    ...overrides,
  };
}

const OPTIONS: GauntletOptions = {
  maxTypicalSegments: 1,
  maxWorstCaseSegments: 3,
  prohibited: DEFAULT_PROHIBITED,
};

/** Passes every check, so a test can change exactly one thing and see it fail. */
const GOOD =
  "the {institution} issue that stopped your {amount} payment is fixed. Pay here: {link}";

function check(body: string, over: Partial<GauntletOptions> = {}, seg = segment()) {
  return validate(body, null, seg, segmentKey(seg), { ...OPTIONS, ...over });
}

function codes(body: string, over: Partial<GauntletOptions> = {}, seg = segment()): string[] {
  const verdict = check(body, over, seg);
  return verdict.ok ? [] : verdict.rejections.map((r) => r.code);
}

// ── Language and price ────────────────────────────────────────────────────────────────────────

describe("pricing a model call", () => {
  const price = {
    model: "test",
    inputPaisePerMillion: 1000,
    outputPaisePerMillion: 5000,
    cacheReadShare: 0.1,
    derivation: "test",
  };

  it("charges cached input at a fraction of fresh input", () => {
    const fresh = priceOf({ inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 0 }, price);
    const cached = priceOf(
      { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 1_000_000 },
      price,
    );
    expect(fresh).toBe(1000);
    expect(cached).toBe(100);
  });

  it("rounds up, because a bound that leaks is not a bound", () => {
    expect(priceOf({ inputTokens: 1, outputTokens: 0, cachedInputTokens: 0 }, price)).toBe(1);
    expect(priceOf(NO_USAGE, price)).toBe(0);
  });

  it("prices a reservation at the output ceiling, which is the only knowable number", () => {
    // The prompt exists before the call, so input is exact. What the model will write does not, so
    // it is reserved at `maxOutputTokens` and reconciled afterwards.
    expect(reservationFor(1_000_000, 1_000_000, price)).toBe(6000);
  });

  it("does not let a provider's cache report exceed its own input count", () => {
    const odd = priceOf({ inputTokens: 100, outputTokens: 0, cachedInputTokens: 400 }, price);
    expect(odd).toBeGreaterThanOrEqual(0);
  });

  it("converts a published dollar rate at a stated exchange rate", () => {
    expect(usdPerMillionToPaise(5, 88)).toBe(44_000);
  });
});

// ── Segments ──────────────────────────────────────────────────────────────────────────────────

describe("segments", () => {
  it("keys copy by situation and never by customer", () => {
    expect(segmentKey(segment({ language: "hi", method: "upi" }))).toBe(
      "transient/upi/hi/contact-sms",
    );
    expect(segmentKey(segment())).toBe("transient/any/en/contact-sms");
  });

  it("round-trips a key", () => {
    const original = segment({ recoverability: "customer-retry", language: "ta", method: "card" });
    expect(parseSegmentKey(segmentKey(original))).toEqual(original);
  });

  it("refuses a key naming something that does not exist", () => {
    expect(parseSegmentKey("nonsense/any/en/contact-sms")).toBeNull();
    expect(parseSegmentKey("transient/any/en/carrier-pigeon")).toBeNull();
    expect(parseSegmentKey("too/few/parts")).toBeNull();
  });

  it("asks for a method only where the customer's next move depends on it", () => {
    const coverage = {
      languages: ["en", "hi"] as const,
      methods: ["upi", "card"] as const,
      channels: ["contact-sms"] as const,
    };
    const all = requiredSegments(coverage);

    // customer-action and customer-retry are keyed by method; the other three are not, because the
    // next move is the same link whatever the payment was made with.
    const methodful = all.filter((s) => s.method !== null);
    expect(new Set(methodful.map((s) => s.recoverability))).toEqual(
      new Set(["customer-action", "customer-retry"]),
    );
    // 2 classes x 2 methods x 2 languages + 3 classes x 2 languages.
    expect(all.length).toBe(8 + 6);
  });

  it("never asks for copy for a class that is never sent", () => {
    const all = requiredSegments({
      languages: ["en"],
      methods: ["upi"],
      channels: ["contact-sms"],
    });
    expect(all.some((s) => s.recoverability === "dead")).toBe(false);
  });

  it("stays small enough to fit a free tier's daily quota", () => {
    // The whole argument for generating per segment rather than per message. Four languages, six
    // methods, three channels is under two hundred calls; generating per message would be 5,719.
    const all = requiredSegments({
      languages: ["en", "hi", "mr", "ta"],
      methods: ["upi", "card", "netbanking", "wallet", "emi", "paylater"],
      channels: ["contact-sms", "contact-whatsapp", "contact-email"],
    });
    expect(all.length).toBeLessThan(200);
  });
});

// ── Rendering ─────────────────────────────────────────────────────────────────────────────────

describe("render", () => {
  const variables = {
    firstName: "Rohit",
    amount: paise(124_500),
    link: "https://rzp.io/i/aB3xQ",
    institution: "HDFC",
  };

  function variantFor(seg: CopySegment, body = GOOD) {
    return makeVariant(seg, segmentKey(seg), body, null);
  }

  it("writes the greeting so the model never has to", () => {
    const text = render(variantFor(segment()), segment(), variables).text;
    expect(text.startsWith("Hi Rohit, ")).toBe(true);
  });

  it("does not say Hi undefined", () => {
    const text = render(variantFor(segment()), segment(), { ...variables, firstName: null }).text;
    expect(text.startsWith("Hi, ")).toBe(true);
    expect(text).not.toContain("null");
  });

  it("greets in the language the message is written in", () => {
    const ta = segment({ language: "ta" });
    expect(render(variantFor(ta), ta, variables).text.startsWith("வணக்கம் Rohit,")).toBe(true);
  });

  it("writes Rs. in an English SMS, where the rupee sign would triple the price", () => {
    const text = render(variantFor(segment()), segment(), variables).text;
    expect(text).toContain("Rs. 1,245.00");
    expect(text).not.toContain("₹");
  });

  it("writes the rupee sign where it is free", () => {
    // A Hindi SMS is UCS-2 whatever it contains, and WhatsApp has no seven-bit alphabet to fall out
    // of. In both cases `Rs.` would be a needless anglicism that saves nothing.
    for (const seg of [segment({ language: "hi" }), segment({ channel: "contact-whatsapp" })]) {
      expect(render(variantFor(seg), seg, variables).text).toContain("₹");
    }
  });

  it("falls back to a translated word when there is no institution to name", () => {
    const hi = segment({ language: "hi" });
    const body = "{institution} की समस्या ठीक हो गई है। {amount} का भुगतान यहाँ करें: {link}";
    const text = render(variantFor(hi, body), hi, { ...variables, institution: null }).text;
    expect(text).toContain("बैंक");
    expect(text).not.toContain("{institution}");
  });

  it("leaves no hole unfilled", () => {
    for (const language of ["en", "hi", "mr", "ta"] as const) {
      const seg = segment({ language });
      const text = render(variantFor(seg), seg, variables).text;
      expect(text).not.toMatch(/\{[a-z]+\}/);
    }
  });
});

describe("measure", () => {
  it("prices the worst case above the typical one, because of the customer's own name", () => {
    // A message composed with a Devanagari name is UCS-2 however Latin the copy is. Copy is written
    // to the typical budget and priced at the worst case: that is what reserve-then-reconcile is
    // for, and writing to the worst case would throw away English's advantage on most customers.
    const priced = measure(GOOD, null, segment());
    expect(priced.typicalSegments).toBe(1);
    expect(priced.worstCaseSegments).toBeGreaterThan(priced.typicalSegments);
  });

  it("gives a variant an id that changes when the words do", () => {
    const seg = segment();
    const a = makeVariant(seg, segmentKey(seg), GOOD, null);
    const b = makeVariant(seg, segmentKey(seg), GOOD, null);
    const c = makeVariant(seg, segmentKey(seg), `${GOOD} `, null);
    expect(a.id).toBe(b.id);
    expect(a.id).not.toBe(makeVariant(seg, segmentKey(seg), `${GOOD}!`, null).id);
    // Trailing whitespace is not a different sentence — but the gauntlet trims before it gets here.
    expect(c.body).toBe(`${GOOD} `);
  });
});

// ── The gauntlet ──────────────────────────────────────────────────────────────────────────────

describe("the gauntlet", () => {
  it("accepts copy that follows every rule", () => {
    const verdict = check(GOOD);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.variant.typicalSegments).toBe(1);
  });

  it("rejects a rupee figure the model wrote itself", () => {
    // The dangerous hallucination: a false statement about somebody's money, sent under the
    // merchant's own sender id.
    expect(codes("your payment of Rs. 500 failed. Pay {amount} here: {link}")).toContain(
      "invented-amount",
    );
    expect(
      codes("भुगतान ₹500 का था। {amount} यहाँ करें: {link}", {}, segment({ language: "hi" })),
    ).toContain("invented-amount");
  });

  it("lets ordinary copy keep its numbers", () => {
    // "within 24 hours" is a deadline, not a claim about money. Banning digits outright would leave
    // the model unable to write one.
    expect(codes("your {amount} payment is still open for 24 hours. Finish it: {link}")).toEqual(
      [],
    );
  });

  it("rejects a link the model invented", () => {
    expect(codes("your {amount} payment failed. Go to rzp.io/x now or {link}")).toContain(
      "unexpected-url",
    );
    expect(codes("pay your {amount} at https://evil.example — {link}")).toContain("unexpected-url");
  });

  it("rejects a long number, which is a phone or a card or a reference", () => {
    expect(codes("call 18001234567 about your {amount} payment: {link}")).toContain("long-number");
  });

  it("rejects a placeholder render would send literally", () => {
    expect(codes("your {amount} payment for {orderId} failed: {link}")).toContain(
      "unknown-placeholder",
    );
  });

  it("insists on something to tap and a sum to name", () => {
    expect(codes("your payment did not go through, please try again soon")).toEqual(
      expect.arrayContaining(["missing-placeholder"]),
    );
    expect(codes("your payment failed. Try again here: {link}")).toContain("missing-placeholder");
  });

  it("rejects copy written in the wrong language", () => {
    expect(codes(GOOD, {}, segment({ language: "hi" }))).toContain("wrong-script");
  });

  it("rejects manufactured urgency and promises nobody authorised", () => {
    expect(codes("your {amount} payment failed. Last chance to pay: {link}")).toContain(
      "prohibited-phrase",
    );
    expect(codes("pay your {amount} now and we guarantee delivery: {link}")).toContain(
      "prohibited-phrase",
    );
  });

  it("permits telling a customer their bank will send an OTP", () => {
    // The sentence that earns the guided-copy uplift on a card retry. Banning the word outright to
    // prevent a phishing message nobody writes would forbid the most useful thing we can say.
    expect(
      codes("your bank will send an OTP to finish the {amount} payment. Start here: {link}"),
    ).toEqual([]);
  });

  it("still rejects a message that asks for one", () => {
    expect(codes("to finish your {amount} payment, share your OTP with us: {link}")).toContain(
      "prohibited-phrase",
    );
  });

  it("rejects copy that will not fit its segment", () => {
    const long = `your {amount} payment ${"and more words ".repeat(20)} here: {link}`;
    expect(codes(long)).toContain("too-long");
  });

  it("rejects copy the mandate would never reserve enough for", () => {
    const verdict = codes(GOOD, { maxWorstCaseSegments: 1 });
    expect(verdict).toContain("exceeds-reservation");
  });

  it("wants a subject on an email and refuses one anywhere else", () => {
    const email = segment({ channel: "contact-email" });
    const noSubject = validate(GOOD, null, email, segmentKey(email), OPTIONS);
    expect(noSubject.ok).toBe(false);

    const sms = segment();
    const withSubject = validate(GOOD, "Your payment", sms, segmentKey(sms), OPTIONS);
    expect(withSubject.ok).toBe(false);
  });

  it("does not price an email in segments, because it is not billed in them", () => {
    const email = segment({ channel: "contact-email" });
    const long = `your {amount} payment ${"and more words ".repeat(20)} here: {link}`;
    const verdict = validate(long, "Finish your payment", email, segmentKey(email), OPTIONS);
    expect(verdict.ok).toBe(true);
  });

  it("stops at the first check when there is no text to read", () => {
    const verdict = check("too short");
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.rejections).toHaveLength(1);
      expect(verdict.rejections[0]?.code).toBe("empty");
    }
  });

  it("reports every rejection rather than the first, so one pass fixes the copy", () => {
    const bad = "pay Rs. 900 at rzp.io/x, last chance {link}";
    const found = codes(bad);
    expect(new Set(found).size).toBeGreaterThan(2);
  });

  it("quotes the offending fragment, so a report can say what went wrong", () => {
    const verdict = check("your payment of Rs. 500 failed. Pay {amount} here: {link}");
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.rejections.find((r) => r.code === "invented-amount")?.detail).toContain("500");
    }
  });
});

// ── The library ───────────────────────────────────────────────────────────────────────────────

describe("the copy library", () => {
  const seg = segment();
  const variant = makeVariant(seg, segmentKey(seg), GOOD, null);
  const library = {
    provenance: {
      model: "test-model",
      generatedAt: "2026-08-26",
      promptHash: "0123456789abcdef",
      spentPaise: 230,
      calls: 180,
    },
    variants: [variant],
  };

  it("round-trips what it serialises", () => {
    expect(parseLibrary(JSON.parse(serialiseLibrary(library)))).toEqual(library);
  });

  it("rejects two variants sharing an id, which would confuse the bandit's arms", () => {
    const clashing = { ...library, variants: [variant, { ...variant, body: "different" }] };
    expect(() => parseLibrary(clashing)).toThrow(/duplicate variant id/);
  });

  it("rejects a malformed provenance rather than degrading into trusting it", () => {
    expect(() =>
      parseLibrary({ ...library, provenance: { ...library.provenance, promptHash: "nope" } }),
    ).toThrow(/hex/);
  });

  it("returns nothing for a segment nobody wrote, rather than throwing", () => {
    // A gap is an ordinary condition: the caller falls back to a hand-written template. There is no
    // path where an inference endpoint being down stops the recovery arm.
    const copy = new Copy(library);
    expect(copy.variantsFor(segment({ language: "ta" }))).toEqual([]);
    expect(copy.variantsFor(seg)).toHaveLength(1);
  });

  it("says which segments are missing rather than discovering it at send time", () => {
    const copy = new Copy(library);
    const required = requiredSegments({
      languages: ["en", "hi"],
      methods: ["upi"],
      channels: ["contact-sms"],
    });
    const stats = statsFor(copy, required);
    expect(stats.segments).toBe(1);
    expect(stats.missing).toBe(required.length - 1);
    expect(stats.coverage).toBeCloseTo(1 / required.length, 10);
    expect(copy.missing(required)).toHaveLength(required.length - 1);
  });

  it("guards a hand-edited key against naming something that does not exist", () => {
    expect(isWellFormedSegmentKey("transient/any/en/contact-sms")).toBe(true);
    expect(isWellFormedSegmentKey("dead/any/en/contact-sms")).toBe(false);
    expect(isWellFormedSegmentKey("transient/any/fr/contact-sms")).toBe(false);
  });
});

// ── Prompts ───────────────────────────────────────────────────────────────────────────────────

describe("prompts", () => {
  const hindiSms = segment({ recoverability: "customer-retry", method: "upi", language: "hi" });
  const request = { segment: hindiSms, variants: 3, budget: bodyBudget(hindiSms, 2) };

  it("never carries a customer", () => {
    // The property the whole design rests on. A field that is never assembled cannot be
    // exfiltrated by a prompt that asks for it, and it is also why a provider's free tier — which
    // reserves the right to train on what it is sent — is acceptable here.
    const { system, user } = composePrompt(request);
    const whole = `${system}\n${user}`;
    for (const forbidden of ["Rohit", "@", "+91", "9876", "rzp.io"]) {
      expect(whole).not.toContain(forbidden);
    }
  });

  it("tells the model what is left for its own text, not the segment's capacity", () => {
    // The two numbers are not the same and the difference is most of the message. Stating the
    // capacity is the version of this prompt that produced an 11% acceptance rate.
    const budget = bodyBudget(hindiSms, 2);
    const hindi = composePrompt(request).user;
    expect(hindi).toContain(`at most ${budget.characters} characters`);
    expect(hindi).not.toContain(`at most ${budget.capacity} characters`);
    expect(hindi).toContain("sixteen bits");
  });

  it("takes the mandatory placeholders' surcharge out itself, rather than asking for arithmetic", () => {
    // `{link}` is six characters written and twenty-two sent. A model cannot know that, so the
    // budget it is given has already paid for the difference and says so.
    const budget = bodyBudget(hindiSms, 2);
    expect(budget.placeholders.link).toBeGreaterThan(0);
    expect(budget.characters).toBe(
      budget.capacity - budget.greeting - budget.placeholders.amount - budget.placeholders.link,
    );
    expect(composePrompt(request).user).toContain("counting {amount} and {link} exactly as you");
  });

  it("measures the encoding on a message that has the real values in it", () => {
    // A regression test for a defect that rejected every English WhatsApp variant in the first full
    // run. On WhatsApp the rupee sign is free, so the amount renders as ₹1,245.00 — and U+20B9 is
    // not in GSM-7, so the message is UCS-2 at 67 units a segment rather than GSM-7 at 153. Reading
    // the encoding off the greeting alone says 306 units where the truth is 134.
    const whatsapp = segment({ channel: "contact-whatsapp" });
    expect(bodyBudget(whatsapp, 2).capacity).toBe(134);
    // An English SMS writes `Rs.` instead, precisely to stay in GSM-7, and keeps its 160.
    expect(bodyBudget(segment(), 1).capacity).toBe(160);
  });

  it("leaves a one-segment Indic SMS visibly too small to write in", () => {
    // Not a defect in this function — a fact about the medium, and the reason the copy generator
    // buys a second segment for UCS-2 languages. Seventy units, less a fourteen-unit greeting and
    // a seventeen-unit surcharge, is thirty-nine characters of which fourteen are placeholders.
    const oneSegment = bodyBudget(hindiSms, 1);
    expect(oneSegment.characters).toBeLessThan(40);
    expect(bodyBudget(segment(), 1).characters).toBeGreaterThan(100);
  });

  it("does not lecture an English message about sixteen-bit encoding", () => {
    const english = segment();
    const user = composePrompt({
      segment: english,
      variants: 3,
      budget: bodyBudget(english, 1),
    }).user;
    expect(user).not.toContain("sixteen bits");
    expect(user).toContain("doubles the price");
  });

  it("names the customer's actual next move on the rail they used", () => {
    expect(composePrompt(request).user).toContain("UPI PIN");
    expect(
      composePrompt({ ...request, segment: { ...request.segment, method: "card" } }).user,
    ).toContain("OTP");
  });

  it("does not mention a rail where the copy must not name one", () => {
    const user = composePrompt({ ...request, segment: segment({ recoverability: "timed" }) }).user;
    expect(user).not.toContain("UPI PIN");
  });

  it("forbids the model from mentioning a balance on the class where that would sting", () => {
    const user = composePrompt({ ...request, segment: segment({ recoverability: "timed" }) }).user;
    expect(user).toContain("never mention a balance");
  });

  it("asks for a subject only where there is somewhere to put one", () => {
    const email = composePrompt({
      ...request,
      segment: segment({ channel: "contact-email" }),
    }).user;
    expect(email).toContain("subject line");
    expect(composePrompt(request).user).toContain("no subject line");
  });

  it("keeps the constant half first and the varying half small", () => {
    // Worth doing and not worth a claim. A prompt cache keys on an exact byte match from the start,
    // so constant-first is the shape that could be cached — but sixteen consecutive live calls
    // sharing an identical 829-token prefix reported no cached tokens at all. The ordering is kept
    // because it is free and correct; what a library actually costs is settled by there being 180
    // calls rather than 5,719.
    const { system, user } = composePrompt(request);
    expect(user.length).toBeLessThan(system.length);
  });

  it("hashes the instructions and not the request", () => {
    const before = promptHash();
    expect(promptHash()).toBe(before);
    expect(before).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("the explanation prompt", () => {
  const request = {
    question: "Why was this customer not messaged?",
    subject: "cas_01H8XK",
    timeline: [
      {
        at: "2026-08-26T02:14:00Z",
        actor: "recover-worker/3",
        action: "contact-sms",
        allowed: false,
        reason: "already contacted 3 times this week",
        binding: "contact-cap",
      },
    ],
    bounds: ["contact cap: 3 per 7 days"],
  };

  it("puts the binding axis where the answer can cite it", () => {
    const { user } = explainPrompt(request);
    expect(user).toContain("bound by: contact-cap");
    expect(user).toContain("REFUSED");
  });

  it("tells the model that not knowing is a better answer than guessing", () => {
    expect(explainPrompt(request).system).toContain("does not show that");
  });

  it("survives a subject with no records at all", () => {
    const empty = explainPrompt({ ...request, timeline: [] });
    expect(empty.user).toContain("(no records)");
  });
});

// ── Channels ──────────────────────────────────────────────────────────────────────────────────

describe("channels", () => {
  it("are exactly the contact kinds the kernel admits against", () => {
    // Typed off the domain's closed action vocabulary, so a channel added there cannot be forgotten
    // here: the library would report the segment as missing rather than the system discovering at
    // send time that it has nothing to say.
    const channels: readonly ContactChannel[] = [
      "contact-sms",
      "contact-whatsapp",
      "contact-email",
    ];
    expect(channels).toHaveLength(3);
  });
});
