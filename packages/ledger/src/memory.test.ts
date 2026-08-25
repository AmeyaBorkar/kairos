import { describe, expect, it } from "vitest";
import type { AuditRecord } from "./chain.js";
import { GENESIS_HASH } from "./chain.js";
import { FailingLedger, MemoryLedger } from "./memory.js";

const record = (overrides: Partial<AuditRecord> = {}): Omit<AuditRecord, "seq"> => ({
  at: 1_756_000_000_000,
  actor: "recover-worker/1",
  action: "contact-sms",
  target: "casualty:cas_001",
  allowed: true,
  reason: "reserved 300 paise",
  binding: null,
  externalRef: null,
  outcome: null,
  meta: {},
  ...overrides,
});

describe("MemoryLedger", () => {
  it("starts empty, at the genesis head", () => {
    const ledger = new MemoryLedger();
    expect(ledger.length).toBe(0);
    expect(ledger.head).toBe(GENESIS_HASH);
    expect(ledger.verify()).toMatchObject({ valid: true, length: 0 });
  });

  it("assigns sequence numbers rather than trusting the caller", async () => {
    const ledger = new MemoryLedger();
    await ledger.append(record());
    await ledger.append(record());
    expect(ledger.records.map((r) => r.seq)).toEqual([0, 1]);
  });

  it("advances the head with every record", async () => {
    const ledger = new MemoryLedger();
    await ledger.append(record());
    const first = ledger.head;
    await ledger.append(record());
    expect(ledger.head).not.toBe(first);
    expect(ledger.head).toBe(ledger.records.at(-1)?.hash);
  });

  it("produces a chain that verifies", async () => {
    const ledger = new MemoryLedger();
    for (let i = 0; i < 25; i++) await ledger.append(record({ at: 1_756_000_000_000 + i }));
    expect(ledger.verify()).toMatchObject({ valid: true, length: 25 });
  });

  it("filters records for the compliance assertions the scorecard makes", async () => {
    const ledger = new MemoryLedger();
    await ledger.append(record({ allowed: true }));
    await ledger.append(record({ allowed: false, binding: "quiet-hours" }));
    await ledger.append(record({ allowed: false, binding: "quiet-hours" }));
    await ledger.append(record({ allowed: false, binding: "budget" }));

    expect(ledger.where((r) => !r.allowed).length).toBe(3);
    expect(ledger.countByBinding()).toEqual({ "quiet-hours": 2, budget: 1 });
  });

  it("counts nothing for records with no binding axis", async () => {
    const ledger = new MemoryLedger();
    await ledger.append(record({ allowed: true, binding: null }));
    expect(ledger.countByBinding()).toEqual({});
  });
});

describe("FailingLedger", () => {
  it("rejects while it is failing", async () => {
    const ledger = new FailingLedger();
    await expect(ledger.append(record())).rejects.toThrow(/unavailable/);
    expect(ledger.records.length).toBe(0);
  });

  it("writes through once it recovers", async () => {
    const ledger = new FailingLedger(false);
    await ledger.append(record());
    ledger.failing = true;
    await expect(ledger.append(record())).rejects.toThrow();
    ledger.failing = false;
    await ledger.append(record());
    expect(ledger.records.length).toBe(2);
  });
});
