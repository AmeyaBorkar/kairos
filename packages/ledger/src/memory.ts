import {
  type AuditRecord,
  Chain,
  type ChainedRecord,
  type VerifyResult,
  verifyChain,
} from "./chain.js";

/**
 * An in-process ledger.
 *
 * Not only a test double. It is the sink the measurement harness runs against — the compliance
 * assertions in the scorecard are made by walking the records this holds — and it is the reference
 * a durable sink must agree with: a Postgres-backed ledger fed the same records must produce the
 * same chain head, which is a cheap and total conformance test.
 *
 * Bounded only by memory, so a long-running process should use a durable sink instead.
 */
export class MemoryLedger {
  readonly #chain = new Chain();
  readonly #records: ChainedRecord[] = [];

  async append(record: Omit<AuditRecord, "seq">): Promise<void> {
    this.#records.push(this.#chain.append(record));
  }

  /** Everything written, in order. */
  get records(): readonly ChainedRecord[] {
    return this.#records;
  }

  get head(): string {
    return this.#chain.head;
  }

  get length(): number {
    return this.#records.length;
  }

  /** Walk the chain and confirm nothing has been altered, removed or reordered. */
  verify(): VerifyResult {
    return verifyChain(this.#records);
  }

  /** Records matching a predicate — the basis of the scorecard's compliance assertions. */
  where(predicate: (record: ChainedRecord) => boolean): readonly ChainedRecord[] {
    return this.#records.filter(predicate);
  }

  /** How many records were refused on each binding axis. */
  countByBinding(): Readonly<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const record of this.#records) {
      if (record.binding === null) continue;
      counts[record.binding] = (counts[record.binding] ?? 0) + 1;
    }
    return counts;
  }
}

/**
 * A sink that fails on demand.
 *
 * Exists because "the ledger is unavailable" is a state the kernel has documented behaviour for —
 * admission fails closed, settlement fails loud — and behaviour that is only documented is
 * behaviour that has not been tested.
 */
export class FailingLedger {
  #failing: boolean;
  readonly #inner = new MemoryLedger();

  constructor(failing = true) {
    this.#failing = failing;
  }

  set failing(value: boolean) {
    this.#failing = value;
  }

  async append(record: Omit<AuditRecord, "seq">): Promise<void> {
    if (this.#failing) throw new Error("ledger unavailable");
    await this.#inner.append(record);
  }

  get records(): readonly ChainedRecord[] {
    return this.#inner.records;
  }
}
