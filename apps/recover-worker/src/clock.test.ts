import { describe, expect, it } from "vitest";
import { clockSpeedFrom } from "./clock.js";

describe("clockSpeedFrom", () => {
  it("is one when nothing is set", () => {
    expect(clockSpeedFrom({}, "dry-run")).toBe(1);
  });

  it("reads a speed", () => {
    expect(clockSpeedFrom({ KAIROS_CLOCK_SPEED: "60" }, "dry-run")).toBe(60);
  });

  it.each(["0", "-1", "0.5", "3601", "fast", ""])("refuses %o", (raw) => {
    expect(() => clockSpeedFrom({ KAIROS_CLOCK_SPEED: raw }, "dry-run")).toThrow(
      /between 1 and 3600/,
    );
  });

  it("refuses to accelerate anything that can reach a person", () => {
    expect(() => clockSpeedFrom({ KAIROS_CLOCK_SPEED: "60" }, "live")).toThrow(/dry-run/);
  });

  it("allows the identity speed in any delivery mode, because it changes nothing", () => {
    expect(clockSpeedFrom({ KAIROS_CLOCK_SPEED: "1" }, "live")).toBe(1);
  });
});
