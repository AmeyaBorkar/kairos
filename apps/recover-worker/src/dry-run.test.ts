import { customerRef, orderId, paise } from "@kairos/domain";
import { DEFAULT_RECOVERY_CONFIG } from "@kairos/recover";
import { describe, expect, it } from "vitest";
import { dryRunGateway, dryRunMessenger } from "./dry-run.js";

const sink = () => {
  const lines: string[] = [];
  return { lines, write: (line: string) => lines.push(line) };
};

const send = (channel: "contact-sms" | "contact-whatsapp" | "contact-email", text = "Hi.") => ({
  idempotencyKey: "grant_1",
  channel,
  customer: customerRef("cust_00000000000000000001"),
  text,
  subject: null,
  segments: 1,
});

const priceOf = (kind: string) =>
  DEFAULT_RECOVERY_CONFIG.prices.find((p) => p.kind === kind)?.sendPaise ?? -1;

describe("the dry-run messenger", () => {
  it("books what the message would have cost, not nothing", async () => {
    // The one number somebody runs a dry run to find out. Returning zero made the budget ceiling
    // impossible to see bind, and made a campaign's cost report as free.
    const out = sink();
    const messenger = dryRunMessenger({ sink: out.write });
    for (const channel of ["contact-whatsapp", "contact-email"] as const) {
      const result = await messenger.send(send(channel));
      expect(result.costPaise).toBe(priceOf(channel));
      expect(result.costPaise).toBeGreaterThan(0);
    }
  });

  it("prices SMS by segment, because that is how it is billed", async () => {
    const messenger = dryRunMessenger({ sink: sink().write, smsSegmentPaise: 20 });
    const short = await messenger.send(send("contact-sms", "Hi."));
    const long = await messenger.send(send("contact-sms", "x".repeat(400)));
    expect(short.costPaise).toBe(20);
    expect(long.costPaise).toBeGreaterThan(short.costPaise);
  });

  it("settles against the same list the decision was priced against", async () => {
    // A dry run whose spend disagreed with the expected-value gate that authorised it would make
    // both numbers useless.
    const messenger = dryRunMessenger({ sink: sink().write, prices: DEFAULT_RECOVERY_CONFIG });
    expect((await messenger.send(send("contact-email"))).costPaise).toBe(priceOf("contact-email"));
  });

  it("reports delivered, so the contact cap is consumed as it would be in production", async () => {
    const messenger = dryRunMessenger({ sink: sink().write });
    expect((await messenger.send(send("contact-email"))).delivered).toBe(true);
  });

  it("prints the composed text, which is the point of running in this mode", async () => {
    const out = sink();
    await dryRunMessenger({ sink: out.write }).send(send("contact-sms", "Hi Sara, your payment."));
    expect(out.lines).toHaveLength(1);
    expect(JSON.parse(out.lines[0] as string)).toMatchObject({
      would: "send",
      channel: "contact-sms",
      text: "Hi Sara, your payment.",
    });
  });

  it("never returns an external reference, because nothing external happened", async () => {
    const result = await dryRunMessenger({ sink: sink().write }).send(send("contact-email"));
    expect(result.externalRef).toBeNull();
  });
});

describe("the dry-run gateway", () => {
  it("declines softly and costs nothing", async () => {
    // A retry against a token is billed on capture, and nothing was captured. Zero here is the
    // right answer, unlike zero for a message that a provider would have charged for.
    const result = await dryRunGateway({ sink: sink().write }).charge({
      idempotencyKey: "grant_2",
      orderId: orderId("order_1"),
      customer: customerRef("cust_00000000000000000001"),
      amount: paise(50_000),
      token: "token_x",
    });
    expect(result.outcome).toBe("declined-soft");
    expect(result.costPaise).toBe(0);
    expect(result.externalRef).toBeNull();
  });

  it("never reports a recovery", async () => {
    // A dry run that reported recoveries would poison the probability model with outcomes that
    // never happened, and the model decides how much to spend later.
    const result = await dryRunGateway({ sink: sink().write }).charge({
      idempotencyKey: "grant_3",
      orderId: orderId("order_2"),
      customer: customerRef("cust_00000000000000000001"),
      amount: paise(50_000),
      token: "token_x",
    });
    expect(result.outcome).not.toBe("captured");
  });
});
