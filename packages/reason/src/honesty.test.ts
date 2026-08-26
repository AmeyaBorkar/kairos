import { describe, expect, it } from "vitest";
import { verifyExplanation } from "./honesty.js";

const SOURCES = [
  "2026-08-24 09:15:00 UTC",
  "recover-worker/3",
  "contact-sms",
  "declined: this customer had already received 3 contacts in 7 days",
  "contact-cap",
  "campaign budget: ₹500.00 total",
];

describe("checking an explanation against its sources", () => {
  it("accepts an answer that only quotes what it was shown", () => {
    const verdict = verifyExplanation(
      "Kairos did not message this customer on 2026-08-24 because they had already received 3 " +
        "contacts in 7 days, which is the cap.",
      SOURCES,
    );
    expect(verdict.ok).toBe(true);
    expect(verdict.unsupported).toEqual([]);
  });

  it("rejects the fluent sentence with a number nobody recorded", () => {
    // The failure this exists for. Not gibberish — a confident, plausible claim about a real
    // person's account, containing a figure that appears in no record.
    const verdict = verifyExplanation(
      "Kairos held off because the customer had already received 4 contacts that week.",
      SOURCES,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.unsupported).toContain("4");
  });

  it("does not mistake a sentence-ending full stop for part of a figure", () => {
    // The first version of this regex captured "2026-08-24." including the stop and reported a
    // truthful explanation as a fabrication. A check on honesty being less careful than its subject
    // is its own failure mode.
    const verdict = verifyExplanation("The refusal was recorded on 2026-08-24.", SOURCES);
    expect(verdict.ok).toBe(true);
  });

  it("treats a thousands separator as formatting rather than invention", () => {
    expect(verifyExplanation("The budget is ₹500.00.", SOURCES).ok).toBe(true);
    expect(verifyExplanation("The budget is ₹5,00.00.", ["₹500.00"]).ok).toBe(true);
  });

  it("catches arithmetic the model was not allowed to do", () => {
    // The strong form of the rule, and its real cost. "3 of 7" is derivable from the sources and is
    // still refused, because a check that accepted derived figures would have to decide which
    // derivations are sound — and the ones that matter are exactly the ones a confused model gets
    // wrong. The retrieval formats figures the way an answer should quote them so that this
    // constraint is one the model has no reason to hit.
    const verdict = verifyExplanation("That is 43% of their weekly allowance.", SOURCES);
    expect(verdict.ok).toBe(false);
    expect(verdict.unsupported).toContain("43");
  });

  it("reports every figure it saw, so a passing answer is auditable too", () => {
    const verdict = verifyExplanation("3 contacts in 7 days.", SOURCES);
    expect(verdict.cited).toEqual(["3", "7"]);
  });

  it("does not let an identifier launder its digits into the allowed set", () => {
    // The hole this check had until a test that should have failed passed. The subject of every
    // question is an id like `cas_9f21`, and a naive digit scan reads 9 and 21 out of it — so a
    // fabricated "9 contacts" verified clean because the number happened to appear in the id.
    const sources = ["cas_9f21", "recover-worker/3", "sent"];
    expect(verifyExplanation("It was contacted 9 times.", sources).ok).toBe(false);
    expect(verifyExplanation("It was contacted 3 times.", sources).ok).toBe(false);
  });

  it("neither credits nor blames an answer for quoting an id back", () => {
    // The same rule applied to both sides, which is what keeps it symmetric: an answer naming the
    // casualty it is about has not cited a quantity.
    const verdict = verifyExplanation("Kairos declined cas_9f21.", ["cas_9f21", "declined"]);
    expect(verdict.ok).toBe(true);
    expect(verdict.cited).toEqual([]);
  });

  it("still checks an ordinal, which is a claim like any other", () => {
    expect(verifyExplanation("It failed on the 4th attempt.", SOURCES).ok).toBe(false);
    expect(verifyExplanation("It failed on the 3rd attempt.", SOURCES).ok).toBe(true);
  });

  it("passes prose with no figures at all", () => {
    const verdict = verifyExplanation("The contact cap was the binding limit.", SOURCES);
    expect(verdict.ok).toBe(true);
    expect(verdict.cited).toEqual([]);
  });
});
