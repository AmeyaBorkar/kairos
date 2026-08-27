# 4. A retry is only free when the customer is not needed

- **Status** — accepted
- **Date** — 2026-08-25
- **Constrains** — the recovery arm in [ARCHITECTURE.md §7](../ARCHITECTURE.md), whose scheduling
  section reads *"`transient` → subscribe to slice health; fire on the recovery edge"* without
  saying what fires

## Context

The premise of the casualty arm is that Kairos owns the detector, so it knows the moment a rail
comes back and can retry exactly then rather than at `+1h`. That premise is sound and it is the best
idea in the product. It also quietly assumes there is something to retry.

On Indian rails there usually is not. A UPI payment needs a PIN entered in the customer's own app. A
card payment needs an OTP. Netbanking needs a login. None of those can be replayed by a server: the
customer has to be there. What *can* be charged again without anybody present is a payment against
standing consent — a tokenised card, a UPI Autopay mandate, an e-mandate — and that is a minority of
a typical merchant's volume.

So "retry when the rail heals" splits into two very different operations:

- **On a mandated payment** it is a server-to-server call. It costs approximately nothing, disturbs
  nobody, needs no consent, and can happen at three in the morning the instant the issuer recovers.
- **On a one-off payment** it is a request that the customer come back. That means a message. A
  message costs money, burns a per-customer contact allowance, cannot be sent during quiet hours,
  and carries a real chance of losing the customer's consent to ever be contacted again.

Calling both of them "retry" hides the entire difference.

## Decision

Carry the capability on the casualty, separately from the failure class, as `RetryCapability`:
`autonomous` or `requires-customer`.

The two answer different questions and must not be conflated:

- The **class** says whether the *failure* could come out differently. It is a fact about the error.
- The **capability** says whether Kairos can find out without asking. It is a fact about the
  payment.

A `transient` failure on a one-off UPI payment is retryable and not retryable at the same time, and
only carrying both fields lets the system say so.

Three consequences follow directly, and each is enforced rather than documented:

1. **Action selection.** Where a payment can be charged again silently, that is the whole decision —
   nobody is messaged about a payment the system can simply re-run. Where it cannot, the retry
   action is not merely more expensive, it is unavailable, and the only lever left is a message.
2. **Scheduling.** Quiet hours apply to the second case and not the first. Deferring a silent
   token charge until 08:00 costs the merchant the recovery edge for the sake of a customer who is
   asleep and unaffected either way.
3. **The executor cannot substitute.** A grant authorising a retry, handed to an executor with no
   token, reports the action as undeliverable rather than quietly sending a message instead.
   Substituting would spend a contact allowance the grant did not authorise.

There is deliberately no way to express "retry a payment with no token" in the gateway port. The
field is required, and that is the API telling the truth about the operation.

## What it costs, measured

In the recovery benchmark, against a merchant mix with 14% of payments carrying a token or mandate:

| | |
|---|---:|
| Casualties whose rail was `transient` — the class the whole recovery-edge idea is for | **48%** |
| Casualties that can be charged again without the customer | **12%** |
| Retries actually made across 5,556 casualties | **251** |
| Messages sent | **5,730** |

The arm is overwhelmingly made of messages. The recovery edge still matters for those — a message
sent while a rail is still broken reaches a customer who responds and fails — but it matters as
*timing for a message*, not as a free re-run.

## Consequences

**The best idea in the product applies to a minority of its volume, and the honest framing says so.**
A pitch that claims Kairos retries on the recovery edge is describing 12% of what it does. A pitch
that claims it *times* every recovery action against the rail's health is describing all of it, and
is true.

**The number is a property of the merchant, not of Kairos.** A subscription business is mostly
mandated payments and gets an arm that is nearly free to run. A one-off e-commerce merchant gets an
arm made of messages, governed by a contact cap. The same code serves both and the economics differ
completely, which is why the mandated share is a simulator parameter rather than a constant.

**Nothing here has been exercised against a live token charge.** Razorpay's recurring-payment APIs
need an account with mandates registered on it, which this repository does not have. The port is
declared, the executor is wired, and the worker ships in dry-run delivery by default — see
[§11](../ARCHITECTURE.md).
