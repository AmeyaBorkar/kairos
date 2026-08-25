import type { ApplyOutcome, Store, Transform } from "throttlekit";
import {
  type Applied,
  availablePaise,
  type BudgetState,
  emptyBudget,
  inFlight,
  type ReleaseResult,
  type ReserveRequest,
  type ReserveResult,
  release,
  reserve,
  type SettleResult,
  settle,
  sweepExpired,
} from "./budget.js";

/**
 * The commitment ledger, bound to a store.
 *
 * ThrottleKit contributes exactly one thing here, and it is the load-bearing thing: {@link Store}
 * exposes a single mutating primitive, an *atomic* read-modify-write over one key, proven
 * bit-identical across the in-memory, Redis and Postgres backends. Everything above it in this file
 * is a pure function of the prior state, which means the entire reserve-check-commit sequence
 * collapses into one indivisible step no matter which backend is underneath.
 *
 * That is why the same code is correct in a unit test and in a fleet: swapping `MemoryStore` for
 * `RedisStore` changes where the bytes live, not whether the bound holds.
 */
export interface BudgetLedgerOptions {
  readonly store: Store;
  /** The ledger's key. Every worker sharing a budget must use the same one. */
  readonly key: string;
  readonly budgetPaise: number;
  /**
   * How long the ledger's own state survives without traffic.
   *
   * This must outlive the mandate. If the key expires mid-campaign the ledger resurrects at zero
   * spent, which is not a rounding error — it is the entire budget again. Callers derive it from
   * the mandate's validity window rather than picking a number.
   */
  readonly stateTtlMs: number;
}

export class BudgetLedger {
  readonly #store: Store;
  readonly #key: string;
  readonly #seed: BudgetState;
  readonly #ttlMs: number;

  constructor(options: BudgetLedgerOptions) {
    this.#store = options.store;
    this.#key = options.key;
    this.#seed = emptyBudget(options.budgetPaise);
    this.#ttlMs = options.stateTtlMs;
  }

  /**
   * Lift a pure operation into an atomic store transform.
   *
   * The prior state may be absent (first touch, or a store that dropped the key) in which case the
   * seed budget is used. The seed is deliberately *not* re-read from the mandate on every call: a
   * mandate whose budget was edited mid-campaign would otherwise silently re-authorise spend that
   * the ledger had already accounted for.
   */
  #transform<R>(op: (state: BudgetState) => Applied<R>): Transform<BudgetState, R> {
    const seed = this.#seed;
    const ttlMs = this.#ttlMs;
    return (prior: BudgetState | undefined): ApplyOutcome<BudgetState, R> => {
      const { state, result } = op(prior ?? seed);
      return { state, result, ttlMs, persist: true };
    };
  }

  reserve(req: ReserveRequest): Promise<ReserveResult> {
    return this.#store.apply(
      this.#key,
      this.#transform((s) => reserve(s, req)),
    );
  }

  settle(id: string, actualPaise: number, now: number): Promise<SettleResult> {
    return this.#store.apply(
      this.#key,
      this.#transform((s) => settle(s, id, actualPaise, now)),
    );
  }

  release(id: string, now: number): Promise<ReleaseResult> {
    return this.#store.apply(
      this.#key,
      this.#transform((s) => release(s, id, now)),
    );
  }

  /**
   * Read the ledger without changing it.
   *
   * Expiry is applied to the *returned* value but not persisted, so a read can never be the thing
   * that alters the books. The next mutating call sweeps for real.
   */
  async snapshot(now: number): Promise<BudgetSnapshot> {
    const seed = this.#seed;
    const ttlMs = this.#ttlMs;
    const transform: Transform<BudgetState, BudgetState> = (prior) => {
      const state = prior ?? seed;
      return { state, result: sweepExpired(state, now), ttlMs, persist: false };
    };
    const state = await this.#store.apply(this.#key, transform);
    return {
      budgetPaise: state.budgetPaise,
      settledPaise: state.settledPaise,
      committedPaise: state.committedPaise,
      availablePaise: availablePaise(state),
      overrunPaise: state.overrunPaise,
      inFlight: inFlight(state),
      settledCount: state.settledCount,
      expiredCount: state.expiredCount,
      orphanCount: state.orphanCount,
    };
  }
}

/** A flattened, serialisable view of the ledger, for the console and the scorecard. */
export interface BudgetSnapshot {
  readonly budgetPaise: number;
  readonly settledPaise: number;
  readonly committedPaise: number;
  readonly availablePaise: number;
  readonly overrunPaise: number;
  readonly inFlight: number;
  readonly settledCount: number;
  readonly expiredCount: number;
  readonly orphanCount: number;
}
