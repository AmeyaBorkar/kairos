import { type CopyVariables, paise } from "@kairos/domain";
import { describe, expect, it } from "vitest";
import { Copy, type CopyLibrary } from "./library.js";
import { type CopySegment, segmentFor, segmentKey } from "./segment.js";
import { type CopyRequest, type CopySource, libraryCopy } from "./source.js";
import { makeVariant } from "./variant.js";

const VARIABLES: CopyVariables = {
  firstName: "Rohit",
  amount: paise(1_245_00),
  link: "https://rzp.io/i/aB3xQ",
  institution: "HDFC",
};

const REQUEST: CopyRequest = {
  recoverability: "transient",
  method: "upi",
  language: "hi",
  channel: "contact-sms",
  variables: VARIABLES,
  pick: "grant_1",
};

/** A source that records what it was asked, so a fallback can be observed rather than inferred. */
function spy(): CopySource & { calls: CopyRequest[] } {
  const calls: CopyRequest[] = [];
  return {
    name: "spy",
    calls,
    select(request) {
      calls.push(request);
      return {
        text: "template text",
        subject: null,
        cost: { encoding: "gsm-7", units: 13, segments: 1 },
        variantId: null,
      };
    },
  };
}

function libraryOf(segments: readonly [CopySegment, string][]): Copy {
  const library: CopyLibrary = {
    provenance: {
      model: "test-model",
      generatedAt: "2026-08-26",
      promptHash: "0000000000000000",
      spentPaise: 1,
      calls: 1,
    },
    variants: segments.map(([segment, body]) =>
      makeVariant(segment, segmentKey(segment), body, null),
    ),
  };
  return new Copy(library);
}

describe("choosing a segment for a real situation", () => {
  it("names the rail only where the copy is written to name one", () => {
    // The rule that used to live inside `requiredSegments` and nowhere near the code that reads a
    // library. A caller applying it differently would have looked up `timed/upi/...`, found
    // nothing, and fallen back to a template for copy that was written and sitting in the file.
    const guided = segmentFor({
      recoverability: "customer-action",
      method: "card",
      language: "en",
      channel: "contact-sms",
    });
    expect(guided.method).toBe("card");

    const unguided = segmentFor({
      recoverability: "timed",
      method: "card",
      language: "en",
      channel: "contact-sms",
    });
    expect(unguided.method).toBeNull();
  });

  it("agrees with the key the library is indexed by", () => {
    const situation = {
      recoverability: "timed",
      method: "upi",
      language: "ta",
      channel: "contact-email",
    } as const;
    expect(segmentKey(segmentFor(situation))).toBe("timed/any/ta/contact-email");
  });
});

describe("serving copy from a library", () => {
  it("renders a variant with the customer's own values substituted", () => {
    const segment = segmentFor(REQUEST);
    const copy = libraryOf([[segment, "{institution} ठीक है। {amount} भेजें: {link}"]]);
    const selected = libraryCopy(copy, spy()).select(REQUEST);

    expect(selected.variantId).not.toBeNull();
    expect(selected.text).toContain("HDFC");
    expect(selected.text).toContain("https://rzp.io/i/aB3xQ");
    // The hole itself must be gone. A message that reaches a customer saying "{amount}" is worse
    // than one that was never sent.
    expect(selected.text).not.toContain("{");
  });

  it("falls back to the template where nothing was written", () => {
    // Partial coverage is the normal state of a library generated against a daily quota, so a miss
    // is an ordinary condition rather than an error — see ADR 0006.
    const fallback = spy();
    const selected = libraryCopy(libraryOf([]), fallback).select(REQUEST);

    expect(selected.text).toBe("template text");
    expect(selected.variantId).toBeNull();
    expect(fallback.calls).toHaveLength(1);
  });

  it("hands the fallback the language it could not serve, rather than quietly rewriting it", () => {
    // The fallback is English whatever it is asked for, and that is the honest behaviour: a Tamil
    // customer whose segment is missing gets Latin script and is scored as unable to read it.
    // Substituting a different language's copy would hide a coverage gap inside the metric that
    // exists to reveal it.
    const fallback = spy();
    libraryCopy(libraryOf([]), fallback).select({ ...REQUEST, language: "ta" });
    expect(fallback.calls[0]?.language).toBe("ta");
  });

  it("picks the same variant every time for the same message", () => {
    // A replayed attempt must compose the same words. The idempotency key protects the send; it
    // does nothing about the text, so a source that picked randomly would let a retry occupy more
    // segments than the reservation was sized for.
    const segment = segmentFor(REQUEST);
    const copy = libraryOf([
      [segment, "पहला {amount} {link}"],
      [segment, "दूसरा {amount} {link}"],
      [segment, "तीसरा {amount} {link}"],
    ]);
    const source = libraryCopy(copy, spy());

    const first = source.select(REQUEST);
    for (let attempt = 0; attempt < 20; attempt++) {
      expect(source.select(REQUEST).variantId).toBe(first.variantId);
    }
  });

  it("spreads different messages across the variants it was given", () => {
    // Not a bandit — nothing here learns from an outcome. It is uniform exploration, and the test
    // says so by asserting only that more than one arm is ever reached.
    const segment = segmentFor(REQUEST);
    const copy = libraryOf([
      [segment, "पहला {amount} {link}"],
      [segment, "दूसरा {amount} {link}"],
      [segment, "तीसरा {amount} {link}"],
    ]);
    const source = libraryCopy(copy, spy());

    const seen = new Set<string | null>();
    for (let at = 0; at < 60; at++) {
      seen.add(source.select({ ...REQUEST, pick: `grant_${at}` }).variantId);
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it("names both the library's model and what it falls back to", () => {
    // So a scorecard row says which copy an arm actually ran, including the half of it that is a
    // template. An arm reported as "generated" whose library missed every segment is a claim about
    // configuration rather than about what customers received.
    const source = libraryCopy(libraryOf([]), spy());
    expect(source.name).toContain("test-model");
    expect(source.name).toContain("spy");
  });
});
