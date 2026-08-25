import type { CasualtyStatus } from "@kairos/domain";
import { describe, expect, it } from "vitest";
import { CLEAN_STATUS, DEFAULT_STOP_CONFIG, describeStop, stopReasonFor } from "./stops.js";

const status = (overrides: Partial<CasualtyStatus> = {}): CasualtyStatus => ({
  ...CLEAN_STATUS,
  ...overrides,
});

describe("stopReasonFor", () => {
  it("lets a fresh casualty through", () => {
    expect(stopReasonFor(CLEAN_STATUS, DEFAULT_STOP_CONFIG)).toBeNull();
  });

  it("stops on a payment that already succeeded", () => {
    expect(stopReasonFor(status({ recovered: true }), DEFAULT_STOP_CONFIG)).toBe("recovered");
  });

  it("stops on an opt-out", () => {
    expect(stopReasonFor(status({ optedOut: true }), DEFAULT_STOP_CONFIG)).toBe("opted-out");
  });

  it("stops while a dispute is open", () => {
    expect(stopReasonFor(status({ disputed: true }), DEFAULT_STOP_CONFIG)).toBe("disputed");
  });

  it("stops on a failure classified dead", () => {
    // A stolen card or a fraud flag is not a retry problem. Chasing it is cost without information,
    // and in the fraud case it is cost that draws attention we do not want.
    expect(stopReasonFor(status({ recoverability: "dead" }), DEFAULT_STOP_CONFIG)).toBe(
      "dead-class",
    );
  });

  it("stops at the hard-decline threshold, not one before it", () => {
    expect(stopReasonFor(status({ consecutiveHardDeclines: 2 }), DEFAULT_STOP_CONFIG)).toBeNull();
    expect(stopReasonFor(status({ consecutiveHardDeclines: 3 }), DEFAULT_STOP_CONFIG)).toBe(
      "hard-declines",
    );
  });

  it("takes the threshold from config rather than a constant", () => {
    const strict = { maxConsecutiveHardDeclines: 1 };
    expect(stopReasonFor(status({ consecutiveHardDeclines: 1 }), strict)).toBe("hard-declines");
  });

  it("reports recovery ahead of everything else, because there is nothing left to chase", () => {
    const everything = status({
      recovered: true,
      optedOut: true,
      disputed: true,
      recoverability: "dead",
      consecutiveHardDeclines: 9,
    });
    expect(stopReasonFor(everything, DEFAULT_STOP_CONFIG)).toBe("recovered");
  });

  it("reports an opt-out ahead of the commercial rules", () => {
    // Precedence is the point: an opt-out is not one consideration among several, and ordering the
    // checks is how that is enforced rather than merely intended.
    const both = status({ optedOut: true, consecutiveHardDeclines: 9, recoverability: "dead" });
    expect(stopReasonFor(both, DEFAULT_STOP_CONFIG)).toBe("opted-out");
  });

  it("does not stop on a class that is merely hard to recover", () => {
    expect(
      stopReasonFor(status({ recoverability: "customer-action" }), DEFAULT_STOP_CONFIG),
    ).toBeNull();
    expect(stopReasonFor(status({ recoverability: "unknown" }), DEFAULT_STOP_CONFIG)).toBeNull();
  });
});

describe("describeStop", () => {
  it("explains every reason in plain language", () => {
    const reasons = ["recovered", "opted-out", "disputed", "dead-class", "hard-declines"] as const;
    for (const reason of reasons) {
      const text = describeStop(reason, DEFAULT_STOP_CONFIG);
      expect(text.length).toBeGreaterThan(10);
      expect(text).not.toContain("_");
    }
  });

  it("puts the actual threshold in the hard-decline explanation", () => {
    expect(describeStop("hard-declines", { maxConsecutiveHardDeclines: 5 })).toContain("5");
  });
});
