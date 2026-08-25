import { customerRef, incidentId, type PaymentMethod, slice } from "@kairos/domain";
import { neutralPlan, type SteeringPlan } from "@kairos/policy";
import { describe, expect, it } from "vitest";
import { defaultCheckout, instrumentFor, renderCheckout } from "./checkout.js";

const METHODS: readonly PaymentMethod[] = [
  "upi",
  "card",
  "netbanking",
  "wallet",
  "paylater",
  "emi",
];
const CUSTOMER = customerRef("cus_000000000001");
const NOW = Date.UTC(2026, 7, 25, 12, 0, 0);

function plan(overrides: Partial<SteeringPlan> = {}): SteeringPlan {
  return { ...neutralPlan(CUSTOMER, METHODS, NOW), ...overrides };
}

describe("instrumentFor", () => {
  it("names a netbanking bank by its IFSC code", () => {
    // Axis is UTIB, not "axis". A shorthand that looks right and matches nothing produces a steer
    // that silently does nothing while still counting as treatment.
    expect(instrumentFor(slice("netbanking", "axis"))).toEqual({
      method: "netbanking",
      banks: ["UTIB"],
    });
  });

  it("names a card issuer and network", () => {
    expect(instrumentFor(slice("card", "hdfc", "visa"))).toEqual({
      method: "card",
      issuers: ["HDFC"],
      networks: ["Visa"],
    });
  });

  it("omits the network when the slice does not name one", () => {
    expect(instrumentFor(slice("card", "icici"))).toEqual({ method: "card", issuers: ["ICIC"] });
  });

  it("names a wallet and a pay-later provider", () => {
    expect(instrumentFor(slice("wallet", "paytm"))).toEqual({
      method: "wallet",
      wallets: ["paytm"],
    });
    expect(instrumentFor(slice("paylater", "lazypay"))).toEqual({
      method: "paylater",
      providers: ["lazypay"],
    });
  });

  it("names a UPI app only on the intent flow", () => {
    // `apps` reaches the intent button. Collect requests to the same app are untouched, which is
    // exactly why policy treats UPI app slices as partially addressable rather than precise.
    expect(instrumentFor(slice("upi", "hdfc", "gpay"))).toEqual({
      method: "upi",
      apps: ["google_pay"],
      flows: ["intent"],
    });
  });

  it("refuses to name a UPI issuer, and says why", () => {
    const result = instrumentFor(slice("upi", "hdfc"));
    expect(result).toMatchObject({ reason: expect.stringContaining("customer's own bank") });
  });

  it("refuses an issuer it has no code for rather than guessing", () => {
    // Emitting the shorthand would produce a `hide` entry matching nothing. Failing loudly here is
    // the only way that mistake ever becomes visible.
    const result = instrumentFor(slice("netbanking", "some-new-bank"));
    expect(result).toMatchObject({ reason: expect.stringContaining("no Razorpay bank code") });
  });

  it("refuses an unknown card network", () => {
    const result = instrumentFor(slice("card", "hdfc", "unionpay"));
    expect(result).toMatchObject({ reason: expect.stringContaining("network code") });
  });
});

describe("renderCheckout", () => {
  it("renders a neutral plan as the merchant's own order", () => {
    const rendered = renderCheckout(plan(), METHODS);
    expect(rendered.config.display.sequence).toEqual(METHODS);
    expect(rendered.config.display.hide).toBeUndefined();
    expect(rendered.diagnostics).toEqual([]);
  });

  it("renders a demotion as a reordered sequence with the default list switched off", () => {
    const demoted: readonly PaymentMethod[] = [
      "card",
      "netbanking",
      "wallet",
      "paylater",
      "emi",
      "upi",
    ];
    const rendered = renderCheckout(plan({ sequence: demoted, demote: ["upi"] }), METHODS);

    expect(rendered.config.display.sequence).toEqual(demoted);
    expect(rendered.config.display.preferences.show_default_blocks).toBe(false);
  });

  it("renders a suppression as a hide entry", () => {
    const rendered = renderCheckout(plan({ suppress: [slice("netbanking", "hdfc")] }), METHODS);
    expect(rendered.config.display.hide).toEqual([{ method: "netbanking", banks: ["HDFC"] }]);
  });

  it("keeps every method the merchant offers in the sequence", () => {
    // With the default list switched off, anything missing from the sequence disappears from the
    // checkout. A reorder that silently removes methods is the failure the method floor exists to
    // prevent, so the sequence is always exhaustive.
    const rendered = renderCheckout(plan({ sequence: ["card", "upi"] }), METHODS);
    for (const method of METHODS) expect(rendered.config.display.sequence).toContain(method);
  });

  it("reports a suppression it could not express instead of dropping it", () => {
    const rendered = renderCheckout(plan({ suppress: [slice("upi", "hdfc")] }), METHODS);
    expect(rendered.config.display.hide).toBeUndefined();
    expect(rendered.diagnostics).toHaveLength(1);
  });

  it("still renders the expressible suppressions alongside a failed one", () => {
    const rendered = renderCheckout(
      plan({ suppress: [slice("upi", "hdfc"), slice("netbanking", "hdfc")] }),
      METHODS,
    );
    expect(rendered.config.display.hide).toHaveLength(1);
    expect(rendered.diagnostics).toHaveLength(1);
  });

  it("produces JSON with no undefined values, which Checkout would reject", () => {
    const rendered = renderCheckout(plan({ suppress: [slice("card", "hdfc", "visa")] }), METHODS);
    expect(JSON.parse(JSON.stringify(rendered.config))).toEqual(rendered.config);
  });
});

describe("defaultCheckout", () => {
  it("is what the checkout would do with Kairos absent entirely", () => {
    // Every failure path resolves here: sentry unreachable, the 50 ms budget blown, a malformed
    // response. Nothing hidden, the merchant's own order, the default list left on.
    const config = defaultCheckout(METHODS);
    expect(config.display.sequence).toEqual(METHODS);
    expect(config.display.preferences.show_default_blocks).toBe(true);
    expect(config.display.hide).toBeUndefined();
  });
});

describe("the arms are distinguishable in what a customer sees", () => {
  it("gives a control customer a configuration identical to no Kairos at all", () => {
    const control = plan({ heldOutOf: [incidentId("inc_1")] });
    const rendered = renderCheckout(control, METHODS);
    expect(rendered.config.display.sequence).toEqual(defaultCheckout(METHODS).display.sequence);
    expect(rendered.config.display.hide).toBeUndefined();
  });
});
