import { describe, expect, it } from "vitest";
import { encodingFor, SEGMENT_LIMITS, smsCost, smsCostPaise } from "./segments.js";

describe("segment counting", () => {
  it("keeps a plain Latin message at seven bits", () => {
    expect(encodingFor("Your payment did not go through. Try again.")).toBe("gsm-7");
  });

  it("moves the whole message to sixteen bits for one stray character", () => {
    // There is no partial encoding. A single rupee sign, smart quote or emoji costs the message
    // ninety characters of capacity.
    expect(encodingFor("Payment of Rs. 100 failed")).toBe("gsm-7");
    expect(encodingFor("Payment of ₹100 failed")).toBe("ucs-2");
    expect(encodingFor("Payment failed — try again")).toBe("ucs-2");
  });

  it("charges twice for the characters that need an escape", () => {
    // `[`, `]`, `{`, `}`, `~`, `^`, `|`, `\` and the euro sign are reachable only through an escape
    // sequence, so each occupies two of the 160.
    expect(smsCost("a".repeat(160)).segments).toBe(1);
    expect(smsCost(`${"a".repeat(159)}[`).segments).toBe(2);
  });

  it("counts a concatenated message the way a carrier does", () => {
    // Seven bytes of every part go to the header, so the second segment does not add 160 more
    // characters, it adds 153 — and the first drops to 153 too.
    expect(smsCost("a".repeat(SEGMENT_LIMITS.gsmSingle)).segments).toBe(1);
    expect(smsCost("a".repeat(SEGMENT_LIMITS.gsmSingle + 1)).segments).toBe(2);
    expect(smsCost("a".repeat(SEGMENT_LIMITS.gsmMulti * 2)).segments).toBe(2);
    expect(smsCost("a".repeat(SEGMENT_LIMITS.gsmMulti * 2 + 1)).segments).toBe(3);
  });

  it("counts UCS-2 by code unit, not by character", () => {
    // An emoji outside the basic plane is two code units and a carrier bills it as two. Counting
    // characters instead has put real messages over a segment boundary.
    expect(smsCost("😀".repeat(35)).units).toBe(70);
    expect(smsCost("😀".repeat(35)).segments).toBe(1);
    expect(smsCost("😀".repeat(36)).segments).toBe(2);
  });

  it("charges nothing for nothing", () => {
    expect(smsCost("").segments).toBe(0);
    expect(smsCostPaise("", 20)).toBe(0);
  });
});
