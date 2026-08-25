# 3. A sixth recoverability class, for the customer who must simply try again

- **Status** — accepted
- **Date** — 2026-08-25
- **Amends** — the classification table in [ARCHITECTURE.md §7](../ARCHITECTURE.md), which
  anticipated this: *"the exact enum values are built from Razorpay's live error-code documentation
  at implementation time rather than assumed here; the table above is the shape, not the contents."*

## Context

The design named five recoverability classes: `transient`, `timed`, `customer-action`, `dead`, and
`unknown`. Building the rule table against Razorpay's real taxonomy showed that the largest single
bucket of ordinary failure does not fit any of them.

A customer who cancels a UPI collect request, abandons a bank page, mistypes a PIN or fumbles an OTP
has not encountered a broken rail, an empty account, or an expired instrument. Nothing is wrong.
They started paying and stopped. Weighted by how much failure each rail actually produces in the
modelled Indian mix, they are **31% of all failures on a healthy rail** — more than any other class,
and more than transient and customer-action combined.

Every existing class describes them wrongly, and each wrongly in a way that costs money:

| Class | What it would do | Why that is wrong |
|---|---|---|
| `transient` | Wait for the rail, then retry | Nothing broke. There is no recovery edge to wait for. |
| `timed` | Retry at a balance-likely moment | They have the money. They chose not to spend it. |
| `customer-action` | Send a fix-link, up to three times | There is nothing to fix. Three reminders to somebody who changed their mind is harassment. |
| `dead` | Never chase | Contradicts treating an abandoned checkout as a casualty at all — the same person, doing the same thing, arriving through a different door. |
| `unknown` | One cheap contact, then stop | **The right treatment.** For the wrong reason. |

That last row is the tempting one, and taking it would have been a mistake for a reason that only
becomes visible once the probability model exists. `unknown` and this population would share a
calibration cell, pooling a customer who nearly paid — and who returns unaided **46%** of the time —
with a residual nobody could classify. The gate consumes that probability directly, so pooling them
makes the system chase the residual too hard and the near-miss not hard enough, in the same number.

## Decision

Add `customer-retry`: nothing is broken and nothing needs fixing, and the customer simply has to try
again.

It pairs with `customer-action`, and the pairing is the point. Both need the customer to be present.
They differ in whether the customer has anything to **change** first, and that difference sets the
ladder:

- `customer-action` — fetch a new card, correct a VPA, re-authorise a mandate. A person doing an
  errand can reasonably be reminded more than once, so it gets a bounded ladder of three.
- `customer-retry` — nothing to do but pay. Asked **exactly once**, then left alone.

The class also absorbs the `checkout-abandoned` casualty kind, which is the same human behaviour
reached by a different route and deserves the same treatment.

## What it changes, measured

The class is 31% of failures on a healthy rail and 21% of all casualties in the recovery benchmark.
Two numbers from the harness explain why its ladder is one rung:

- **46% of them come back with no prompting at all**, the highest of any class, and the fastest —
  a median of about twenty-five minutes, because a customer who cancelled ninety seconds ago is
  standing at a checkout.
- **Nearly nine in ten of the recoveries a message appears to produce on this class were already on
  their way.** A system that reported gross recoveries here would be reporting the customer's own
  behaviour and billing for it.

Both facts point at the same conclusion, and it is the one the schedule acts on: for this class the
right first move is to wait. See the spontaneous-window sweep in
[MEASUREMENT.md](../MEASUREMENT.md), where waiting two hours rather than none sends 11% fewer
messages, wastes 50% fewer of them, and recovers *more*.

## Consequences

**The enum is closed and now has six members**, which is the enum a model's output is validated
into. Widening it widens what a successful prompt injection can select, and that was weighed: the
new member's ladder is the shortest of any non-`dead` class, so the widening moves the worst case
*down*, not up.

**`dead` is still doing two jobs.** It means "stop", and it covers both a stolen card and a
transaction the bank will never approve. Those are different stories with the same action, and a
console showing `dead` cannot tell a merchant which. The rule id is recorded alongside the class for
exactly this reason, and it is the rule id — `card-lost-or-stolen`, `international-not-allowed` —
that a human should be shown.

**The taxonomy is about what we can do, not about what went wrong.** That is worth stating because
it is the principle that decides where the next unmapped error goes. A new Razorpay code belongs in
the class whose *treatment* is right for it, and the rule id carries the cause.
