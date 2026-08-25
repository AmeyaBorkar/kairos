/**
 * Commitment accounting for a campaign budget.
 *
 * The state in this file is a pure value and every operation on it is a pure function, so the whole
 * thing runs inside one atomic store apply. That is the entire trick: the check and the commitment
 * are a single indivisible step, so no number of concurrent workers can interleave between them.
 *
 * ## The bound
 *
 * Three quantities partition the budget at all times:
 *
 * ```text
 *   available  =  budget - settled - committed
 * ```
 *
 * `settled` is money that has actually been spent. `committed` is money reserved for actions that
 * are in flight — decided, not yet priced. A reservation is admitted only when it fits `available`,
 * so `settled + committed <= budget` holds after every reserve.
 *
 * Costs are revealed after commitment, so an action can settle above its reservation. An overrun
 * *before* the budget is exhausted is harmless: it reduces `available`, and the ledger simply
 * admits fewer actions afterwards — the breach self-corrects out of future capacity. Only overruns
 * on reservations that are live at the moment `available` reaches zero can push `settled` past
 * `budget`, and at most `maxInFlight` reservations are live at any instant. So:
 *
 * ```text
 *   final settled  <=  budget  +  maxInFlight x (maxActionCost - reservation)
 * ```
 *
 * Both terms are mandate fields. Neither is the worker count — that is the point. A naive
 * check-then-spend overshoots by `workers x maxActionCost`, which grows every time the deployment
 * scales; this bound does not move when you add machines. Reserving the worst case
 * (`reservation = maxActionCost`) drives it to exactly zero, at the cost of utilisation, and the
 * trade-off between those two is a dial rather than a rewrite.
 */

/** A reservation that has been granted and not yet reconciled. */
export interface LiveReservation {
  readonly amountPaise: number;
  readonly grantedAt: number;
  readonly expiresAt: number;
}

/**
 * The ledger for one mandate.
 *
 * The live-reservation table lives inside the atomically-applied state, which is only affordable
 * because it is bounded: at most `maxInFlight` entries, a mandate-level constant. An unbounded map
 * here would be a liability in a shared store; a bounded one is just a small record.
 */
export interface BudgetState {
  readonly budgetPaise: number;
  /** Money actually spent, reconciled against real costs. */
  readonly settledPaise: number;
  /** Money held against actions in flight. */
  readonly committedPaise: number;
  /** Cumulative amount by which actuals exceeded their reservations. Diagnostic, not a bound. */
  readonly overrunPaise: number;
  /** Reservations that lapsed before reconciliation — a signal the TTL is too short. */
  readonly expiredCount: number;
  /**
   * Settlements arriving for a reservation that had already lapsed.
   *
   * These are the dangerous ones: the money left the building while its authority had returned to
   * the pool, so the spend was never bounded by anything. Counted separately and loudly, because a
   * non-zero value here means the reservation TTL is shorter than the action it is covering.
   */
  readonly orphanCount: number;
  readonly settledCount: number;
  readonly live: Readonly<Record<string, LiveReservation>>;
}

export function emptyBudget(budgetPaise: number): BudgetState {
  return {
    budgetPaise,
    settledPaise: 0,
    committedPaise: 0,
    overrunPaise: 0,
    expiredCount: 0,
    orphanCount: 0,
    settledCount: 0,
    live: {},
  };
}

/** Authority still free to grant: the budget less what is spent and what is held. */
export function availablePaise(state: BudgetState): number {
  return state.budgetPaise - state.settledPaise - state.committedPaise;
}

export function inFlight(state: BudgetState): number {
  return Object.keys(state.live).length;
}

/**
 * Return the authority held by reservations that have lapsed.
 *
 * Run at the head of every operation rather than on a timer, so the ledger is self-healing without
 * a background process: a worker that dies mid-action leaks nothing beyond the TTL, and the next
 * caller of any operation is the one who cleans up after it.
 */
export function sweepExpired(state: BudgetState, now: number): BudgetState {
  let released = 0;
  let expired = 0;
  let next: Record<string, LiveReservation> | null = null;

  for (const [id, reservation] of Object.entries(state.live)) {
    if (reservation.expiresAt > now) continue;
    next ??= { ...state.live };
    delete next[id];
    released += reservation.amountPaise;
    expired++;
  }

  if (next === null) return state;
  return {
    ...state,
    committedPaise: state.committedPaise - released,
    expiredCount: state.expiredCount + expired,
    live: next,
  };
}

export interface ReserveRequest {
  readonly id: string;
  readonly amountPaise: number;
  readonly maxInFlight: number;
  readonly ttlMs: number;
  readonly now: number;
}

export type ReserveResult =
  | {
      readonly ok: true;
      /** True when this call found an existing live reservation rather than creating one. */
      readonly replayed: boolean;
      readonly reservedPaise: number;
      readonly expiresAt: number;
      readonly availablePaise: number;
      readonly inFlight: number;
    }
  | {
      readonly ok: false;
      readonly axis: "budget" | "concurrency";
      readonly availablePaise: number;
      readonly inFlight: number;
    };

export interface Applied<R> {
  readonly state: BudgetState;
  readonly result: R;
}

