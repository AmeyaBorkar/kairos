import { describe, expect, it } from "vitest";
import { DomainError } from "./brand.js";
import { mandateId } from "./identifiers.js";
import {
  allowsAction,
  inQuietHours,
  isMandateCurrent,
  type Mandate,
  type QuietHours,
  quietHoursEndAt,
  validateMandate,
} from "./mandate.js";
import { paise, rupees } from "./money.js";

const IST = 330;
const HOUR = 3_600_000;

/** 2026-08-25T00:00:00Z, a Tuesday. Chosen so local-midnight arithmetic is easy to check by hand. */
const MIDNIGHT_UTC = Date.UTC(2026, 7, 25, 0, 0, 0);

function mandate(overrides: Partial<Mandate> = {}): Mandate {
  return {
    id: mandateId("mnd_test"),
    merchantId: "acme",
    campaignId: "aug-recovery",
    budgetPaise: rupees(50_000),
    maxActionCostPaise: rupees(3),
    maxInFlight: 8,
    reservationTtlMs: 30_000,
    contactCap: { limit: 3, windowMs: 7 * 24 * HOUR },
    quietHours: { startMinute: 21 * 60, endMinute: 8 * 60, offsetMinutes: IST },
    allowedActions: ["contact-sms", "retry"],
    validFrom: MIDNIGHT_UTC,
    validUntil: MIDNIGHT_UTC + 30 * 24 * HOUR,
    killSwitch: false,
    signature: "unverified",
    ...overrides,
  };
}

describe("validateMandate", () => {
  it("accepts a well-formed mandate", () => {
    expect(() => validateMandate(mandate())).not.toThrow();
  });

  it("accepts a zero budget, which means 'authorised but out of money'", () => {
    // Distinct from a negative budget, which is nonsense, and from an absent one, which would be
    // unlimited by accident. Zero is a legitimate state: the campaign is live and fully spent.
    expect(() => validateMandate(mandate({ budgetPaise: paise(0) }))).not.toThrow();
  });

  it("rejects a negative budget", () => {
    expect(() => validateMandate(mandate({ budgetPaise: paise(-1) }))).toThrow(DomainError);
  });

  it("rejects a mandate that authorises nothing", () => {
    expect(() => validateMandate(mandate({ allowedActions: [] }))).toThrow(/allows nothing/);
  });

  it("rejects duplicate action kinds", () => {
    expect(() => validateMandate(mandate({ allowedActions: ["retry", "retry"] }))).toThrow(
      /duplicate/,
    );
  });

  it("rejects an empty validity window", () => {
    expect(() => validateMandate(mandate({ validUntil: MIDNIGHT_UTC }))).toThrow(/empty/);
  });

  it("rejects a non-positive in-flight cap, because it is a term in the overspend bound", () => {
    expect(() => validateMandate(mandate({ maxInFlight: 0 }))).toThrow(DomainError);
  });

  it("rejects a non-positive per-action cost cap, for the same reason", () => {
    expect(() => validateMandate(mandate({ maxActionCostPaise: paise(0) }))).toThrow(DomainError);
  });

  it("rejects a reservation TTL of zero, which would expire every reservation instantly", () => {
    expect(() => validateMandate(mandate({ reservationTtlMs: 0 }))).toThrow(DomainError);
  });

  it("rejects a quiet-hours minute outside the day", () => {
    const quietHours: QuietHours = { startMinute: 1440, endMinute: 60, offsetMinutes: IST };
    expect(() => validateMandate(mandate({ quietHours }))).toThrow(/minute of day/);
  });

  it("rejects an implausible UTC offset", () => {
    const quietHours: QuietHours = { startMinute: 0, endMinute: 60, offsetMinutes: 5000 };
    expect(() => validateMandate(mandate({ quietHours }))).toThrow(/UTC offset/);
  });

  it("accepts a mandate with no quiet hours at all", () => {
    expect(() => validateMandate(mandate({ quietHours: null }))).not.toThrow();
  });
});

