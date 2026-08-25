import { describe, expect, it } from "vitest";
import {
  type AuditRecord,
  Chain,
  type ChainedRecord,
  chainRecord,
  GENESIS_HASH,
  hashRecord,
  verifyChain,
} from "./chain.js";

function entry(over: Partial<AuditRecord> = {}): Omit<AuditRecord, "seq"> {
  return {
    at: 1_756_000_000_000,
    actor: "recover-worker/1",
    action: "contact-sms",
    target: "casualty:c_9f3a",
    allowed: true,
    reason: "issuer recovered; customer has balance-likely window open",
    binding: null,
    externalRef: "sms_01HZX",
    outcome: "sent",
    meta: { segments: 1, script: "latin" },
    ...over,
  };
}

function buildChain(count: number): ChainedRecord[] {
  const chain = new Chain();
  return Array.from({ length: count }, (_, i) => chain.append(entry({ target: `casualty:${i}` })));
}

describe("Chain", () => {
  it("starts anchored at genesis", () => {
    const chain = new Chain();
    expect(chain.head).toBe(GENESIS_HASH);
    expect(chain.length).toBe(0);
  });

  it("assigns sequence numbers from zero and advances the head", () => {
    const chain = new Chain();
    const first = chain.append(entry());
    const second = chain.append(entry());

    expect(first.seq).toBe(0);
    expect(second.seq).toBe(1);
    expect(first.prevHash).toBe(GENESIS_HASH);
    expect(second.prevHash).toBe(first.hash);
    expect(chain.head).toBe(second.hash);
    expect(chain.length).toBe(2);
  });

  it("resumes from a persisted head, so a restart does not fork the chain", () => {
    const original = buildChain(3);
    const last = original[2];
    if (last === undefined) throw new Error("fixture");

    const resumed = new Chain(last.hash, 3);
    const next = resumed.append(entry());

    expect(next.seq).toBe(3);
    expect(verifyChain([...original, next]).valid).toBe(true);
  });
});

describe("hashRecord", () => {
  it("is deterministic", () => {
    const r: AuditRecord = { ...entry(), seq: 0 };
    expect(hashRecord(GENESIS_HASH, r)).toBe(hashRecord(GENESIS_HASH, r));
  });

  it("ignores the key order of meta", () => {
    const a: AuditRecord = { ...entry({ meta: { alpha: 1, zeta: 2 } }), seq: 0 };
    const b: AuditRecord = { ...entry({ meta: { zeta: 2, alpha: 1 } }), seq: 0 };
    expect(hashRecord(GENESIS_HASH, a)).toBe(hashRecord(GENESIS_HASH, b));
  });

  it("changes when any field changes", () => {
    const base: AuditRecord = { ...entry(), seq: 0 };
    const baseline = hashRecord(GENESIS_HASH, base);

    expect(hashRecord(GENESIS_HASH, { ...base, allowed: false })).not.toBe(baseline);
    expect(hashRecord(GENESIS_HASH, { ...base, reason: "different" })).not.toBe(baseline);
    expect(hashRecord(GENESIS_HASH, { ...base, at: base.at + 1 })).not.toBe(baseline);
    expect(hashRecord(GENESIS_HASH, { ...base, meta: { segments: 2 } })).not.toBe(baseline);
  });

  it("changes when the predecessor changes, which is what chains it", () => {
    const r: AuditRecord = { ...entry(), seq: 0 };
    expect(hashRecord(GENESIS_HASH, r)).not.toBe(hashRecord("a".repeat(64), r));
  });

  it("produces a 64-character hex digest", () => {
    expect(chainRecord(GENESIS_HASH, { ...entry(), seq: 0 }).hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("verifyChain", () => {
  it("accepts an untouched chain and reports its head", () => {
    const records = buildChain(5);
    const result = verifyChain(records);

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.length).toBe(5);
      expect(result.head).toBe(records[4]?.hash);
    }
  });

  it("accepts an empty chain", () => {
    const result = verifyChain([]);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.head).toBe(GENESIS_HASH);
  });

  it("catches an edit to a record's content", () => {
    const records = buildChain(5);
    const target = records[2];
    if (target === undefined) throw new Error("fixture");

    // Flip a denial into an approval without recomputing the hash — the obvious attack.
    records[2] = { ...target, allowed: !target.allowed };

    const result = verifyChain(records);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.brokenAt).toBe(2);
      expect(result.detail).toMatch(/content altered/);
    }
  });

  it("catches a removed record", () => {
    const records = buildChain(5);
    records.splice(2, 1);

    const result = verifyChain(records);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.brokenAt).toBe(2);
  });

  it("catches reordering that preserves every individual hash", () => {
    const records = buildChain(5);
    const a = records[1];
    const b = records[3];
    if (a === undefined || b === undefined) throw new Error("fixture");
    records[1] = b;
    records[3] = a;

    expect(verifyChain(records).valid).toBe(false);
  });

  it("catches an appended record that does not link to the head", () => {
    const records = buildChain(3);
    records.push(chainRecord("f".repeat(64), { ...entry(), seq: 3 }));

    const result = verifyChain(records);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.brokenAt).toBe(3);
      expect(result.detail).toMatch(/link broken/);
    }
  });

  it("rejects a re-chained suffix when the head hash is known independently", () => {
    // A tamperer who rewrites the suffix produces an internally consistent chain — the defence is
    // that its head no longer matches the head that was published before the edit.
    const original = buildChain(4);
    const publishedHead = verifyChain(original);
    expect(publishedHead.valid).toBe(true);

    const forged = new Chain();
    const rewritten = [
      forged.append(entry({ target: "casualty:0" })),
      forged.append(entry({ target: "casualty:1", allowed: false })),
      forged.append(entry({ target: "casualty:2" })),
      forged.append(entry({ target: "casualty:3" })),
    ];

    const forgedResult = verifyChain(rewritten);
    expect(forgedResult.valid).toBe(true);
    if (forgedResult.valid && publishedHead.valid) {
      expect(forgedResult.head).not.toBe(publishedHead.head);
    }
  });
});
