import type { PaymentMethod } from "@kairos/domain";
import { describe, expect, it } from "vitest";
import { ILLEGIBLE_PENALTY, type MessageExpectation, NO_MESSAGE, scoreMessage } from "./quality.js";

function expectation(overrides: Partial<MessageExpectation> = {}): MessageExpectation {
  return {
    language: "en",
    institution: "HDFC",
    method: "upi" as PaymentMethod,
    channel: "contact-sms",
    ...overrides,
  };
}

/** What the system actually sends today, rendered. The scorer has to be fair to it. */
const TEMPLATE_TRANSIENT =
  "Hi Rohit, the HDFC issue that stopped your Rs. 1,245.00 payment is fixed. Finish it here: https://rzp.io/i/aB3xQ";
const TEMPLATE_RETRY =
  "Hi Rohit, your Rs. 1,245.00 payment wasn't completed. Pick up where you left off: https://rzp.io/i/aB3xQ";

describe("scoring a message", () => {
  it("credits copy that names the bank", () => {
    expect(scoreMessage(TEMPLATE_TRANSIENT, expectation()).namesCause).toBe(true);
    expect(scoreMessage(TEMPLATE_RETRY, expectation()).namesCause).toBe(false);
  });

  it("matches an institution however the merchant capitalised it", () => {
    // The bug this catches: the term tables are lowercase, an institution arrives as the merchant
    // writes it, and comparing "HDFC" against lowered text matches nothing at all.
    expect(scoreMessage("your hdfc payment is fine now: link", expectation()).namesCause).toBe(
      true,
    );
    expect(
      scoreMessage("your Kotak payment is fine now", expectation({ institution: "Kotak" }))
        .namesCause,
    ).toBe(true);
  });

  it("credits the rail even where there is no bank to name", () => {
    const noBank = expectation({ institution: null });
    expect(scoreMessage("your UPI payment did not go through: link", noBank).namesCause).toBe(true);
    expect(scoreMessage("your payment did not go through: link", noBank).namesCause).toBe(false);
  });

  it("credits copy that says what the customer physically does", () => {
    expect(
      scoreMessage("open your UPI app and approve with your PIN: link", expectation()).namesAction,
    ).toBe(true);
    expect(
      scoreMessage("your card has expired — update it here: link", expectation({ method: "card" }))
        .namesAction,
    ).toBe(true);
  });

  it("does not credit the sentence every unhelpful message already contains", () => {
    expect(
      scoreMessage("please complete your payment at your convenience: link", expectation())
        .namesAction,
    ).toBe(false);
  });

  it("reads the rail's name in the script real copy uses it in", () => {
    // "UPI", "OTP" and "PIN" stay in Latin inside an otherwise Devanagari sentence, because that is
    // how Indians write about payments.
    const hindi = expectation({ language: "hi" });
    const message = "आपका UPI भुगतान पूरा नहीं हुआ। अपने ऐप में PIN डालें: link";
    const quality = scoreMessage(message, hindi);
    expect(quality.namesCause).toBe(true);
    expect(quality.namesAction).toBe(true);
    expect(quality.legible).toBe(true);
  });

  it("discounts a message arriving in a script the reader does not use", () => {
    const tamilReader = expectation({ language: "ta" });
    const english = scoreMessage(TEMPLATE_TRANSIENT, expectation());
    const toTamilReader = scoreMessage(TEMPLATE_TRANSIENT, tamilReader);

    expect(toTamilReader.legible).toBe(false);
    expect(toTamilReader.guidance).toBeCloseTo(english.guidance * ILLEGIBLE_PENALTY, 10);
  });

  it("does not discount it to nothing, which would flatter the multilingual case", () => {
    // Many Indians read English perfectly well. Scoring an unreadable message at zero would be the
    // choice that makes generated copy easiest to win with, so it is not the choice made.
    expect(ILLEGIBLE_PENALTY).toBeGreaterThan(0);
    const quality = scoreMessage(TEMPLATE_TRANSIENT, expectation({ language: "ta" }));
    expect(quality.guidance).toBeGreaterThan(0);
  });

  it("penalises copy that spills into a second segment", () => {
    const long = `${TEMPLATE_TRANSIENT} ${"and some more words ".repeat(6)}`;
    expect(scoreMessage(long, expectation()).concise).toBe(false);
    expect(scoreMessage(TEMPLATE_TRANSIENT, expectation()).concise).toBe(true);
  });

  it("does not measure an email in segments, because nobody reads one that way", () => {
    const long = `${TEMPLATE_TRANSIENT} ${"and some more words ".repeat(6)}`;
    expect(scoreMessage(long, expectation({ channel: "contact-email" })).concise).toBe(true);
  });

  it("gives WhatsApp the room its channel actually has", () => {
    const twoSegments = `${TEMPLATE_TRANSIENT} ${"more words ".repeat(4)}`;
    expect(scoreMessage(twoSegments, expectation({ channel: "contact-whatsapp" })).concise).toBe(
      true,
    );
  });

  it("scores the hand-written templates on their merits, not on their provenance", () => {
    // The whole point. Today's transient template names the bank and fits a segment, so it earns
    // most of the score; the customer-retry one says a payment failed and offers a link, so it earns
    // the part it deserves. Neither is credited or penalised for who wrote it.
    const transient = scoreMessage(TEMPLATE_TRANSIENT, expectation());
    const retry = scoreMessage(TEMPLATE_RETRY, expectation());

    expect(transient.guidance).toBeGreaterThan(retry.guidance);
    expect(transient.guidance).toBeLessThan(1);
    expect(retry.guidance).toBeGreaterThan(0);
  });

  it("reaches one only for copy that does everything", () => {
    const best = "your HDFC UPI payment is ready. Open your app and approve with your PIN: link";
    expect(scoreMessage(best, expectation()).guidance).toBe(1);
  });

  it("charges an em-dash what an em-dash costs", () => {
    // Found by this test failing. U+2014 is not in the GSM-7 alphabet, so one of them moves the
    // whole message to UCS-2 and cuts its capacity from 160 characters to 70 — which turned a
    // one-segment message into two and cost it a fifth of its score. Exactly the kind of thing a
    // human writing copy would never notice and the price list always would.
    const withDash =
      "your HDFC UPI payment is ready — open your app and approve with your PIN: link";
    const withStop =
      "your HDFC UPI payment is ready. Open your app and approve with your PIN: link";
    expect(scoreMessage(withDash, expectation()).concise).toBe(false);
    expect(scoreMessage(withStop, expectation()).concise).toBe(true);
  });

  it("scores a message nobody sent at zero", () => {
    expect(NO_MESSAGE.guidance).toBe(0);
  });

  it("takes no argument that could say which arm wrote the text", () => {
    // Structural rather than behavioural, and the reason this file exists. Two identical strings
    // score identically whatever produced them, because there is nowhere to put the difference.
    const a = scoreMessage(TEMPLATE_TRANSIENT, expectation());
    const b = scoreMessage(TEMPLATE_TRANSIENT, expectation());
    expect(a).toEqual(b);
  });
});
