# 2. Two steering levers, because Checkout cannot see a UPI issuer

- **Status** — accepted
- **Date** — 2026-08-25
- **Resolves** — open question 6 in [ARCHITECTURE.md §18](../ARCHITECTURE.md), which reserved the
  steering vocabulary until Razorpay Checkout's real capability had been verified

## Context

The prevention arm was specified as suppression: detect a rail degrading, remove it from the
checkout, steer customers onto something that works. That description assumes Checkout can be told
to remove *this* rail — and whether it can turns out to depend entirely on which rail.

`config.display` addresses **instruments**: things a customer picks from a list. It offers `blocks`
of named instruments, a `sequence` controlling their order, `preferences.show_default_blocks`, and a
`hide` array. `hide` reaches instrument level and not merely method level — `{ method: "netbanking",
banks: ["HDFC"] }` is documented and works. Instruments carry `banks` for netbanking, `issuers` and
`networks` for cards, `wallets`, `providers`, and `apps` plus `flows` for UPI.

So a slice is actionable exactly to the extent that it corresponds to something visible at the moment
of choosing. Against Kairos's `(method, issuer, instrument)` slices:

| Slice | Checkout can name it? |
|---|---|
| `netbanking/hdfc` | **Precisely.** `{ method: "netbanking", banks: ["HDFC"] }` |
| `card/hdfc/visa` | **Precisely.** `{ method: "card", issuers: ["HDFC"], networks: ["Visa"] }` |
| `wallet/paytm` | **Precisely.** `{ method: "wallet", wallets: ["paytm"] }` |
| `upi/*/phonepe` | **Partially.** `apps` reaches the intent flow; the same app through a collect request is untouched |
| `upi/hdfc` | **Not at all.** |

The last row is the one that matters. **A UPI payment's issuer is the customer's own bank, sitting
behind a VPA nobody has typed yet.** When HDFC's UPI handle degrades, Checkout has no way to know
which of the people looking at the payment page bank with HDFC. There is no instrument to hide, and
hiding UPI outright would punish the ninety per cent whose bank is fine.

Around seventy per cent of the modelled Indian traffic sits on UPI slices shaped exactly like this.
Suppression therefore cannot be the primary lever of the prevention arm; it is available for a
minority of volume.

## Decision

Two levers, chosen by addressability rather than by preference.

**Suppress** — `display.hide`, for slices Checkout can name precisely. Immediate and surgical: only
that instrument's traffic is displaced, and nobody else's checkout changes.

**Demote** — `display.sequence` with `show_default_blocks` off, for everything else. The failing
method moves to the back of the list. Nothing is removed, so nobody is stranded and the method floor
cannot be breached; the effect is bounded by how many people take the top option rather than hunting
for their usual one.

The sequence is exhaustive whenever the default list is switched off, because anything omitted
disappears from the checkout — a reorder that silently removes methods is the failure the method
floor exists to prevent.

Every steer is priced before it is made, in one number: the expected change in failure probability
across all traffic. Suppression is charged an **abandonment** cost, because taking away the button
someone came to press does not reliably move them to another button, and a customer who leaves is a
total loss where a failed payment is at least retryable. Demotion is charged a **collateral** cost,
because most of the people it moves were never in trouble.

## What this costs, measured

Both costs are real and both are in [MEASUREMENT.md](../MEASUREMENT.md). The break-even failure rate
at which a steer becomes worth making falls straight out of the traffic mix:

| Slice | Lever | Break-even |
|---|---|---:|
| `card/hdfc/visa` | suppress | 13.5% |
| `netbanking/hdfc` | suppress | 15.0% |
| `wallet/paytm` | suppress | 16.0% |
| `upi` (whole method) | demote | 11.5% |
| `upi/hdfc` | demote | **26.5%** |
| `upi/sbi` | demote | **33.0%** |
| `upi/hdfc/phonepe` | demote | 46.5% |
| `upi/canara/paytm` | demote | **never** |

A precisely-addressable rail is worth acting on from around 14%. A UPI *issuer* has to be more than
twice as bad before demoting the whole method pays for the healthy users it drags along — and a UPI
slice carrying 0.4% of volume is never worth demoting a quarter of the checkout's traffic for, at any
severity.

That last row lands on the same conclusion Phase 1 reached from the other direction. The thin slice
the detector cannot see is also the slice the steerer would refuse to act on if it could. For those,
the recovery arm is not a fallback — it is the only answer.

## Consequences

**The prevention arm is weaker on UPI than the original design implied, and honestly so.** For most
Indian volume the only available lever is a nudge whose effect depends on how willing customers are
to switch, and that willingness is a fact about human beings that no simulator can supply. It is held
as a named assumption, swept in the harness, and reported across its range.

**Steering will often correctly decline.** A moderate UPI issuer outage produces no steer at all,
because UPI fails around 2% and cards around 12%, so there is nowhere better to send anyone. A system
that steered anyway would be causing the loss it exists to prevent.

**The renderer must fail loudly.** Razorpay names institutions by IFSC code — Axis is `UTIB`, State
Bank is `SBIN` — so an unknown code produces a `hide` entry matching nothing. The customer sees an
unchanged page, the ledger records a steer, and the analysis counts them as treated, so the measured
lift drifts toward zero with nothing reporting a fault. The renderer returns a diagnostic instead of
guessing.

**Not verified against a live checkout.** Everything here comes from Razorpay's published
documentation and is exercised against a schema in tests, not against a rendered page. The behaviour
of `show_default_blocks: false` with a bare-method sequence is the specific thing most worth
confirming before this is trusted in production.
