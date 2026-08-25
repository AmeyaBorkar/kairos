import { describe, expect, it } from "vitest";
import { CanonicalizationError, canonicalize, type JsonValue } from "./canonical.js";

describe("canonicalize", () => {
  it("sorts object keys so insertion order cannot change the bytes", () => {
    const a: JsonValue = { zebra: 1, alpha: 2, mid: 3 };
    const b: JsonValue = { mid: 3, zebra: 1, alpha: 2 };
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(canonicalize(a)).toBe('{"alpha":2,"mid":3,"zebra":1}');
  });

  it("sorts nested keys too", () => {
    const a: JsonValue = { outer: { b: 1, a: 2 } };
    const b: JsonValue = { outer: { a: 2, b: 1 } };
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  it("preserves array order, which carries meaning", () => {
    expect(canonicalize([3, 1, 2] as JsonValue)).toBe("[3,1,2]");
    expect(canonicalize([1, 2, 3] as JsonValue)).not.toBe(canonicalize([3, 2, 1] as JsonValue));
  });

  it("emits no incidental whitespace", () => {
    expect(canonicalize({ a: 1, b: [1, 2] } as JsonValue)).toBe('{"a":1,"b":[1,2]}');
  });

  it("handles the primitives", () => {
    expect(canonicalize(null)).toBe("null");
    expect(canonicalize(true)).toBe("true");
    expect(canonicalize(false)).toBe("false");
    expect(canonicalize(42)).toBe("42");
    expect(canonicalize("hi")).toBe('"hi"');
  });

  it("escapes strings that would otherwise break the encoding", () => {
    expect(canonicalize('a"b')).toBe('"a\\"b"');
    expect(canonicalize("line\nbreak")).toBe('"line\\nbreak"');
  });

  it("normalises negative zero, which JSON cannot distinguish", () => {
    expect(canonicalize(-0)).toBe(canonicalize(0));
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
  ])("rejects %s rather than silently writing null", (_label, value) => {
    expect(() => canonicalize(value)).toThrow(CanonicalizationError);
  });

  it("rejects undefined, which would drop a field without changing the hash", () => {
    const withUndefined = { a: 1, b: undefined } as unknown as JsonValue;
    expect(() => canonicalize(withUndefined)).toThrow(CanonicalizationError);
  });

  it("reports the path to the offending value", () => {
    const bad = { outer: { inner: [1, Number.NaN] } } as JsonValue;
    expect(() => canonicalize(bad)).toThrow(/outer\.inner\[1\]/);
  });

  it("rejects values with no JSON representation", () => {
    expect(() => canonicalize((() => 1) as unknown as JsonValue)).toThrow(CanonicalizationError);
    expect(() => canonicalize(10n as unknown as JsonValue)).toThrow(CanonicalizationError);
  });
});
