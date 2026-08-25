import { describe, expect, it } from "vitest";
import { DomainError } from "./brand.js";
import {
  addPaise,
  formatINR,
  maxPaise,
  minPaise,
  mulPaise,
  nonNegativePaise,
  paise,
  rupees,
  subPaise,
  sumPaise,
  ZERO,
} from "./money.js";

describe("paise", () => {
  it("accepts safe integers, including negative ones for deltas", () => {
    expect(paise(0)).toBe(0);
    expect(paise(12345)).toBe(12345);
    expect(paise(-500)).toBe(-500);
  });

  it.each([
    ["a fraction", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["beyond exact integer arithmetic", Number.MAX_SAFE_INTEGER + 2],
  ])("rejects %s", (_label, value) => {
    expect(() => paise(value)).toThrow(DomainError);
  });

  it("names the offending field so the error is actionable", () => {
    expect(() => paise(1.5, "budgetPaise")).toThrow(/^budgetPaise:/);
  });
});

describe("nonNegativePaise", () => {
  it("accepts zero and positives", () => {
    expect(nonNegativePaise(0)).toBe(0);
    expect(nonNegativePaise(1)).toBe(1);
  });

  it("rejects negatives, which a budget or cap can never be", () => {
    expect(() => nonNegativePaise(-1, "budget")).toThrow(DomainError);
  });
});

describe("rupees", () => {
  it("converts whole and two-decimal rupees", () => {
    expect(rupees(1)).toBe(100);
    expect(rupees(12.34)).toBe(1234);
    expect(rupees(0.05)).toBe(5);
  });

  it("survives binary floating-point representation error", () => {
    // 8.29 * 100 is 828.9999999999999 in IEEE-754; naive truncation would lose a paise.
    expect(rupees(8.29)).toBe(829);
    expect(rupees(1.1)).toBe(110);
    expect(rupees(70.07)).toBe(7007);
  });

  it("rejects amounts finer than a paise", () => {
    expect(() => rupees(1.005)).toThrow(DomainError);
  });
});

describe("arithmetic", () => {
  it("adds, subtracts and sums", () => {
    expect(addPaise(paise(100), paise(250))).toBe(350);
    expect(subPaise(paise(100), paise(250))).toBe(-150);
    expect(sumPaise([paise(1), paise(2), paise(3)])).toBe(6);
  });

  it("sums an empty list to zero", () => {
    expect(sumPaise([])).toBe(ZERO);
  });

  it("compares", () => {
    expect(maxPaise(paise(5), paise(9))).toBe(9);
    expect(minPaise(paise(5), paise(9))).toBe(5);
    expect(maxPaise(paise(-5), paise(-9))).toBe(-5);
  });

  it("keeps every result an integer", () => {
    expect(Number.isInteger(mulPaise(paise(333), 0.333))).toBe(true);
    expect(Number.isInteger(mulPaise(paise(1), 1 / 3))).toBe(true);
  });

  it("rounds half away from zero, so scaling stays symmetric about zero", () => {
    // Math.round(-0.5) is -0, which would make a refund and its charge disagree by a paise.
    expect(mulPaise(paise(1), 0.5)).toBe(1);
    expect(mulPaise(paise(-1), 0.5)).toBe(-1);
    expect(mulPaise(paise(3), 0.5)).toBe(2);
    expect(mulPaise(paise(-3), 0.5)).toBe(-2);
  });

  it("negating the input negates the output for any factor", () => {
    for (const amount of [1, 3, 7, 99, 12345]) {
      for (const factor of [0.5, 0.333, 1.5, 2]) {
        expect(mulPaise(paise(-amount), factor)).toBe(-mulPaise(paise(amount), factor));
      }
    }
  });

  it("rejects a non-finite factor rather than producing NaN money", () => {
    expect(() => mulPaise(paise(100), Number.NaN)).toThrow(DomainError);
    expect(() => mulPaise(paise(100), Number.POSITIVE_INFINITY)).toThrow(DomainError);
  });
});

describe("formatINR", () => {
  it("groups the Indian way — last three digits, then pairs", () => {
    expect(formatINR(paise(12345678))).toBe("₹1,23,456.78");
    expect(formatINR(paise(100000000))).toBe("₹10,00,000.00");
  });

  it("formats small amounts without grouping", () => {
    expect(formatINR(paise(0))).toBe("₹0.00");
    expect(formatINR(paise(5))).toBe("₹0.05");
    expect(formatINR(paise(99999))).toBe("₹999.99");
  });

  it("pads the paise component", () => {
    expect(formatINR(paise(100))).toBe("₹1.00");
    expect(formatINR(paise(105))).toBe("₹1.05");
  });

  it("puts the sign outside the symbol", () => {
    expect(formatINR(paise(-12345))).toBe("-₹123.45");
  });
});