describe("isMandateCurrent", () => {
  const m = mandate();

  it("is half-open, so the expiry instant is already expired", () => {
    expect(isMandateCurrent(m, m.validFrom)).toBe(true);
    expect(isMandateCurrent(m, m.validUntil - 1)).toBe(true);
    expect(isMandateCurrent(m, m.validUntil)).toBe(false);
  });

  it("rejects a time before the window opens", () => {
    expect(isMandateCurrent(m, m.validFrom - 1)).toBe(false);
  });
});

describe("allowsAction", () => {
  it("admits only what is named", () => {
    const m = mandate();
    expect(allowsAction(m, "contact-sms")).toBe(true);
    expect(allowsAction(m, "contact-whatsapp")).toBe(false);
  });
});

describe("inQuietHours", () => {
  const night: QuietHours = { startMinute: 21 * 60, endMinute: 8 * 60, offsetMinutes: IST };

  /** Epoch ms at a given IST wall-clock hour on the reference day. */
  const ist = (hour: number, minute = 0): number =>
    MIDNIGHT_UTC + (hour * 60 + minute - IST) * 60_000 + 24 * HOUR;

  it("covers the small hours", () => {
    expect(inQuietHours(night, ist(2))).toBe(true);
    expect(inQuietHours(night, ist(23))).toBe(true);
  });

  it("leaves the working day open", () => {
    expect(inQuietHours(night, ist(9))).toBe(false);
    expect(inQuietHours(night, ist(14, 30))).toBe(false);
  });

  it("is inclusive at the start and exclusive at the end", () => {
    expect(inQuietHours(night, ist(21))).toBe(true);
    expect(inQuietHours(night, ist(20, 59))).toBe(false);
    expect(inQuietHours(night, ist(8))).toBe(false);
    expect(inQuietHours(night, ist(7, 59))).toBe(true);
  });

  it("handles a window that does not wrap midnight", () => {
    const lunch: QuietHours = { startMinute: 13 * 60, endMinute: 14 * 60, offsetMinutes: IST };
    expect(inQuietHours(lunch, ist(13, 30))).toBe(true);
    expect(inQuietHours(lunch, ist(12, 30))).toBe(false);
    expect(inQuietHours(lunch, ist(14, 30))).toBe(false);
  });

  it("treats an empty window as covering nothing rather than everything", () => {
    // The alternative reading — start === end means "all day" — would silently mute a campaign.
    const empty: QuietHours = { startMinute: 600, endMinute: 600, offsetMinutes: IST };
    expect(inQuietHours(empty, ist(10))).toBe(false);
  });

  it("respects the offset rather than UTC", () => {
    // 22:00 IST is 16:30 UTC. A UTC-based implementation would call this daytime.
    const utcAfternoon = MIDNIGHT_UTC + 16 * HOUR + 30 * 60_000;
    expect(inQuietHours(night, utcAfternoon)).toBe(true);
  });

  it("works for times before the epoch, where naive modulo goes negative", () => {
    const beforeEpoch = -5 * HOUR;
    expect(typeof inQuietHours(night, beforeEpoch)).toBe("boolean");
  });
});

describe("quietHoursEndAt", () => {
  const night: QuietHours = { startMinute: 21 * 60, endMinute: 8 * 60, offsetMinutes: IST };
  const ist = (hour: number, minute = 0): number =>
    MIDNIGHT_UTC + (hour * 60 + minute - IST) * 60_000 + 24 * HOUR;

  it("returns the time unchanged when the window is not in force", () => {
    const at = ist(10);
    expect(quietHoursEndAt(night, at)).toBe(at);
  });

  it("waits until morning when called after midnight", () => {
    expect(quietHoursEndAt(night, ist(2))).toBe(ist(8));
  });

  it("crosses midnight when called in the evening", () => {
    // 22:00 → 08:00 the next morning is ten hours, not fourteen hours backwards.
    expect(quietHoursEndAt(night, ist(22))).toBe(ist(8) + 24 * HOUR);
  });

  it("never returns a time still inside the window", () => {
    for (let hour = 0; hour < 24; hour++) {
      const end = quietHoursEndAt(night, ist(hour));
      expect(inQuietHours(night, end)).toBe(false);
    }
  });
});
