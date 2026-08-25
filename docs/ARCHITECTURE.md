# Kairos — Architecture

> Payment-health defence for Indian merchants. Detect a rail degrading within minutes, steer live
> traffic off it under provable bounds, recover the casualties root-cause-aware, and prove the rupee
> impact against a control group. Every money action clears **Terminus**, a governance kernel whose
> limits are arithmetic guarantees rather than policy checks.

**Status:** design, v1 · **Track:** Razorpay AI Buildathon 03 — AI Revenue Recovery

---

## Table of contents

1. [Thesis and scope](#1-thesis-and-scope)
2. [Design principles](#2-design-principles)
3. [The loop](#3-the-loop)
4. [Module decomposition](#4-module-decomposition)
5. [Detection](#5-detection)
6. [Steering — the prevention arm](#6-steering--the-prevention-arm)
7. [Recovery — the casualty arm](#7-recovery--the-casualty-arm)
8. [Terminus — the governance kernel](#8-terminus--the-governance-kernel)
9. [The audit ledger](#9-the-audit-ledger)
10. [Data model](#10-data-model)
11. [Razorpay surface and the simulation boundary](#11-razorpay-surface-and-the-simulation-boundary)
12. [Failure modes](#12-failure-modes)
13. [Security](#13-security)
14. [Measurement](#14-measurement)
15. [Stack and repository layout](#15-stack-and-repository-layout)
16. [CI/CD](#16-cicd)
17. [Build sequence](#17-build-sequence)
18. [Open questions](#18-open-questions)

---

## 1. Thesis and scope

### The problem

A bank's payment rail starts degrading at 14:14 — not down, just failing about a third of the time.
Customers of that bank tap Pay, wait, get an error, and leave. Most never return. At almost every
merchant, nothing happens for the next forty minutes: someone eventually notices soft numbers, asks
in a group chat, investigates, and maybe disables something. Three quarters of an hour of sales on
that rail are gone, and they never appear in any report *as* a loss.

Razorpay ships a [Downtime API](https://razorpay.com/docs/api/payments/downtime/) and
`payment.downtime.*` webhooks, and their own guidance is to "display only the unaffected payment
methods." That is the correct remediation — and it is left as an exercise. Centrally-declared
downtime also lags structurally: it must aggregate across merchants and clear a confidence threshold
before firing, and it is declared coarsely, never for one merchant's specific slice of customers.

### What Kairos does

Two arms over one kernel.

**Prevention** — detect the degradation from the merchant's own outcome stream, suppress or demote
the failing method at checkout, hold a control group, auto-revert on recovery.

**Recovery** — take the payments already lost, classify them by *why* they failed, and run a bounded
recovery workflow: retry the moment the rail heals, send a fix-link where customer action is
required, and stop entirely where the failure is unrecoverable.

Prevention is worth several times recovery — a sale never lost returns ~100% of its value instantly,
where chasing one recovers perhaps 15–30% days later after paying for messaging. But recovery is
where Track 03's bar lives ("measured money recovered across a batch, with compliant escalation,
stopping rules, and an audit trail"), and the two arms share a kernel, a ledger, and a budget. So we
build both, and let the budget allocate between them by expected value.

### In scope

- Degradation detection across method × issuer × network/app slices
- Checkout method steering with mandatory holdout
- Recovery of failed payments and overdue receivables
- Bounded spend, contact caps, stopping rules, tamper-evident audit
- A measurement harness producing a reproducible scorecard

### Explicitly out of scope

- Acquirer-level routing (Razorpay Optimizer's job, not a merchant integration's)
- Fraud and chargeback handling (Track 02 territory)
- Anything that writes to a live merchant's production traffic without a holdout

---

## 2. Design principles

These are load-bearing. Where a later section makes a non-obvious choice, it is usually one of these
being applied.

**P1 · The model proposes, the kernel disposes.**
No LLM output ever directly executes a money action. Model output is parsed into a constrained
schema, validated deterministically, and then submitted to Terminus as a *proposal*. There is no
tool-call path from a language model to a rupee. This is what makes prompt injection a
copy-quality problem rather than a solvency problem.

**P2 · Fail toward the least action.**
Every degraded path resolves toward doing *less*, and "less" is direction-specific. For steering,
least action is default routing — so an error, a timeout, or an unavailable Kairos means the customer
sees the normal checkout. For spending, least action is not spending — so a store outage tightens the
bound rather than loosening it. One principle, two directions, no ambiguity at any call site.

**P3 · Bounds are arithmetic, not policy.**
A limit enforced by `if (spent + cost > budget)` is a race under concurrency. Terminus enforces
limits through atomic admission with a proven overshoot bound, so the guarantee survives multiple
workers, partitions, and crashes. See §8.

**P4 · Determinism and replay.**
Every decision is a pure function of `(state, inputs, now)`. Clocks are injected; no `Date.now()`
inside a decision function. This buys three things at once: millisecond-exact tests, the ability to
replay a recorded stream against a candidate policy before deploying it, and reproducible benchmarks.

**P5 · Measure or don't claim.**
No effect is reported without a control group behind it. The holdout is not a feature flag, it is a
structural requirement of every steering decision (§6), and the harness refuses to emit a lift number
without one.

**P6 · Ports and adapters.**
The core knows nothing about Razorpay, Redis, Postgres, or any model vendor. Every outside system
enters through an interface defined in `@kairos/ports`. This is what makes the simulator and the live
gateway interchangeable, and it is why the whole system is testable without a network.

**P7 · Money is integers.**
All amounts are integer **paise**, everywhere, in every type. No float ever touches a monetary value.
Razorpay's API is already paise-denominated; we never convert until display.

**P8 · No unaudited money movement.**
If the ledger cannot be written, outbound actions halt. An action we cannot account for is worse than
an action not taken.

---

## 3. The loop

```
                    ┌───────────────────────────────────────────────────────┐
                    │                                                       │
   payment          ▼                                                       │
   outcomes ──► ① DETECT ──► ② DIAGNOSE ──► ③ DECIDE ──┬─► ④ STEER ─────────┤
   (webhook /      CUSUM        LLM +          plan     │   checkout config  │
    simulator)     per slice    taxonomy                │                    │
                                                        └─► ⑤ RECOVER ───────┤
                                                            retry / contact  │
                                                                             │
                        every action in ④ and ⑤ passes ──► ⑥ TERMINUS ───────┘
                                                            reserve · admit
                                                            execute · reconcile
                                                                    │
                                                                    ▼
                                                            ⑦ LEDGER (hash-chained)
                                                                    │
                                                                    ▼
                                                            ⑧ HARNESS → scorecard
```

The feedback edge matters: the recovery arm subscribes to the detector. A payment that failed because
an issuer was down is retried *when that issuer recovers*, which the system already knows because it
is the thing that detected the outage. That is the whole `kairos`-over-`chronos` idea made concrete —
no other dunning system has the health signal in hand at retry time.

---

## 4. Module decomposition

Hexagonal. Three rings: a pure core, a set of ports, and adapters that satisfy them.

### Core — pure, no I/O, no clock reads

| Package | Responsibility |
|---|---|
| `@kairos/domain` | Value types and invariants: `Paise`, `Slice`, `Attempt`, `Outcome`, `Incident`, `Casualty`, `Action`, `Mandate`, `AuditRecord`. Branded types so `Paise` cannot be assigned from a bare number. |
| `@kairos/detect` | The change detector. `(DetectorState, Observation) → (DetectorState, Verdict)`. Baselines, CUSUM, hysteresis, hierarchical rollup. |
| `@kairos/policy` | Steering decisions. `(Incident[], Config, Customer) → SteeringPlan`. Holdout assignment. |
| `@kairos/recover` | Classification, expected-value gating, playbook selection, next-action scheduling. |
| `@kairos/terminus` | The governance kernel. Mandates, reservation/reconcile, stopping rules, admission. Wraps `throttlekit`. |
| `@kairos/ledger` | Hash-chained append and verification. |

The core has **zero runtime dependencies** other than `throttlekit` (in `terminus`) and `zod` for
schema definitions. Anything that needs a network lives outside it.

### Ports — interfaces only

```ts
interface EventSource   { subscribe(h: (a: Attempt) => void): Unsubscribe }
interface Gateway       { createOrder · createPaymentLink · capture · refund · fetchDowntimes }
interface Messenger     { send(msg: Message): Promise<SendResult>   // SendResult carries ACTUAL cost
interface Reasoner      { diagnose(ctx): Promise<Diagnosis> · compose(ctx): Promise<Composition> }
interface Store         { apply(key, ttl, transform): Promise<ApplyOutcome>  // throttlekit's Store
interface LedgerSink    { append(r: AuditRecord): Promise<void> }
interface Clock         { now(): number }
```

`Messenger.send` returning the *actual* cost rather than accepting a quoted one is deliberate — see
§8 on why cost is only knowable after the fact.

### Adapters

`razorpay` · `simulator` · `reasoner-anthropic` · `store-postgres` · `store-redis` · `messenger-sms`
· `messenger-whatsapp` · `ledger-postgres`

Each adapter is independently swappable and independently tested against a shared conformance suite
per port. The simulator and the live Razorpay adapter satisfy the same `Gateway` interface, which is
what lets the entire system run offline in CI.

### Applications

| App | What it is |
|---|---|
| `sentry` | Ingests outcomes, runs detection, publishes the current steering plan. Stateless, horizontally scalable. |
| `recover-worker` | Drains the casualty queue. **Deliberately multi-instance** — this is where a naive budget check would race, and where Terminus earns its place. |
| `checkout` | Demo storefront on Razorpay Checkout whose method configuration is driven by `sentry`. |
| `console` | Operator view: live rail health, active incidents, which bound is binding, the audit trail. |
| `bench` | The measurement harness. Runs experiments on fixed seeds, emits the scorecard. |

---

## 5. Detection

The intellectual core, and the part most likely to be done badly by a naive implementation.

### The problem, stated honestly

Each slice — `(method × issuer × network|app)` — is a Bernoulli stream whose failure probability
drifts. There are thousands of slices with volumes spanning four orders of magnitude: a large private
bank's UPI handle might do 10,000 attempts a minute while a small regional bank does three.

We need to detect an *upward shift* in failure rate quickly, with a false-alarm rate we can state and
defend, across all slices simultaneously.

Naive thresholding ("alert if failure rate > 20% over 5 minutes") fails in both directions at once.
On low-volume slices it fires constantly on noise. On high-volume slices it is slow, because a fixed
window throws away the fact that evidence accumulated faster. And with thousands of slices, even a
tiny per-check false-alarm probability produces a steady drizzle of alarms — the multiplicity problem.

### Choice: sequential change detection

For each slice we test H₀ *"failure rate ≤ baseline p₀"* against H₁ *"failure rate ≥ p₀ + δ"* using
the Bernoulli log-likelihood ratio:

```
LLR(fail)    = log( p₁ / p₀ )
LLR(success) = log( (1 − p₁) / (1 − p₀) )
```

Page's CUSUM accumulates it with a floor at zero, which is what adapts it to an unknown changepoint:

```
S₀ = 0
Sₙ = max(0, Sₙ₋₁ + LLR(xₙ))        alarm when Sₙ ≥ h
```

Three properties earn this over the alternatives:

- **Anytime-valid.** The underlying likelihood-ratio process is a non-negative martingale under H₀,
  so Ville's inequality bounds the probability it *ever* crosses `1/α` at `α`. We are not choosing a
  sample size and we cannot p-hack by looking continuously — which is exactly the regime a streaming
  detector lives in. A fixed-window z-test has no such guarantee under continuous monitoring.
- **O(1) state per slice.** One float. At tens of thousands of slices this matters.
- **Optimal in the right sense.** Page's procedure minimises worst-case detection delay for a given
  false-alarm rate (Lorden). We are not going to beat it with heuristics.

Since δ is unknown, we run a small **mixture** over plausible shift sizes and take the max — a mixture
of martingales is still a martingale, so the guarantee survives.

`h` is calibrated by simulation against a target ARL₀ (average run length to false alarm) rather than
by a closed-form approximation, because the closed forms are asymptotic and our slices are not.

### Baselines

`p₀` is not a constant. Some banks are simply worse than others, and every rail has a daily and weekly
cycle.

- Per-slice EWMA over a trailing window, with hour-of-day and day-of-week adjustment.
- **Baselines freeze during an active incident.** Without this the incident poisons its own baseline
  and the detector silently normalises the outage — a subtle bug that would make the system quietly
  useless after a long degradation.
- Cold start and low volume use **empirical-Bayes shrinkage toward the parent** (slice → issuer →
  method). A slice doing three attempts a minute borrows strength from its method-level rate instead
  of either firing on noise or never accumulating evidence.

### Multiplicity

Two mechanisms, because they solve different halves.

- **Hierarchical rollup.** A broad issuer outage should surface as one issuer-level incident, not 400
  correlated slice alarms. Alarms propagate up the slice tree and are reported at the coarsest level
  that explains them.
- **e-BH across concurrent alarms.** The CUSUM statistic exponentiates to an e-value, and the e-value
  Benjamini–Hochberg procedure controls false discovery rate over a set of e-values without requiring
  independence — which we definitely do not have, since slices share issuers and gateways.

### Hysteresis

A Schmitt trigger: trip at `h_trip`, clear at `h_clear < h_trip`, with a minimum dwell time before
clearing and a minimum sustained-recovery window. Without this the system flaps at the boundary,
steering and un-steering every few seconds, which is worse than doing nothing.

### What we publish as evidence

**A detection-latency vs false-alarm-rate curve**, swept over thresholds on the simulator where the
true onset time is known. This is the honest form of "how good is your detector" and it is the
artifact that makes the rest of the claims credible.

---

## 6. Steering — the prevention arm

### The decision

Given active incidents, produce a `SteeringPlan`: for a given customer, an ordered list of payment
methods with suppressions applied. The checkout consumes it as configuration.

### Bounds — all enforced by Terminus, none by convention

| Bound | Default | Why |
|---|---|---|
| `maxSteeredFraction` | 0.90 | The remainder is the mandatory holdout. Without it there is no lift number. |
| `maxIncidentDurationMs` | 30 min | Steering auto-expires and must be re-affirmed by continuing evidence. A stale steer is a self-inflicted outage. |
| `minEvidence` | 2 corroborating windows | Never steer on a single alarm. |
| `methodFloor` | 2 | **Never leave a customer with fewer than two ways to pay.** A checkout with zero methods is a worse outage than the one we are responding to. |
| `maxConcurrentSteers` | configurable | Global blast radius across all incidents. |

`methodFloor` is the one I would defend hardest. Every other bound limits damage; this one prevents a
category of failure where the system's own remediation is the outage.

### Holdout

Assignment is **sticky per customer** — `hash(customerId, incidentId) < holdoutFraction` — so a given
person's experience stays consistent within an incident rather than flickering between arms on
refresh. Assignment is recorded in the ledger at decision time, before the outcome is known, which is
what stops the analysis from being retrofitted.

### The hot path is advisory

`checkout` calls `sentry` for a plan with a hard 50 ms timeout. Timeout, error, degraded mode, or
Kairos being entirely absent all resolve to the merchant's default method order. **Kairos can never
block or fail a checkout.** This is P2 in its steering direction, and it is the single most important
production property in the system — the failure mode of a payment-health tool must never be "no
payments".

---

## 7. Recovery — the casualty arm

### Intake

Failed payments arrive by `payment.failed` webhook, with a polling reconciliation sweep behind it to
catch anything the webhook dropped. Abandoned checkouts and overdue invoices enter the same queue as
different `CasualtyKind`s.

### Classification

Keyed on Razorpay's error taxonomy — `error_source`, `error_step`, `error_reason` — into
recoverability classes:

| Class | Example causes | Action |
|---|---|---|
| `transient` | issuer down, gateway timeout, network | Retry **when the rail heals** — we own the detector |
| `timed` | insufficient funds | Retry at a balance-likely moment (salary cycle, per-customer history) |
| `customer-action` | card expired, invalid VPA, mandate revoked | Retrying is pointless. Contact with a specific fix-link |
| `dead` | stolen/blocked card, international not permitted, fraud flag | **Stop.** Do not chase |
| `unknown` | anything unmapped | One low-cost contact, then stop |

**The rule table is deterministic.** Where the taxonomy is unambiguous, an LLM does not get a vote —
it classifies only the residual, and its output is constrained to the enum above and validated before
use. Money decisions ride on the deterministic path (P1).

The exact enum values are built from Razorpay's live error-code documentation at implementation time
rather than assumed here; the table above is the shape, not the contents.

### Expected-value gate

```
act  ⟺  p(recover) × amount × margin  >  E[cost of action]
```

`p(recover)` comes from a per-class calibrated model — a beta/logistic baseline is sufficient and
honest, and we publish its **calibration curve** (predicted vs actual) rather than only its accuracy.
A model that says 30% and is right 30% of the time is worth far more here than one with a better AUC
and no calibration, because the gate consumes the probability directly.

This gate is also where the false-positive cost becomes concrete: every action below the line that we
took anyway is measurable waste.

### Scheduling — the `kairos` part

Every dunning system retries on `chronos`: +1h, +24h, +72h, indifferent to the world. Kairos schedules
on the cause:

- `transient` → subscribe to slice health; fire on the recovery edge
- `timed` → salary-cycle prior plus per-customer historical success times
- `customer-action` → immediate contact, then a bounded ladder

Subject always to quiet hours, DND, and per-customer timezone.

### Stopping rules — hard, evaluated inside admission

Success · opt-out · dispute or chargeback opened · N consecutive hard declines · `dead` classification
· budget exhausted · mandate expired · global kill switch.

These are not a separate pre-check. They are evaluated *inside* Terminus admission so there is exactly
one gate and no path around it.

---

## 8. Terminus — the governance kernel

Named for the Roman god of boundary stones — the one god who refused to move for Jupiter, so the
temple was built around him, with a hole cut in the roof to keep the stone visible to the sky.
Unmovable and observable. That is the design brief.

### What makes this hard

Three properties, all present, which is why an `if` statement is not sufficient:

1. **Concurrent actors.** `recover-worker` is multi-instance by design. A check-then-act against a
   shared budget races: three workers read "₹40,000 remaining", three commit, and the campaign
   overspends. This is the same bug as three department heads drawing on one budget line before
   anything posts.
2. **Cost revealed after commitment.** You cannot price an action at admission time:
   - **LLM tokens** — known only as the completion streams.
   - **SMS segments** — GSM-7 gives 160 characters per segment; Devanagari forces UCS-2 at **70**. So
     `"aapka payment fail ho gaya"` is one segment and `"आपका पेमेंट फेल हो गया"` is three. *The
     model's choice of script sets the price, and you learn it after generation.*
   - **Gateway fees** on a retry, resolved when the attempt does.
3. **Utilisation matters.** Reserving the worst case for every action sterilises the budget, so the
   system stops chasing recoverable money it could afford. Safety that costs all your utilisation is
   not safety, it is a different failure.

### The pattern: reserve → execute → reconcile

```
  reserve(mandate, action)  ─►  estimate, take a lease against the shared budget
        │
        ├─ denied ─► record why (which axis bound), stop
        │
  execute(action)           ─►  the real cost becomes known
        │
  reconcile(reservation, actualCost) ─► settle the difference; release or overrun
```

This is commitment accounting, and it is exactly what `throttlekit`'s TALE engine implements — the
overshoot bound depends on metering granularity, not on the size of the cap, and it holds regardless
of how many workers meter concurrently.

### Mapping onto ThrottleKit

| Concern | Mechanism | Guarantee |
|---|---|---|
| Campaign ₹ budget | `distributedTokenBudget` over the shared store, denominated in paise | Atomic debit; overshoot ≤ one debit, independent of worker count |
| Global action rate | `twoTier` leased, `windowCoupled: true` | Fleet-size-independent bound — scaling workers cannot raise the ceiling |
| Per-customer contact cap | `quota`, rolling window | 3 contacts / 7 days, provable |
| Razorpay API pressure | `adaptiveConcurrency` | Backs off on 429/5xx rather than hammering a partner |
| Multi-campaign sharing | `weightedFairEscrow` | Weighted-fair split with idle surplus reclaimed |
| Reservation sizing | `learnedReservation` (newsvendor critical fractile) | Learns hold-vs-overrun trade-off online |

**On `learnedReservation` specifically:** this is the component most at risk of being machinery for
its own sake. The trade-off is real — over-reserve and the budget sterilises, under-reserve and sends
abort mid-flight — but we do not get to assert that it matters. §14 measures fixed reservation against
learned on the same batch, and if the gap is negligible we cut it and say so in the write-up. Applying
the project's own honesty standard to its most flattering component is the point.

### Mandates

```ts
type Mandate = {
  id: MandateId
  scope: { merchantId, campaignId }
  budgetPaise: Paise
  contactCaps: { perCustomer: { n: number; windowMs: number } }
  quietHours: { startMin: number; endMin: number; tz: string }
  allowedActions: ActionKind[]
  validFrom: number; validUntil: number
  killSwitch: boolean
  signature: string        // HMAC over the canonical encoding
}
```

Signed so that provenance is auditable and a tampered mandate is detectable. The kill switch lives in
the shared store, not in process memory, so flipping it propagates fleet-wide within one admission.

### Crash safety and idempotency

- Reservations carry a TTL. A worker that dies mid-action leaks nothing: the reservation expires and
  the authority returns to the pool.
- Every outbound action carries a deterministic idempotency key derived from
  `(casualtyId, actionKind, attemptNo)`. Where the gateway supports idempotency keys we pass them;
  where it does not, the ledger is consulted before dispatch. A crash-and-retry cannot double-charge
  or double-message.

### Every decision is explainable

Admission returns not just allow/deny but **which axis was binding** and what remained on it. That
field is what turns "the system declined to message this customer" into "the system declined because
this customer had already received 3 contacts in 7 days, cap 3" — and it is written to the ledger on
every decision, allowed or denied.

---

## 9. The audit ledger

Append-only and hash-chained: `hₙ = H(hₙ₋₁ ‖ canonical(recordₙ))`. Any retroactive edit breaks the
chain from that point forward, and `verify()` walks it.

Each record carries: actor, action, target reference, the reason, a reference to the model output if
one was involved, the Terminus decision including the binding axis and remaining budget, the external
request id, the outcome, and the timestamp.

**PII discipline.** The ledger stores *references*, never raw personal data. Phone numbers and emails
are stored as keyed hashes; raw values live in a separate store with its own retention policy and
access path. This keeps the artifact we hand to a judge — or a regulator — free of customer data while
remaining fully verifiable.

Per P8, a ledger write failure halts outbound actions.

---

## 10. Data model

**Postgres** for durable state, **Redis optional** for hot coordination.

Making Redis optional is deliberate. ThrottleKit runs the same algorithms over Postgres with proven
bit-identical decisions, so the whole system runs on one dependency for a demo or a small merchant,
and adds Redis only when the hot path justifies it. Fewer moving parts to stand up is worth real
points when someone else has to run your project.

Core tables: `slices` · `slice_state` · `incidents` · `steering_decisions` · `casualties` ·
`recovery_attempts` · `mandates` · `ledger` · `experiments`.

`steering_decisions` records the holdout arm at decision time. `experiments` pins the seed, config
hash, and code revision for every harness run, so a scorecard is reproducible from the row.

---

## 11. Razorpay surface and the simulation boundary

### APIs used

Orders · Payments (including `error_source` / `error_step` / `error_reason`) · Payment Links ·
Subscriptions · Invoices · Settlements · **Payment Downtime API** and `payment.downtime.*` webhooks ·
`payment.failed` / `payment.captured` / `payment.authorized` webhooks · Checkout method configuration.

Note that capture requires the captured amount to equal the authorised amount — Razorpay does not
support partial capture. So reservation lives in Terminus, and the gateway's `authorize → capture`
gives us a genuine two-phase commit with auto-refund of anything uncaptured within three days.

### The honest boundary — stated, not buried

Test mode cannot produce real traffic volume or real issuer outages, and a detector cannot be
demonstrated on five payments.

- **The outcome stream is simulated.** Built from Razorpay's documented error taxonomy and a
  realistic Indian method mix, with injectable degradation events whose onset times are ground truth.
  This is what gives the detector statistical power and gives the harness a measurable answer.
- **The actions are real.** Every retry, payment link, order, and capture is a real Razorpay test-mode
  API call with a real request id recorded in the ledger.
- **The demo checkout is real.** A live Razorpay Checkout whose method configuration comes from
  `sentry`, so a human can watch the steering happen.

Both paths run through identical decision code — the simulator and the live gateway satisfy the same
`Gateway` port. Stating this boundary plainly is worth more than a claim of live traffic that would
not survive one question.

---

## 12. Failure modes

| Failure | Detected by | Degrades to | Bound held? |
|---|---|---|---|
| Store (Redis/PG) unavailable | `apply` error | Steering → default routing. Spending → tighter local bound, then halt | Yes |
| LLM timeout or error | Deadline | Deterministic playbook + template copy | Yes — the model never gated money |
| LLM returns invalid schema | Zod validation | Rejected, fall back to deterministic path | Yes |
| Razorpay 429 | Status | Adaptive concurrency backs off, work queues | Yes |
| Razorpay 5xx | Status | Bounded retry with jitter, then park for operator | Yes |
| Detector false alarm | Holdout comparison | Auto-revert as evidence decays; damage ≤ `maxSteeredFraction` | Yes |
| Worker crash mid-action | Reservation TTL | Reservation expires, authority returns | Yes |
| Clock skew across workers | — | Redis/PG server clock rolls windows from one shared key | Yes |
| Ledger write failure | Write error | **Halt outbound actions** | Yes, by stopping |
| `sentry` entirely down | Checkout timeout | Default method order | Yes |

The chaos demonstrations we ship: kill the store mid-incident, inject a 429 storm, and time out the
model — showing in each case that the audit trail stays intact and no cap was exceeded, including
*during* the partition.

---

## 13. Security

**Secrets.** Never committed. `.env.example` documents the shape; `gitleaks` runs in CI. Only
test-mode credentials exist anywhere in the repo's world.

**Webhook verification.** Razorpay signatures are HMAC-SHA256 over the **raw** request body — verified
before JSON parsing, using a constant-time comparison. Event ids are deduplicated and timestamps
windowed, so a captured webhook cannot be replayed.

**Prompt injection.** The model reads untrusted text: error descriptions, customer names, catalog
content. Mitigations, in order of importance: model output is never executable (P1); there is no
tool-calling path to a money action; output is parsed into a closed enum/schema and validated; and
untrusted content is delimited and labelled as data in the prompt. The worst outcome of a successful
injection is a badly-worded SMS, not a payment.

**PII minimisation.** Identifiers are hashed in logs and in the ledger. Prompts carry error codes and
amounts, not names — except when composing customer-facing copy, which gets a first name and nothing
else.

**Least privilege.** Separate credentials per application. `recover-worker` cannot modify steering
configuration; `sentry` cannot dispatch messages.

**Supply chain.** Pinned dependencies, `npm audit` gate on production deps, Dependabot, CodeQL.

**Kill switch.** One flag in the shared store, consulted on every admission, halting all outbound
money actions fleet-wide within a single check.

---

## 14. Measurement

The submission's credibility rests here, so the harness is a first-class application, not a script.

### Design

Fixed-seed simulated books of business with ground truth: which slices degraded and when, and which
casualties were genuinely recoverable.

**Baselines** — steering: no-steering. Recovery: do-nothing, naive fixed retry (+1h/+24h/+72h),
contact-everyone-immediately.

### Reported metrics

| Metric | Why it's there |
|---|---|
| ₹ saved by prevention | `(control loss rate − treated loss rate) × treated volume`. Holdout-derived, not modelled |
| ₹ recovered, and **net of action cost** | The naive baseline recovers nearly as much while burning far more — that gap is the result |
| Detection latency vs false-alarm rate | The detector's honest characteristic curve |
| Calibration curve | Predicted p(recover) against actual. Almost nobody publishes this |
| False-positive cost, in ₹ | Unnecessary contacts, retries on dead cases, ₹ spent per ₹ recovered |
| Budget utilisation | Authority refused that was actually affordable — safety's own cost |
| Throughput and p50/p99 decision latency | Track bar: throughput *and* accuracy |
| Compliance assertions | Zero cap violations, zero quiet-hour contacts, zero post-opt-out contacts — asserted over the full ledger |
| **Honest exception list** | Cases unhandled, and cases where Kairos lost to baseline |

That last row is deliberate. Showing where the system loses is the cheapest credibility available and
almost no submission will do it.

### Reproducibility

Every run pins seed, config hash, and git revision. The scorecard regenerates in CI (§16).

---

## 15. Stack and repository layout

TypeScript · Node ≥ 20 · pnpm workspaces · Postgres (Redis optional) · Fastify · Vitest · Biome ·
Zod at every boundary · OpenTelemetry.

Biome rather than ESLint+Prettier, for consistency with ThrottleKit and because one tool with one
config is one less thing to keep aligned.

```
kairos/
├── packages/          domain · detect · policy · recover · terminus · ledger · ports
├── adapters/          razorpay · simulator · reasoner-anthropic · store-postgres
│                      store-redis · messenger-sms · messenger-whatsapp · ledger-postgres
├── apps/              sentry · recover-worker · checkout · console · bench
├── docs/              ARCHITECTURE.md · MEASUREMENT.md · SECURITY.md · decisions/ (ADRs)
└── .github/workflows/ ci · security · bench
```

Significant choices get an ADR in `docs/decisions/` — the record of *why*, which is the part that
survives when the code changes.

---

## 16. CI/CD

**`ci.yml`** — lint, typecheck, unit tests, integration tests against an ephemeral Postgres service
container, build, coverage gate. Runs on every push and PR.

**`security.yml`** — CodeQL, gitleaks, `npm audit` gate on production dependencies, Dependabot.

**`bench.yml`** — runs the measurement harness on fixed seeds, publishes the scorecard as an artifact,
and **fails the build if headline metrics regress beyond a threshold.**

That last one is the interesting one. It turns "honest metrics" from a promise into an engineering
control: detection latency, recovery rate, and violation count all become things CI can refuse to
merge a regression on. Very few projects at any scale gate on their own effectiveness numbers.

Conventional commits with commitlint. Every commit builds and passes CI on its own — history stays
bisectable, so `git bisect` remains a working tool on this repo.

---

## 17. Build sequence

Each phase ends somewhere demonstrable and measurable, so the repo is never in a state that cannot be
shown.

| Phase | Delivers |
|---|---|
| **0 · Foundation** | Repo, CI, `domain` types, `ledger` with chain verification |
| **1 · Detection** | Simulator, CUSUM detector, baselines, hysteresis — and the latency/FAR curve |
| **2 · Terminus** | Mandates, reserve/reconcile over ThrottleKit, stopping rules, audit integration |
| **3 · Prevention** | Steering policy, holdout, `sentry`, demo checkout — first live steering |
| **4 · Recovery** | Classification, EV gate, scheduling, Razorpay actions, `recover-worker` |
| **5 · Proof** | Harness, baselines, scorecard, calibration, `bench.yml` regression gate |
| **6 · Demonstration** | Console, chaos scenarios, pitch materials |

---

## 18. Open questions

Recorded rather than resolved, because pretending they are settled would be the wrong kind of
confidence.

1. **Detector threshold calibration.** ARL₀ targets need to be chosen against realistic Indian traffic
   shapes, not guessed. Phase 1 produces the curve that decides this.
2. **Is `learnedReservation` earning its place?** §8 commits to measuring it and cutting it if not.
3. **Holdout size versus incident length.** Short incidents may not accumulate enough control-arm
   volume for a tight interval. We may need to pool across incidents and report confidence intervals
   rather than point estimates — which is more honest anyway.
4. **Checkout method configuration limits.** Exactly how far Razorpay Checkout permits programmatic
   method ordering and suppression needs verification against the live SDK in Phase 3, and the
   steering vocabulary must be built to what it actually supports.
5. **Recovery attribution.** If a customer would have retried unprompted, our contact did not recover
   that money. The holdout handles this for prevention; recovery needs its own control arm, and it
   costs us recovered revenue to run one. We run it anyway.
