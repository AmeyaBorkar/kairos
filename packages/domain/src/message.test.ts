import { describe, expect, it } from "vitest";
import { acceptableFirstName } from "./message.js";

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
