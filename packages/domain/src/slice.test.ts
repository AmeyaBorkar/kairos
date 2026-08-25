import { describe, expect, it } from "vitest";
import { DomainError } from "./brand.js";
import {
  formatSlice,
  parseSliceKey,
  slice,
  sliceCovers,
  sliceDepth,
  sliceEquals,
  sliceKey,
  sliceParents,
} from "./slice.js";

describe("slice", () => {
  it("builds at each level of specificity", () => {
    expect(sliceDepth(slice("upi"))).toBe(0);
    expect(sliceDepth(slice("upi", "hdfc"))).toBe(1);
    expect(sliceDepth(slice("upi", "hdfc", "phonepe"))).toBe(2);
  });

  it("rejects an instrument without an issuer, which has no meaning", () => {
    expect(() => slice("card", null, "visa")).toThrow(DomainError);
  });

  it("rejects empty components, which would collide with null in the key", () => {
    expect(() => slice("upi", "")).toThrow(DomainError);
  });

  it("rejects the separator, which would break key round-tripping", () => {
    expect(() => slice("upi", "hd|fc")).toThrow(DomainError);
  });
});

describe("sliceKey", () => {
  it.each([
    ["method only", slice("netbanking")],
    ["with issuer", slice("netbanking", "sbi")],
    ["fully qualified", slice("card", "hdfc", "visa")],
  ])("round-trips %s", (_label, s) => {
    expect(parseSliceKey(sliceKey(s))).toEqual(s);
  });

  it("distinguishes issuer-only from fully-qualified", () => {
    expect(sliceKey(slice("upi", "hdfc"))).not.toBe(sliceKey(slice("upi", "hdfc", "gpay")));
  });

  it("rejects a malformed key", () => {
    expect(() => parseSliceKey("upi|hdfc")).toThrow(DomainError);
    expect(() => parseSliceKey("teleport||")).toThrow(DomainError);
  });
});

describe("sliceParents", () => {
  it("walks from most to least specific", () => {
    expect(sliceParents(slice("upi", "hdfc", "phonepe"))).toEqual([
      slice("upi", "hdfc"),
      slice("upi"),
    ]);
  });

  it("returns one parent for an issuer-level slice", () => {
    expect(sliceParents(slice("upi", "hdfc"))).toEqual([slice("upi")]);
  });

  it("returns none for a method-level slice, which is already the root", () => {
    expect(sliceParents(slice("upi"))).toEqual([]);
  });

  it("produces strictly decreasing depth, so shrinkage always terminates", () => {
    const parents = sliceParents(slice("card", "icici", "rupay"));
    const depths = parents.map(sliceDepth);
    expect(depths).toEqual([...depths].sort((a, b) => b - a));
    expect(new Set(depths).size).toBe(depths.length);
  });
});

describe("sliceCovers", () => {
  const specific = slice("upi", "hdfc", "phonepe");

  it("covers itself", () => {
    expect(sliceCovers(specific, specific)).toBe(true);
  });

  it("covers descendants", () => {
    expect(sliceCovers(slice("upi", "hdfc"), specific)).toBe(true);
    expect(sliceCovers(slice("upi"), specific)).toBe(true);
  });

  it("does not cover siblings or unrelated methods", () => {
    expect(sliceCovers(slice("upi", "sbi"), specific)).toBe(false);
    expect(sliceCovers(slice("card"), specific)).toBe(false);
  });

  it("is not symmetric — a child never covers its parent", () => {
    expect(sliceCovers(specific, slice("upi", "hdfc"))).toBe(false);
  });
});

describe("sliceEquals and formatSlice", () => {
  it("compares structurally", () => {
    expect(sliceEquals(slice("upi", "hdfc"), slice("upi", "hdfc"))).toBe(true);
    expect(sliceEquals(slice("upi", "hdfc"), slice("upi", "sbi"))).toBe(false);
  });

  it("omits absent components when formatting", () => {
    expect(formatSlice(slice("upi", "hdfc", "phonepe"))).toBe("upi · hdfc · phonepe");
    expect(formatSlice(slice("upi"))).toBe("upi");
  });
});
