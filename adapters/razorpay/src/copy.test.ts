import { paise } from "@kairos/domain";
import { describe, expect, it } from "vitest";
import { acceptableFirstName, type CopyVariables, compose, rupeesAscii } from "./copy.js";
import { encodingFor, SEGMENT_LIMITS, smsCost, smsCostPaise } from "./segments.js";

const variables = (o: Partial<CopyVariables> = {}): CopyVariables => ({
  firstName: "Rohit",
  amount: paise(124_500),
  link: "https://rzp.io/i/aB3xQ",
  institution: "HDFC",
  ...o,
});

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

describe("the rupee sign is the most expensive character in the system", () => {
  it("multiplies the price of every message it appears in", () => {
    // Not a style preference. `formatINR` renders U+20B9, which is not in the GSM-7 alphabet, so a
    // single one takes a message that fits in 160 characters and gives it 70. Every template here
    // doubles; a template near the 160-character limit triples. Writing `Rs.` instead is a saving
    // on every SMS the system will ever send, and it is completely invisible until somebody counts
    // segments.
    for (const klass of ["transient", "timed", "customer-action", "customer-retry"] as const) {
      const message = compose(klass, variables());
      const withSign = message.text.replace("Rs. ", "₹");

      expect(message.cost.encoding).toBe("gsm-7");
      expect(message.cost.segments).toBe(1);
      expect(smsCost(withSign).encoding).toBe("ucs-2");
      expect(smsCost(withSign).segments).toBeGreaterThanOrEqual(2);
    }
  });

  it("triples a message that was using its full segment", () => {
    const full = `${"a".repeat(155)}Rs. 5`;
    expect(smsCost(full).segments).toBe(1);
    expect(smsCost(full.replace("Rs. ", "₹")).segments).toBe(3);
  });

  it("still groups the digits the way an Indian reader expects", () => {
    expect(rupeesAscii(paise(12_345_678))).toBe("Rs. 1,23,456.78");
  });
});

describe("what a message costs depends on the customer's own name", () => {
  it("costs three times as much for a customer called रोहित", () => {
    // The concrete thing behind the abstraction in Terminus. The merchant does not choose their
    // customers' names, the template is identical, and the price is triple — so the cost of a
    // message genuinely cannot be known before it is composed. That is why the kernel reserves a
    // ceiling and reconciles against the truth rather than trusting an estimate.
    const latin = compose("customer-action", variables({ firstName: "Rohit" }));
    const devanagari = compose("customer-action", variables({ firstName: "रोहित" }));

    expect(latin.cost.encoding).toBe("gsm-7");
    expect(latin.cost.segments).toBe(1);
    expect(devanagari.cost.encoding).toBe("ucs-2");
    expect(devanagari.cost.segments).toBe(3);
    expect(smsCostPaise(devanagari.text, 20)).toBe(3 * smsCostPaise(latin.text, 20));
  });
});

describe("templates", () => {
  it("has one for every class, and none of them is empty", () => {
    for (const klass of [
      "transient",
      "timed",
      "customer-action",
      "customer-retry",
      "dead",
      "unknown",
    ] as const) {
      const message = compose(klass, variables());
      expect(message.text.length).toBeGreaterThan(20);
      expect(message.cost.segments).toBeGreaterThan(0);
    }
  });

  it("names the problem only where it knows what the problem is", () => {
    // The `guided` flag is worth real money: a message naming the specific fix recovers several
    // times what a message reporting a failure does. It is claimed only where it is earned.
    expect(compose("customer-action", variables()).guided).toBe(true);
    expect(compose("transient", variables()).guided).toBe(true);
    expect(compose("customer-retry", variables()).guided).toBe(false);
    expect(compose("unknown", variables()).guided).toBe(false);
  });

  it("names the institution when it has one and stays vague when it does not", () => {
    expect(compose("transient", variables({ institution: "HDFC" })).text).toContain("HDFC");
    expect(compose("transient", variables({ institution: null })).text).toContain("bank");
  });

  it("addresses a customer impersonally rather than saying Hi undefined", () => {
    expect(compose("timed", variables({ firstName: null })).text.startsWith("Hi, ")).toBe(true);
  });

  it("fits every template in one segment for an ordinary Latin name", () => {
    // A template that quietly costs two segments is a template that doubles the cost of the arm.
    for (const klass of ["transient", "timed", "customer-action", "customer-retry"] as const) {
      expect(compose(klass, variables()).cost.segments).toBe(1);
    }
  });
});

describe("first names are untrusted input", () => {
  it("accepts a name in any script", () => {
    expect(acceptableFirstName("Rohit")).toBe("Rohit");
    expect(acceptableFirstName("रोहित")).toBe("रोहित");
    expect(acceptableFirstName("  Priya  ")).toBe("Priya");
    expect(acceptableFirstName("D'Souza")).toBe("D'Souza");
  });

  it("refuses a name that is really a link", () => {
    // A message carrying an attacker's URL, delivered over the merchant's own sender id, is a
    // phishing campaign the merchant paid to send. Reject rather than sanitise: a slightly colder
    // greeting is a far better outcome than a clever escaping bug.
    expect(acceptableFirstName("http://evil.example")).toBeNull();
    expect(acceptableFirstName("Click rzp.io/x now")).toBeNull();
    expect(acceptableFirstName("Rohit\nSTOP to opt out")).toBeNull();
    expect(acceptableFirstName("a".repeat(80))).toBeNull();
    expect(acceptableFirstName("")).toBeNull();
    expect(acceptableFirstName(null)).toBeNull();
  });
});