/**
 * Take authority for one action.
 *
 * Idempotent on `id`: presenting an id that is already live returns the existing reservation
 * untouched instead of granting a second one. Because ids are derived deterministically from
 * `(casualty, action kind, attempt number)`, a worker that crashes after reserving and retries gets
 * its own reservation back rather than double-committing the budget — crash safety falls out of the
 * key derivation rather than needing a separate protocol.
 */
export function reserve(state: BudgetState, req: ReserveRequest): Applied<ReserveResult> {
  const swept = sweepExpired(state, req.now);

  const existing = swept.live[req.id];
  if (existing !== undefined) {
    return {
      state: swept,
      result: {
        ok: true,
        replayed: true,
        reservedPaise: existing.amountPaise,
        expiresAt: existing.expiresAt,
        availablePaise: availablePaise(swept),
        inFlight: inFlight(swept),
      },
    };
  }

  const free = availablePaise(swept);
  const held = inFlight(swept);

  // Concurrency before budget: both are refusals, but the concurrency one is the cheaper signal to
  // act on — it clears as soon as an action reconciles, whereas an exhausted budget does not clear
  // at all. Reporting the wrong one would send a caller into a retry loop that can never succeed.
  if (held >= req.maxInFlight) {
    return {
      state: swept,
      result: { ok: false, axis: "concurrency", availablePaise: free, inFlight: held },
    };
  }
  if (req.amountPaise > free) {
    return {
      state: swept,
      result: { ok: false, axis: "budget", availablePaise: free, inFlight: held },
    };
  }

  const expiresAt = req.now + req.ttlMs;
  const next: BudgetState = {
    ...swept,
    committedPaise: swept.committedPaise + req.amountPaise,
    live: {
      ...swept.live,
      [req.id]: { amountPaise: req.amountPaise, grantedAt: req.now, expiresAt },
    },
  };

  return {
    state: next,
    result: {
      ok: true,
      replayed: false,
      reservedPaise: req.amountPaise,
      expiresAt,
      availablePaise: availablePaise(next),
      inFlight: inFlight(next),
    },
  };
}

export interface SettleResult {
  /** False when the reservation had already lapsed — an {@link BudgetState.orphanCount} case. */
  readonly known: boolean;
  readonly reservedPaise: number;
  readonly actualPaise: number;
  readonly overrunPaise: number;
  readonly settledPaise: number;
  readonly availablePaise: number;
}

/**
 * Reconcile a reservation against what the action actually cost.
 *
 * An unknown or lapsed id still books the spend. The money is gone whether or not the ledger was
 * expecting it, and a ledger that quietly discards a real cost is worse than one that records an
 * embarrassing number — the bound would still be breached, it would just no longer be visible.
 */
export function settle(
  state: BudgetState,
  id: string,
  actualPaise: number,
  now: number,
): Applied<SettleResult> {
  const swept = sweepExpired(state, now);
  const held = swept.live[id];

  const reserved = held?.amountPaise ?? 0;
  const overrun = Math.max(0, actualPaise - reserved);

  const live = { ...swept.live };
  delete live[id];

  const next: BudgetState = {
    ...swept,
    settledPaise: swept.settledPaise + actualPaise,
    committedPaise: swept.committedPaise - reserved,
    overrunPaise: swept.overrunPaise + overrun,
    orphanCount: swept.orphanCount + (held === undefined ? 1 : 0),
    settledCount: swept.settledCount + 1,
    live,
  };

  return {
    state: next,
    result: {
      known: held !== undefined,
      reservedPaise: reserved,
      actualPaise,
      overrunPaise: overrun,
      settledPaise: next.settledPaise,
      availablePaise: availablePaise(next),
    },
  };
}

export interface ReleaseResult {
  readonly released: boolean;
  readonly releasedPaise: number;
  readonly availablePaise: number;
}

/**
 * Hand authority back without spending it — the action was refused downstream, or never ran.
 *
 * Distinct from settling zero: a release leaves no trace in the spend counters, because nothing was
 * spent. Settling zero would record an action that cost nothing, which is a different and untrue
 * statement about the world.
 */
export function release(state: BudgetState, id: string, now: number): Applied<ReleaseResult> {
  const swept = sweepExpired(state, now);
  const held = swept.live[id];
  if (held === undefined) {
    return {
      state: swept,
      result: { released: false, releasedPaise: 0, availablePaise: availablePaise(swept) },
    };
  }

  const live = { ...swept.live };
  delete live[id];
  const next: BudgetState = {
    ...swept,
    committedPaise: swept.committedPaise - held.amountPaise,
    live,
  };

  return {
    state: next,
    result: {
      released: true,
      releasedPaise: held.amountPaise,
      availablePaise: availablePaise(next),
    },
  };
}

/**
 * The worst-case overspend this configuration permits, in paise.
 *
 * Stated as a function rather than prose so it can be asserted in a test and printed in the
 * console. If the reservation covers the worst-case action cost the answer is zero; otherwise it is
 * the residual risk the operator is choosing to run in exchange for utilisation.
 */
export function overspendBoundPaise(
  maxInFlight: number,
  maxActionCostPaise: number,
  reservationPaise: number,
): number {
  return maxInFlight * Math.max(0, maxActionCostPaise - reservationPaise);
}
