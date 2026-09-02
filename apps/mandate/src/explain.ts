import { formatINR, type Mandate, paise } from "@kairos/domain";

const DAY_MS = 86_400_000;

export interface ExplainOptions {
  /** Supply to have the signature checked. Omitted means "not checked", which is said out loud. */
  readonly secret?: string;
  /** For "expires in", and for saying whether it is in force right now. */
  readonly now?: number;
  readonly verify?: (mandate: Mandate, secret: string) => boolean;
}

/**
 * A mandate in the words of the person who granted it.
 *
 * The reason this exists is that a signed mandate is unreadable by design — it is a flat object of
 * paise and epoch milliseconds, and the two numbers that matter most are not in it at all but are
 * products of numbers that are. A merchant signing one is authorising spend, and cannot be asked to
 * do arithmetic in their head to find out how much.
 *
 * Returned as lines rather than printed, so the CLI, a test, and eventually a review screen all
 * read the same words.
 */
export function explainMandate(mandate: Mandate, options: ExplainOptions = {}): string[] {
  const now = options.now ?? Date.now();
  const lines: string[] = [];

  lines.push(`Mandate ${mandate.id}`);
  lines.push(`  merchant ${mandate.merchantId} · campaign ${mandate.campaignId}`);
  lines.push("");

  lines.push("IT MAY");
  for (const action of mandate.allowedActions) lines.push(`  · ${describeAction(action)}`);
  lines.push("  and nothing else. Anything not on this list is refused by name.");
  lines.push("");

  lines.push("MONEY");
  // Aligned rather than eyeballed. These four are meant to be compared down the column, and a
  // ragged right edge is how a reader stops comparing them.
  const money = (label: string, value: string, note = ""): string =>
    `  ${label.padEnd(36)}${value.padStart(12)}${note === "" ? "" : `   (${note})`}`;
  lines.push(money("Ceiling for the whole campaign", formatINR(mandate.budgetPaise)));
  lines.push(money("Most one action may cost", formatINR(mandate.maxActionCostPaise)));
  // The two numbers a merchant actually wants and the mandate does not contain. Both are products
  // of fields it does contain, which is exactly why nobody reads them off the JSON.
  const inFlight = paise(mandate.maxActionCostPaise * mandate.maxInFlight);
  lines.push(
    money(
      "Most that can be committed at once",
      formatINR(inFlight),
      `${mandate.maxInFlight} actions in flight`,
    ),
  );
  const worstCaseActions = Math.floor(
    mandate.budgetPaise / Math.max(1, mandate.maxActionCostPaise),
  );
  lines.push(
    money("Actions the budget buys, worst case", worstCaseActions.toLocaleString("en-IN")),
  );
  lines.push(
    "  Spend cannot exceed the ceiling: authority is reserved at the worst case before an action",
  );
  lines.push("  runs and reconciled against what it really cost afterwards.");
  lines.push("");

  if (mandate.allowedActions.some((a) => a.startsWith("contact-"))) {
    lines.push("PEOPLE");
    lines.push(
      `  At most ${mandate.contactCap.limit} message${mandate.contactCap.limit === 1 ? "" : "s"}` +
        ` to one person per ${describeWindow(mandate.contactCap.windowMs)}.`,
    );
    lines.push(
      mandate.quietHours === null
        ? "  No quiet hours. Messages may be sent at any hour of the day or night."
        : `  Nothing sent between ${clock(mandate.quietHours.startMinute)} and ` +
            `${clock(mandate.quietHours.endMinute)} at ${offset(mandate.quietHours.offsetMinutes)}.`,
    );
    lines.push("");
  }

  lines.push("WHEN");
  lines.push(`  From   ${stamp(mandate.validFrom)}`);
  lines.push(
    `  Until  ${stamp(mandate.validUntil)}   (${describeWindow(mandate.validUntil - mandate.validFrom)})`,
  );
  lines.push(`  ${windowStatus(mandate, now)}`);
  lines.push(
    `  A reservation left unreconciled for ${describeWindow(mandate.reservationTtlMs)} returns its` +
      " authority to the pool, so a worker that dies mid-action leaks nothing.",
  );
  lines.push("");

  lines.push("STOP");
  lines.push(
    mandate.killSwitch
      ? "  The signed kill switch is ENGAGED. This mandate authorises nothing at all."
      : "  The signed kill switch is clear. A second, store-backed switch can stop the fleet" +
          " within one admission without re-signing anything; either one stops everything.",
  );
  lines.push("");

  lines.push("SIGNATURE");
  lines.push(`  ${mandate.signature}`);
  lines.push(`  ${describeSignature(mandate, options)}`);

  return lines;
}

function describeSignature(mandate: Mandate, options: ExplainOptions): string {
  if (options.secret === undefined) {
    // Said out loud rather than left to the reader. "No complaint" and "not checked" look identical
    // on a terminal, and only one of them means the mandate is genuine.
    return "Not checked — no secret was supplied, so this says nothing about whether it is genuine.";
  }
  const verify = options.verify;
  if (verify === undefined) return "Not checked — no verifier was supplied.";
  return verify(mandate, options.secret)
    ? "Verified. Every field above is covered by this signature and none of them has been altered."
    : "DOES NOT VERIFY. Either the wrong key, or a field has been edited since it was signed.";
}

function windowStatus(mandate: Mandate, now: number): string {
  if (now < mandate.validFrom)
    return `Not yet in force — starts in ${describeWindow(mandate.validFrom - now)}.`;
  if (now >= mandate.validUntil) return `Expired ${describeWindow(now - mandate.validUntil)} ago.`;
  return `In force now, for another ${describeWindow(mandate.validUntil - now)}.`;
}

function describeAction(action: string): string {
  switch (action) {
    case "retry":
      return "retry — charge a saved token again, with nobody present";
    case "contact-sms":
      return "contact-sms — send one SMS";
    case "contact-whatsapp":
      return "contact-whatsapp — send one WhatsApp message";
    case "contact-email":
      return "contact-email — send one email";
    case "steer":
      return "steer — reorder or hide payment methods on the checkout";
    case "escalate":
      return "escalate — hand the case to a person";
    case "reason":
      return "reason — ask a language model a question, at its metered price";
    default:
      return action;
  }
}

/** Whole days where it divides, hours where it does not, minutes below an hour. */
function describeWindow(ms: number): string {
  if (ms >= DAY_MS && ms % DAY_MS === 0) return plural(ms / DAY_MS, "day");
  if (ms >= 3_600_000) {
    const hours = ms / 3_600_000;
    return Number.isInteger(hours) ? plural(hours, "hour") : plural(Math.round(ms / DAY_MS), "day");
  }
  if (ms >= 60_000) return plural(Math.round(ms / 60_000), "minute");
  return plural(Math.round(ms / 1000), "second");
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

function clock(minuteOfDay: number): string {
  const h = Math.floor(minuteOfDay / 60);
  const m = minuteOfDay % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function offset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/** To the second. A mandate authored at 23:12:35.029 was not authored more precisely than that. */
function stamp(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19).replace("T", " ")}Z`;
}
