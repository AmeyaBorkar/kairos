# 1. Commitment accounting over ThrottleKit's store, not its token budget

- **Status** — accepted
- **Date** — 2026-08-25
- **Supersedes** — the mapping table in [ARCHITECTURE.md §8](../ARCHITECTURE.md), which named
  `distributedTokenBudget` as the campaign-budget mechanism

## Context

The architecture doc committed Terminus to enforcing the campaign budget with ThrottleKit's
`distributedTokenBudget`, denominated in paise, on the strength of its overshoot bound: *overshoot ≤
one debit, independent of the number of workers.* That bound is real and it is proven. It does not
apply to this problem.

Implementing against the published API surfaced two mismatches, one shallow and one structural.

**The shallow one: it is a windowed meter.** `distributedTokenBudget` enforces `L` tokens per window,
and the windows are epoch-aligned — `floor(now / windowMs) * windowMs`. A campaign budget is not a
rate. It is a lifetime ceiling running from `validFrom` to `validUntil`, and those boundaries have no
reason to align to an epoch multiple. Setting `windowMs` to the campaign duration would put a reset
somewhere in the middle of most campaigns, handing the merchant a second budget they never granted.

**The structural one: there is no held reservation.** The token budget is a *post-hoc meter*. You
debit what was actually produced, as it is produced. That is exactly right for the problem it was
built for — an LLM gateway debits one token at a time while the completion streams, so the check and
the spend are continuous and there is no interval for a second worker to slip into. The
fleet-size-independence follows from that continuity.

Kairos's costs do not arrive continuously. An SMS costs one segment or three, and which one is
settled the moment the provider accepts it — a single atomic revelation at the end of the action, not
a stream of increments. Between deciding to send and learning the price there is a real interval
during which nothing has been debited. Under a post-hoc meter, every worker that checks `remaining()`
during that interval sees a budget nobody has touched, and they all proceed. That is precisely the
race Terminus exists to prevent, and the token budget does not prevent it, because it was never
trying to: its own documentation is explicit that the reservation "only governs the false-reject ⇆
abort trade-off" and that safety comes from the meter's continuous debiting.

Reaching for the mechanism because its guarantee *sounds* like the one we need, without checking that
its preconditions hold, is the exact failure this project's design principles are written against.

## Decision

Terminus implements commitment accounting itself, over ThrottleKit's `Store`.

`Store` exposes a single mutating primitive — an atomic read-modify-write against one key, proven
bit-identical across the in-memory, Redis and Postgres backends. That is the hard part, and it is the
part worth taking. Everything above it is a pure function of the prior state, so the whole
reserve-check-commit sequence collapses into one indivisible step regardless of which backend is
underneath, and the same code is correct in a unit test and in a fleet.

What is actually used from ThrottleKit, and what is not:

| Concern | Mechanism | Why |
|---|---|---|
| Campaign ₹ budget | `Store.apply` with a pure ledger transform | Atomic reserve → settle, with authority *held* across the interval where the cost is unknown |
| Per-customer contact cap | `quota`, rolling window | A direct fit. Rolling rather than calendar, and a denied request never consumes |
| Reservation sizing | `learnedReservation`, `predictiveReservation` | Measured against reserving the worst case; see the verdict below |
| ~~Campaign ₹ budget~~ | ~~`distributedTokenBudget`~~ | Windowed, and post-hoc — no reservation is held across the interval that matters |
| ~~Global action rate~~ | ~~`twoTier`~~ | Deferred. The in-flight cap covers blast radius; a fleet-wide *rate* limit belongs with the Razorpay adapter in Phase 4 |
| ~~Razorpay API pressure~~ | ~~`adaptiveConcurrency`~~ | Deferred to the adapter that actually makes the calls |
| ~~Multi-campaign sharing~~ | ~~`weightedFairEscrow`~~ | Deferred. One mandate per campaign is the current model; nothing shares a budget yet |

## The bound this buys

Three quantities partition the budget at all times: `available = budget − settled − committed`. A
reservation is admitted only when it fits `available`, so `settled + committed ≤ budget` holds after
every reserve.

Because costs are revealed after commitment, an action can settle above its reservation. An overrun
*before* the budget is exhausted is harmless — it reduces `available`, so the ledger admits fewer
actions afterwards and the breach self-corrects out of future capacity. Only overruns on reservations
that are live at the instant `available` reaches zero can push `settled` past `budget`, and at most
`maxInFlight` reservations are live at any instant. So:

```text
  final settled  ≤  budget  +  maxInFlight × (maxActionCost − reservation)
```

Both terms are mandate fields. Neither is the worker count, which is the property the original
mechanism was chosen for and which this one keeps. Reserving the worst case drives the residual to
exactly zero.

## Consequences

**We own more code.** The ledger is roughly 250 lines of pure functions rather than a library call.
It is fully tested and it runs inside somebody else's proven atomic primitive, but it is ours to be
wrong in, and a subtle error in it is a money error.

**The bound is stated by us, so it has to be measured by us.** [MEASUREMENT.md](../MEASUREMENT.md)
reports the observed overspend against the stated bound across a fleet-size sweep, and the harness
asserts the inequality rather than asserting the reasoning.

**`learnedReservation` did not earn its place, and is not the default.** Measured against reserving
the worst case on the same workload, it buys between 0% and 6.3% more messages and gives up the only
bound that is exactly zero. For a kernel whose entire claim is a provable ceiling that is a poor
trade. It stays behind the `Sizer` interface — cutting the code would make the measurement
unreproducible — but the kernel defaults to `worstCaseSizer`. This resolves open question 2 in §18.

**The ARCHITECTURE.md table is wrong until corrected**, which is the reason this record exists. The
design was reasonable when written; it was wrong for a reason that only implementation could show.
