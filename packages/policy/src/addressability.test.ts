import { slice } from "@kairos/domain";
import { describe, expect, it } from "vitest";
import { checkoutAddressability, isSuppressible } from "./addressability.js";

describe("checkoutAddressability", () => {
  it("can name a netbanking bank exactly", () => {
    // config.display.hide accepts { method: "netbanking", banks: ["HDFC"] }, so this slice can be
    // removed without touching anyone else's netbanking.
    expect(checkoutAddressability(slice("netbanking", "hdfc"))).toBe("precise");
  });

  it("can name a card issuer and network exactly", () => {
    expect(checkoutAddressability(slice("card", "hdfc", "visa"))).toBe("precise");
    expect(checkoutAddressability(slice("card", "icici"))).toBe("precise");
  });

  it("can name a wallet exactly", () => {
    expect(checkoutAddressability(slice("wallet", "paytm"))).toBe("precise");
  });

  it("cannot name a UPI issuer at all", () => {
    // The finding that reshaped the prevention arm. A UPI payment's issuer is the customer's own
    // bank, sitting behind a VPA that has not been typed yet — so when HDFC's UPI handle degrades,
    // Checkout has no way to know which of the people on the payment page bank with HDFC.
    expect(checkoutAddressability(slice("upi", "hdfc"))).toBe("none");
    expect(checkoutAddressability(slice("upi", "sbi"))).toBe("none");
  });

  it("can name a UPI app only partially", () => {
    // `apps` reaches the intent flow. The same app used through a collect request is untouched, so
    // suppression here is leaky, and claiming otherwise would produce a steer that quietly does
    // nothing while still counting as treatment.
    expect(checkoutAddressability(slice("upi", "hdfc", "phonepe"))).toBe("partial");
  });

  it("can always name a whole method", () => {
    expect(checkoutAddressability(slice("upi"))).toBe("method");
    expect(checkoutAddressability(slice("card"))).toBe("method");
  });
});

describe("isSuppressible", () => {
  it("admits only slices Checkout can remove without collateral", () => {
    expect(isSuppressible(slice("netbanking", "hdfc"))).toBe(true);
    expect(isSuppressible(slice("card", "hdfc", "visa"))).toBe(true);
  });

  it("refuses everything Checkout can only approximate", () => {
    expect(isSuppressible(slice("upi", "hdfc"))).toBe(false);
    expect(isSuppressible(slice("upi", "hdfc", "phonepe"))).toBe(false);
    expect(isSuppressible(slice("upi"))).toBe(false);
  });
});
