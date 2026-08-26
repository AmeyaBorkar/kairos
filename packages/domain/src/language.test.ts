import { describe, expect, it } from "vitest";
import { isInScript, isLanguage, LANGUAGE_SPECS, tallyScripts } from "./language.js";

describe("language", () => {
  it("gives an Indic language less than half the room English gets", () => {
    // Not a localisation detail. One character outside GSM-7 moves the whole message to UCS-2, and
    // there is no partial encoding — so the Hindi version of a sentence costs two or three times
    // what the English one costs, every time it is sent.
    expect(LANGUAGE_SPECS.en.gsm7).toBe(true);
    expect(LANGUAGE_SPECS.hi.gsm7).toBe(false);
    expect(LANGUAGE_SPECS.mr.gsm7).toBe(false);
    expect(LANGUAGE_SPECS.ta.gsm7).toBe(false);
  });

  it("ignores placeholders when deciding what script text is in", () => {
    // `{amount}` and `{link}` are Latin and appear in every message in every language. Counting
    // them would make a short Hindi message look like an English one.
    const hindi = "आपका {amount} भुगतान पूरा नहीं हुआ। यहाँ पूरा करें: {link}";
    expect(tallyScripts(hindi).latin).toBe(0);
    expect(isInScript(hindi, "hi")).toBe(true);
  });

  it("accepts the loan words real Indian copy actually contains", () => {
    // "UPI", "OTP" and a bank's name stay in Latin inside an otherwise Hindi sentence, because that
    // is how people write. Demanding a pure script would reject what a native writer produces.
    expect(isInScript("अपने UPI ऐप में जाकर PIN डालें और भुगतान पूरा करें", "hi")).toBe(true);
  });

  it("catches a model that answered in the wrong language", () => {
    expect(isInScript("Your payment did not go through, please try again", "hi")).toBe(false);
    expect(isInScript("आपका भुगतान पूरा नहीं हुआ", "ta")).toBe(false);
  });

  it("calls empty text no language at all rather than passing it by vacuous truth", () => {
    expect(isInScript("", "en")).toBe(false);
    expect(isInScript("{amount} {link}", "en")).toBe(false);
  });

  it("knows which codes it can serve", () => {
    expect(isLanguage("hi")).toBe(true);
    expect(isLanguage("fr")).toBe(false);
  });
});
