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
enters through an interface declared beside the code that consumes it — `Gateway` and `Messenger` in
`razorpay`, `CasualtyStore` and `CustomerDirectory` in `recover`, `Clock`, `KillSwitch` and
`AuditSink` in `terminus`. A single ports package would centralise interfaces whose only common
property is being interfaces, and put the definition a long way from the file that has to honour it.
This is what makes the simulator and the live gateway interchangeable, and it is why the whole system
is testable without a network.

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
| `@kairos/policy` | Steering decisions: which rail to move traffic off, by how much, and who is held back as a control. Prices every steer before making it. Holds the rail-health window, which is deliberately *not* the detector's frozen baseline. |
| `@kairos/recover` | Classification, expected-value gating, action selection, next-action scheduling, and the calibrated recovery-probability model. Also owns the drain loop, which takes every side effect as a port. |
| `@kairos/terminus` | The governance kernel. Mandates, reservation/reconcile, stopping rules, admission. Wraps `throttlekit`. |
| `@kairos/ledger` | Hash-chained append and verification. |
| `@kairos/reason` | What a language model is asked, what it may answer, and what the answer costs. Prompts, the validation gauntlet, pricing at list rate, and the copy library. Knows nothing about any provider — the model writes copy for a *situation*, never for a customer, and rendering afterwards is pure. |
| `@kairos/explain` | Turning the audit chain into an answer: retrieval by subject, redaction down to an allowlist of six fields, and the check that every figure in the prose appears in a record. Refuses an answer it cannot vouch for rather than captioning it. |
| `@kairos/proof` | Measurement as a commitment. Metrics with bands, invariants without, provenance over the experiment's configuration, and the comparison that decides whether a run still proves what the project claims. Knows nothing about payments — the benchmarks feed it. |

The core has **zero runtime dependencies** other than `throttlekit` (in `terminus`) and `zod` for
schema definitions. Anything that needs a network lives outside it.

### Ports — interfaces only

```ts
interface EventSource   { subscribe(h: (a: Attempt) => void): Unsubscribe }
interface Gateway       { createOrder · createPaymentLink · capture · refund · fetchDowntimes }
interface Messenger     { send(msg: Message): Promise<SendResult>   // SendResult carries ACTUAL cost
interface Composer      { compose(req): Promise<ModelResult<ProposedCopy[]>>   // build time, not send time
interface Explainer     { explain(req): Promise<ModelResult<string>>          // operator-initiated
interface ResidualClassifier { classify(input, deadlineMs): Promise<string>   // closed enum, validated
interface Store         { apply(key, ttl, transform): Promise<ApplyOutcome>  // throttlekit's Store
interface LedgerSink    { append(r: AuditRecord): Promise<void> }
interface Clock         { now(): number }
interface KillSwitch    { engaged(m: Mandate): Promise<boolean>  // a read that FAILS counts as engaged
interface CasualtyStore { due · claim · save · get   // the atomic lease is what makes a fleet safe
interface CustomerDirectory { lookup(c: CustomerRef): Promise<CustomerProfile | null>
```

`Messenger.send` returning the *actual* cost rather than accepting a quoted one is deliberate — see
§8 on why cost is only knowable after the fact.

### Adapters

**Built** — `razorpay` · `simulator` · `reasoner-gemini` · `postgres`

**Named, not built** — `store-redis` · `messenger-sms` · `messenger-whatsapp` · `ledger-postgres`.
The Redis store is ThrottleKit's own and needs wiring rather than writing. The two messengers are
what live delivery would need, which is why `recover-worker` refuses to start with
`KAIROS_DELIVERY` set to anything but dry-run. The Postgres ledger is the shared audit chain a
fleet still does not have — honest gap 15.

Each adapter is independently swappable and independently tested against a shared conformance suite
per port. The simulator and the live Razorpay adapter satisfy the same `Gateway` interface, which is
what lets the entire system run offline in CI.

### Applications

| App | What it is |
|---|---|
| `sentry` | Ingests outcomes, runs detection, publishes the current steering plan, and serves the operator view. Outcomes arrive either reported in batches or delivered by the gateway: `POST /webhooks/razorpay` verifies a Razorpay signature over the raw bytes, rejects a stale or replayed event, and translates the payment into an `Attempt` before the detector sees it. Also `GET /health`, `/ledger` and `/metrics`. Stateless in the sense that matters — with `KAIROS_DATABASE_URL` the blast-radius cap lives in the shared store and the service is a fleet; without one it is a single instance by construction, and says so at startup. |
| `recover-worker` | Drains the casualty queue, and serves `GET /health`, `/ready` and `/metrics` on a separate port — a worker deadlocked on a pool it never gets a connection from looks exactly like a healthy one from outside. **Deliberately multi-instance** — this is where a naive budget check would race, and where Terminus earns its place. `KAIROS_DATABASE_URL` is the whole difference between one instance and a fleet: with it the queue and the spend authority both live in Postgres, without it both live in memory and it is a single instance by construction. Ships in dry-run delivery: every decision real, no message sent. |
| `traffic` | A merchant that is not there. Generates payment attempts from the simulator, asks `sentry` for a plan the way a checkout would, reports the outcomes, and files the casualties the worker drains. Paced against a wall clock at a stated multiple rather than replayed at CPU speed, because a day of traffic delivered in four seconds shows a detector firing on data it could not have observed. Recurring incidents, alternating rails. |
| `site` | The public case, the film, the recorded console run, the integration reference and the benchmarks. Static, and compiles `domain`, `detect`, `terminus` and `console` into the browser bundle — so the numbers it shows come from this tree rather than from a copy of it. |
| `checkout` | **Not built.** A demo storefront on Razorpay Checkout whose method configuration is driven by `sentry`. It needs a Razorpay test key and is the one place the steering claim would meet a rendered page rather than a documented API — see open question 6. |
| `console` | Operator view: rail health, incidents, which bound is binding, the audit trail. A JSON API with no view layer, driving the real detector, controller, kernel and ledger over simulated traffic — every response carries `provenance: {kind: "simulated", scenario, seed}`, because a dashboard of red rails and rupee figures is what ends up in a slide. Six named scenarios, including one where nothing happens and two that end in a refusal. Also hosts `pnpm explain`. **This app's own UI is not built**; the live operator view is served by `sentry`. |
| `scribe` | Writes the copy library. Asks a model once per *situation* — 180 of them, not 5,719 messages — validates every answer, and commits the result. Runs under a signed mandate whose only permitted action is `reason`, so it could not send a message if its code asked it to. Resumable, because a free tier's daily quota is a real bound. |
| `mandate` | Authors, signs, verifies and explains a mandate. Two programs on purpose: a loopback form that collects a *spec* in rupees and days, and a command that seals one from a key the form never sees. `explain` states the two bounds a mandate does not contain but implies — the most that can be in flight at once, and how many actions the budget buys — because nobody can be asked to sign a limit they have to compute in their head. See [ADR 0009](decisions/0009-the-form-authors-a-mandate-and-a-separate-command-signs-it.md). |
| `bench` | The measurement harness. Four experiments on pinned seeds, a consolidated scorecard, the seed study its regression bands are derived from, and the gate CI runs on every change. |

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

### What we publish as evidence — measured

**A detection-latency vs false-alarm-rate curve**, swept over thresholds on the simulator where the
true onset time is known. Full results, caveats and the blind spot are in
[MEASUREMENT.md](MEASUREMENT.md); the summary:

| threshold | false alarms/hr | detected | median latency |
|---:|---:|---:|---:|
| 6 | 16.71 | 67% | 81s |
| 8 | 3.00 | 88% | 71s |
| **12** | **0.21** | **83%** | **93s** |
| 17 | 0.00 | 83% | 122s |

The operating point is `h = 12`, the fastest threshold inside a budget of 0.25 false alarms/hour. An
issuer collapse is caught in **5 seconds**; a fifteen-minute slow bleed takes seven minutes, which is
roughly how long it takes for the evidence to exist.

One case is not detected at all: a degradation confined to a slice seeing ~4 attempts a minute. That
is a genuine limit rather than a tuning problem — the alternative is the `h = 6` row, which costs
16.7 false alarms an hour and detects *less* overall, because an early false alarm leaves the slice
already alarmed when the real event arrives.

---

## 6. Steering — the prevention arm

### The decision

Given active incidents, produce a `SteeringPlan` per customer: instruments to remove, methods to push
down, and the order to render. The checkout consumes it as configuration and can ignore it entirely.

### Two levers, because Checkout can only act on what a customer can see

**Corrected after verifying Razorpay Checkout's real capability.** This section previously assumed
suppression — detect a failing rail, remove it. That works for a minority of Indian volume.

`config.display.hide` reaches instrument level, so a netbanking bank or a card issuer can be removed
precisely. But **a UPI payment's issuer is the customer's own bank, sitting behind a VPA nobody has
typed yet**: when HDFC's UPI handle degrades, Checkout cannot tell which of the people on the payment
page bank with HDFC. There is no instrument to hide, and hiding UPI outright would punish the ninety
per cent whose bank is fine. Around seventy per cent of modelled traffic sits on slices shaped
exactly like that.

| Lever | Mechanism | Available for | Costs |
|---|---|---|---|
| **suppress** | `display.hide` | slices Checkout can name precisely | abandonment — some customers leave rather than switch |
| **demote** | `display.sequence`, default blocks off | everything else | collateral — most of the people it moves were fine |

Full reasoning and the measured break-even rates are in
[ADR 0002](decisions/0002-two-steering-levers-because-checkout-cannot-see-a-upi-issuer.md).

### Every steer is priced before it is made

Steering has been described as moving customers off a broken rail. Arithmetically it is moving
customers, *some* of whom were on a broken rail, onto a rail that may be worse — and on Indian
traffic the second half is not hypothetical, because UPI fails around 2% and cards around 12%.

The decision is the sign of one number, the expected change in failure probability across all
traffic, with three constraints on top:

- **the rescue must justify the steer.** The collateral term can be positive on its own, since a
  chronically poor method's healthy users may be better off elsewhere. Letting that alone carry a
  decision means steering on a pretext.
- **the target may be finer than the incident.** Detection deliberately rolls up to the coarsest
  slice that explains an outage; acting wants the narrowest slice that does. Every candidate inside
  an incident is priced and the best one wins, provided it is at least as bad as the incident it
  refines.
- **the improvement must clear a margin.** The estimates feeding the decision are noisy, and a steer
  that is break-even in expectation is a coin flip with somebody's checkout.

### Bounds — all enforced by Terminus, none by convention

| Bound | Default | Mechanism | Why |
|---|---|---|---|
| `holdoutFraction` | 0.10 | policy | Without it there is no lift number. It is also what keeps the detector's signal alive during a steer |
| `methodFloor` | 2 | policy, twice | **Never leave a customer with fewer than two ways to pay.** |
| `maxIncidentDurationMs` | 30 min | Terminus reservation TTL | A steer that is not re-affirmed simply stops |
| `maxConcurrentSteers` | 3 | Terminus in-flight cap | Global blast radius, shared across instances |
| `minEvidenceWindows` | 2 | policy | Never steer on a single alarm |

`methodFloor` is the one to defend hardest. Every other bound limits damage; this one prevents a
category of failure where the system's own remediation is the outage. It is enforced twice — once
when a steer is evaluated, and again when a customer's plan is assembled, because that is the only
place a combination of individually-safe steers can add up to an empty checkout.

**A steer is a Terminus reservation.** Blast radius is the kernel's in-flight cap; the maximum steer
duration is its reservation TTL; letting the grant lapse *is* the auto-revert. So a `sentry` that
dies mid-incident leaves a checkout that returns to the merchant's own configuration by itself, with
no second expiry mechanism to get wrong. A steer moves no money, so it is always abandoned rather
than settled.

### Holdout

Assignment is **sticky per customer** — `hash(customerId, incidentId) < holdoutFraction` — so a given
person's experience stays consistent within an incident rather than flickering between arms on
refresh. Assignment is recorded in the ledger at decision time, before the outcome is known, which is
what stops the analysis from being retrofitted.

### The hot path is advisory

`checkout` calls `sentry` for a plan with a hard 50 ms timeout, and `sentry` enforces the same budget
on its own side. Timeout, error, an unparseable customer reference, degraded mode, or Kairos being
entirely absent all resolve to the merchant's default method order. **Kairos can never block or fail
a checkout.** This is P2 in its steering direction, and it is the single most important production
property in the system — the failure mode of a payment-health tool must never be "no payments".

A control-arm customer receives a configuration byte-identical to the one they would get with Kairos
never deployed, which is what makes the holdout a real counterfactual rather than a label.

---

## 7. Recovery — the casualty arm

### Intake

Failed payments arrive by `payment.failed` webhook, with a polling reconciliation sweep behind it to
catch anything the webhook dropped. Abandoned checkouts and overdue invoices enter the same queue as
different `CasualtyKind`s.

### Classification

Keyed on Razorpay's error taxonomy — `error_source`, `error_step`, `error_reason` — into
recoverability classes:

| Class | Example causes | Action | Share of failures on a healthy rail |
|---|---|---|---:|
| `customer-retry` | cancelled collect request, abandoned bank page, wrong PIN or OTP | One ask, then stop | **31%** |
| `timed` | insufficient funds, wallet empty, credit limit | Retry at a balance-likely moment | 27% |
| `transient` | issuer down, gateway timeout, network | Retry **when the rail heals** — we own the detector | 24% |
| `customer-action` | card expired, invalid VPA, mandate revoked | Retrying is pointless. Contact with a specific fix-link | 12% |
| `dead` | stolen/blocked card, international not permitted, fraud flag | **Stop.** Do not chase | 6% |
| `unknown` | anything unmapped | One low-cost contact, then stop | — |

`customer-retry` was not in the original five and was added because building the rule table showed
that the largest bucket of ordinary failure fit none of them — see
[ADR 0003](decisions/0003-a-sixth-recoverability-class-for-the-customer-who-must-simply-try-again.md).
The shares are volume-weighted across the modelled Indian mix. During a degradation they collapse:
**100%** of the excess failures are `transient`, which is the whole reason knowing *which situation
you are in* is worth more than any improvement to a retry schedule.

**The rule table is deterministic.** Where the taxonomy is unambiguous, an LLM does not get a vote —
it classifies only the residual, and its output is constrained to the enum above and validated before
use. Money decisions ride on the deterministic path (P1).

Two properties of the table matter more than its coverage. It **degrades rather than collapsing** on
an error nobody has mapped, because `source` and `step` still say who broke it and where, so a code
Razorpay ships next Tuesday classifies sensibly at reduced confidence instead of falling into the
residual. And it **carries that confidence** rather than discarding it: a structural guess and an
exact match produce different recovery probabilities through the same model, so uncertainty about the
cause becomes reluctance to spend with no special case anywhere.

### Whether we can act on it at all

A class says whether the *failure* could come out differently. It does not say whether Kairos can
find out without asking the customer, and on Indian rails it usually cannot: a UPI payment needs a
PIN, a card needs an OTP, netbanking needs a login. Only a payment against standing consent — a
token, a UPI Autopay mandate, an e-mandate — can be charged again by a server with nobody watching.

So every casualty carries a **retry capability** alongside its class. Where a payment is
`autonomous`, retrying is a server-to-server call that costs nothing, disturbs nobody and can happen
at three in the morning. Where it is `requires-customer`, the retry action does not exist and the
only lever is a message — which costs money, burns a contact allowance, is subject to quiet hours,
and risks the customer's consent. On a mixed merchant that is **around one payment in eight**. See
[ADR 0004](decisions/0004-a-retry-is-only-free-when-the-customer-is-not-needed.md).

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

**`E[cost of action]` is not the postage.** At Indian message prices and Indian order values an SMS
pays for its own postage above about three rupees, so a gate priced on send cost alone approves
chasing everybody and is not a gate. What actually stops it is the chance of losing the customer's
consent to be contacted at all — a cost that appears on no invoice, cannot be reserved against, and
must not be booked as spend. It is priced in the decision layer and subtracted there. Terminus
applies its own expected-value test against real money, and that one is deliberately the weaker of
the two: a budget can only be reconciled against spend that actually leaves the account.

### Scheduling — the `kairos` part

Every dunning system retries on `chronos`: +1h, +24h, +72h, indifferent to the world. Kairos schedules
on the cause:

- `transient` → subscribe to slice health; fire on the recovery edge
- `timed` → salary-cycle prior plus per-customer historical success times
- `customer-action` → immediate contact, then a bounded ladder

Subject always to quiet hours, DND, and per-customer timezone.

**And subject to waiting.** Before anything is spent on a customer, they are given a window to come
back unprompted — because a great many of them do, and a message that arrives first is paid for by
recoveries that would have happened anyway. The harness sweeps that window and finds it costs
nothing: messages and wasted actions fall with it and incremental recovery does not, because a
customer who returns unaided closes their own casualty and a transient one asked later is asked when
its rail is likelier to have healed. Waiting is not the price of restraint here. It is most of the
product, and it is what the product is named for.

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
   - **LLM tokens** — known only once the completion has streamed. Realised in
     `adapters/reasoner-gemini`: a call is reserved at a ceiling derived from the prompt and settled
     against `usageMetadata`, and the two differ because *thinking* tokens are billed as output and
     nobody knows in advance how many there will be.
   - **SMS segments** — GSM-7 gives 160 characters per segment; Devanagari forces UCS-2 at **70**. So
     `"aapka payment fail ho gaya"` is one segment and `"आपका पेमेंट फेल हो गया"` is three. Since
     copy is generated at build time the *language* is known at admission — but the customer's own
     name is not ours to choose, and one Devanagari character in it moves an otherwise Latin message
     to UCS-2. *A message is composed with a person's name in it, and a person is free to be called
     रोहित.*
   - **Gateway fees** on a retry, resolved when the attempt does.
3. **Utilisation matters** — though less than this section originally claimed. The worry was that
   reserving the worst case for every action sterilises the budget, so the system stops chasing
   recoverable money it could afford, and that safety costing all your utilisation is not safety but
   a different failure. The worry is sound in general and mostly wrong here, for a reason that only
   showed up once it was measured: **a reservation is released at settlement, not consumed.** An
   over-sized reservation holds authority for the duration of one action and hands back whatever the
   action did not use, so on a lifetime budget that runs to exhaustion it costs nothing at all. What
   remains is a tail effect — near the end, the budget can hold less than a worst-case reservation
   but more than the action would really have cost — and that is bounded by
   `maxInFlight x (reservation - actual)`. Measured, reserving the worst case runs at 100%
   utilisation and gives up between 0% and 6.3% of messages against any cleverer scheme. §14 and
   MEASUREMENT.md carry the numbers.

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

This is commitment accounting. The bound it produces, derived in
[ADR 0001](decisions/0001-commitment-accounting-over-throttlekits-store.md) and measured in
[MEASUREMENT.md](MEASUREMENT.md):

```text
  final settled  <=  budget  +  maxInFlight x (maxActionCost - reservation)
```

Both terms are mandate fields. Neither is the worker count, which is the whole point: adding machines
cannot move it. A naive check-then-spend overshoots by `workers x maxActionCost` instead, and that is
an absolute quantity, so it is a rounding error on a large campaign and a catastrophe on a small one.
Reserving the worst case drives the residual to exactly zero, at a cost in utilisation that turns out
to be small enough to measure.

### Mapping onto ThrottleKit

**Corrected after implementation.** This table originally named `distributedTokenBudget` as the
campaign-budget mechanism, on the strength of its fleet-size-independent overshoot bound. That bound
is real and it does not apply here: the token budget is a *post-hoc meter* built for costs that
accrue continuously, so nothing is held across the interval between deciding to send a message and
learning what it cost — which is the exact interval Terminus exists to close. ADR 0001 records the
reasoning and what replaced it.

| Concern | Mechanism | Guarantee |
|---|---|---|
| Campaign ₹ budget | `Store.apply` running a pure ledger transform | Atomic reserve → settle; authority is *held* across the interval where cost is unknown |
| Per-customer contact cap | `quota`, rolling window | 3 contacts / 7 days, provable; a denied request never consumes |
| Reservation sizing | `learnedReservation`, `predictiveReservation` | Newsvendor critical fractile, learned online — measured, and not the default |
| ~~Global action rate~~ | ~~`twoTier`~~ | Deferred to Phase 4. The in-flight cap covers blast radius; a fleet-wide *rate* belongs with the adapter making the calls |
| ~~Razorpay API pressure~~ | ~~`adaptiveConcurrency`~~ | Deferred to the Razorpay adapter |
| ~~Multi-campaign sharing~~ | ~~`weightedFairEscrow`~~ | Deferred. One mandate per campaign; nothing shares a budget yet |

What ThrottleKit contributes is `Store` — one atomic read-modify-write over a single key, proven
bit-identical across in-memory, Redis and Postgres. That is the hard part and it is the part worth
taking. Everything above it is a pure function of the prior state, which is why the same ledger code
is correct in a unit test and in a fleet.

**On `learnedReservation` specifically:** flagged here as the component most at risk of being
machinery for its own sake, with a commitment to measure it against fixed reservation and cut it if
the gap was negligible. **Measured, and it does not earn its place.** Across a budget sweep and a
cost-mix sweep it buys between 0% and 6.3% more messages, and gives up the only overspend bound that
is exactly zero. On the mixes where more than a fifth of messages cost the ceiling it converges to
reserving the worst case and buys nothing at all — which is the learner working correctly and finding
that there was nothing to find. It stays behind the `Sizer` interface so the measurement stays
reproducible; the kernel defaults to reserving the worst case. Numbers in §14 and MEASUREMENT.md.

### Mandates

```ts
type Mandate = {
  id: MandateId
  merchantId: string; campaignId: string
  budgetPaise: Paise            // a lifetime ceiling, not a rate
  maxActionCostPaise: Paise     // an adapter that cannot cap its own cost cannot be admitted
  maxInFlight: number           // blast radius, and the other term in the overspend bound
  reservationTtlMs: number      // must exceed the worst-case duration of an action
  contactCap: { limit: number; windowMs: number }
  quietHours: { startMinute; endMinute; offsetMinutes } | null
  allowedActions: ActionKind[]
  validFrom: number; validUntil: number
  killSwitch: boolean
  signature: string             // HMAC-SHA256 over the canonical encoding of every field above
}
```

`maxActionCostPaise` and `maxInFlight` are the two terms of the overspend bound, which is why they
are mandate fields rather than deployment configuration: the limit is something the merchant grants,
not something an operator can raise by editing a YAML file and restarting.

Quiet hours take a **fixed UTC offset**, not an IANA zone. India is UTC+5:30 with no daylight saving,
so the offset is exact for the target market, and it is the only calendar arithmetic reproducible
bit-for-bit inside a Redis Lua script — which is what keeps the bound identical whether it is
evaluated in process or in the shared store. Zones that observe DST are out of scope rather than
quietly approximated.

Signed so that provenance is auditable and a tampered mandate is detectable; the canonical projection
is written field by field rather than spread, because the failure mode of the convenient version is a
limit that is silently unsigned, and the test suite asserts that perturbing any field changes the
signature.

A mandate is also, by construction, unreadable: every field is in the units the kernel enforces, and
the two numbers a person signing one most needs — the most that can be committed at once, and how
many actions the budget buys — are products of fields rather than fields. `apps/mandate` is the path
from what a merchant can say to what the kernel can enforce, and it is deliberately two programs so
the signing key never reaches a browser:
[ADR 0009](decisions/0009-the-form-authors-a-mandate-and-a-separate-command-signs-it.md).

There are **two kill switches and either one stops everything**. The signed flag cannot be cleared by
anyone who cannot sign. The store-backed switch propagates fleet-wide within one admission with no
redeploy and no re-signing. A switch that cannot be *read* counts as engaged — P2 applied to the stop
itself, because not knowing whether we have been told to stop is being told to stop.

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

That row exists ahead of the table. Every scorecard in `docs/results/` carries a `provenance` block
holding exactly those three fields plus the Node version, and the config hash is load-bearing rather
than decorative: it is what stops the regression gate from comparing two different experiments and
calling the difference a regression. The configuration it hashes is written by hand and redacted, so
that publishing a scorecard cannot publish a mandate signing secret. See §12.

---

## 11. Razorpay surface and the simulation boundary

### APIs used

**Called against the live API, in test mode** — Orders · Payment Links · Payments (fetch), and the
inbound `payment.failed` / `payment.captured` / `payment.authorized` webhooks, verified end to end.
`pnpm razorpay:probe` makes those calls on demand and writes `docs/razorpay-probe.json`; CI holds no
credentials and never will, so it is a command rather than a test.

**Modelled, not called** — Subscriptions · Invoices · Settlements · the **Payment Downtime API** and
`payment.downtime.*` webhooks · Checkout method configuration, which `renderCheckout` emits as
Razorpay's own `config` object without anything sending it.

Payments carry `error_source` / `error_step` / `error_reason`, and the recovery classifier reads that
triple untranslated. Re-coding it into a private enum would put a lossy mapping between the gateway's
account of what went wrong and the decision made about it.

Note that capture requires the captured amount to equal the authorised amount — Razorpay does not
support partial capture. So reservation lives in Terminus, and the gateway's `authorize → capture`
gives us a genuine two-phase commit with auto-refund of anything uncaptured within three days.

### The honest boundary — stated, not buried

Test mode cannot produce real traffic volume or real issuer outages, and a detector cannot be
demonstrated on five payments.

- **The outcome stream is simulated.** Built from Razorpay's documented error taxonomy and a
  realistic Indian method mix, with injectable degradation events whose onset times are ground truth.
  This is what gives the detector statistical power and gives the harness a measurable answer.
- **The client is real, and so is the inbound path.** Orders, payment links and payment fetches are
  real test-mode calls through the same `fetch` the client names as its production transport, and a
  real signed webhook has been verified, translated and observed by the detector. What that does
  *not* cover is the retry policy — 429 and 5xx are what drive it and a healthy gateway will not
  produce either on request.
- **The outbound actions are not real.** `recover-worker` runs in dry-run delivery, which decides
  everything and sends nothing, and refuses to start in any other mode. A live arm needs a gateway
  able to charge a saved token with nobody present and a DLT-registered sender — things a deployment
  has and a repository does not. Nothing in the ledger is a live charge.
- **There is no demo checkout.** `renderCheckout` produces the configuration a checkout would take;
  the storefront that would render it is listed above as not built.

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
| Worker loop wedged | `GET /health` stops answering 200 | Orchestrator restarts it; the lease and the reservation both expire | Yes |
| Webhook secret rotated | Refusals rise on `kairos_webhooks_total` | Deliveries refused, nothing observed | Yes, by refusing |

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
money actions fleet-wide within a single check — `StopSwitch` in `terminus`, driven by
`kairos-mandate stop`. It needs the database and *not* the signing key, because stopping a campaign
must not require the ability to mint one: the person on call is not necessarily the person who holds
the key. A read that fails counts as engaged, which is the one place in Kairos where losing the store
halts spending rather than falling back to a local decision.

**Personal data has one door.** `CustomerDirectory` is the only place a name, a token or a contact is
resolved, and the inbound webhook translation takes a pseudonymiser as a required argument rather
than an option with a default — so a phone number cannot reach the detector, the ledger or a model
prompt by omission. A component not handed that port cannot obtain personal data however much it
decides it needs.

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
| **Overspend against fleet size** | Measured against the stated bound, swept over worker count. The naive baseline's grows with the fleet; the kernel's must not |
| **Contact-cap violations, measured from what was delivered** | Not from the counter that races. A check-then-act cap cannot report its own failure: two workers that read zero both write one |
| Throughput and p50/p99 decision latency | Track bar: throughput *and* accuracy |
| Compliance assertions | Zero cap violations, zero quiet-hour contacts, zero post-opt-out contacts — asserted over the full ledger |
| **Honest exception list** | Cases unhandled, and cases where Kairos lost to baseline |

That last row is deliberate. Showing where the system loses is the cheapest credibility available and
almost no submission will do it.

### Reproducibility

Every run pins seed, config hash, and git revision. The scorecard regenerates in CI (§16).

---

## 15. Stack and repository layout

TypeScript · Node ≥ 22 · pnpm workspaces · Postgres (Redis optional) · Fastify · Vitest · Biome ·
Zod at every boundary · OpenTelemetry.

Biome rather than ESLint+Prettier, for consistency with ThrottleKit and because one tool with one
config is one less thing to keep aligned.

```
kairos/
├── packages/          domain · detect · policy · recover · terminus
│                      ledger · reason · explain · proof
├── adapters/          razorpay · simulator · reasoner-gemini · postgres
├── apps/              sentry · recover-worker · traffic · console
│                      mandate · scribe · bench · site
├── docs/              ARCHITECTURE.md · MEASUREMENT.md · decisions/ (ADRs)
│                      results/ (blessed benchmark output) · razorpay-probe.json
└── .github/workflows/ ci · security · bench · pages
```

The adapters named in §4 as not built have no directory here. A tree diagram is the one piece of
documentation a reader checks against `ls`, so it lists what exists and nothing else.

Significant choices get an ADR in `docs/decisions/` — the record of *why*, which is the part that
survives when the code changes.

`pnpm demo` brings the whole system up under Docker Compose: Postgres, `sentry`, a fleet-capable
worker, the console, and the traffic. One image for every Node service, because they share a
workspace and a lockfile and building them separately would mean four installs of the same graph.
The signing key is generated on first run into a gitignored file — a mandate sealed with a
publicly-known secret is a mandate anyone can forge.

Two things in that stack are demonstration scaffolding and say so in their startup lines. The clock
runs at sixty times real speed, because backoff rungs measured in half-hours and quiet hours that
hold a message until morning are decisions the system is right to make and nobody will sit and watch;
every bound Terminus enforces reads through that one clock, so they scale together, and an
accelerated clock is refused outright in any delivery mode that can reach a person. And the customer
directory is stood in for, because the default returns `null` for everyone and the executor then
refuses every retry for want of a token before composing anything.

An accelerated stack cannot also be a live integration: a webhook is stamped by the outside world and
the rolling window decays what it holds against the detector's clock, so set `KAIROS_CLOCK_SPEED=1`
and stop the traffic when pointing a real gateway at it. One detector has one clock, and there is no
correct merge of two timelines. The rule that follows from all of this — the kernel's clock governs
the campaign, the wall clock governs everything the campaign touches that is not inside the process —
is [ADR 0010](decisions/0010-the-kernel-clock-governs-the-campaign-the-wall-clock-governs-the-world.md).

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
| **2 · Terminus** | Mandates, commitment accounting, stopping rules, audit integration — and the overspend bound, measured against fleet size |
| **3 · Prevention** | Steering policy, holdout, `sentry` — and the lift measured against a control group |
| **4 · Recovery** | Classification, EV gate, scheduling, `recover-worker` — and the incremental recovery measured against a control arm and three baselines |
| **5 · Proof** | ✅ Consolidated scorecard, seed study, provenance, `bench.yml` regression gate — bands derived from measured spread rather than guessed |
| **5.5 · Language** | ✅ `reasoner-gemini`, the validation gauntlet, `scribe`, and a committed copy library in four languages — generated at build time under a signed mandate, reviewed as a diff, replayed offline by every test |
| **5.75 · Consumption** | ✅ The copy library wired into the recovery path, a multilingual customer population, and the fifth benchmark arm that measures what generated copy is worth — with the readability penalty swept rather than assumed |
| **6 · Demonstration** | Console API and chaos scenarios ✅, `explain` CLI ✅, the public site and the film ✅, `pnpm demo` bringing the whole stack up under Compose ✅, the operator view on `sentry` ✅ — console UI, `checkout`, and pitch materials outstanding |

---

## 18. Open questions

Recorded rather than resolved, because pretending they are settled would be the wrong kind of
confidence.

1. ~~**Detector threshold calibration.**~~ **Answered in Phase 1.** `h = 12`, from the measured
   curve. The initial guess of 6.5 was wrong by a wide margin — it produced roughly seventeen false
   alarms an hour, because three failures in quick succession are enough to trip the most aggressive
   shift hypothesis at a 2% baseline. Calibrating against simulated traffic rather than an asymptotic
   approximation is what caught it.
2. ~~**Is `learnedReservation` earning its place?**~~ **Answered in Phase 2. No.** Measured against
   reserving the worst case across a budget sweep and a cost-mix sweep, it buys between 0% and 6.3%
   more messages and gives up the only overspend bound that is exactly zero. Where more than a fifth
   of messages cost the ceiling it converges to reserving the worst case and buys nothing — the
   learner working correctly and finding nothing to find. Kept behind the `Sizer` interface so the
   measurement stays reproducible; not the default.
3. **Holdout size versus incident length.** ~~May~~ **Does** fail to accumulate enough control-arm
   volume, and the arithmetic is now concrete: the control arm collects roughly
   `holdout x railShare x attemptsPerMinute x minutes` observations, so a rail carrying 2% of volume
   at a 10% holdout yields 25 observations in half an hour and an interval wide enough to conclude
   nothing. Intervals are reported and a span across zero is called noise rather than quoted at its
   midpoint. Pooling across incidents is the remaining work.
4. **What should a budget refusal say when the money is merely held?** Admission distinguishes a
   transient budget refusal (authority is committed to actions in flight, and returns when they
   reconcile) from a terminal one (the money is spent), and reports the reservation TTL as the retry
   time in the first case. That is an upper bound rather than an estimate, so a caller that waits for
   it waits far too long, and one that retries immediately can spin. A signal derived from the
   earliest live reservation's expiry would be tighter, and is not yet built.
5. **Reservation TTL against real action durations.** A TTL shorter than the action it covers turns a
   bounded reservation into an unaccounted spend — the ledger counts these as orphan settlements and
   the harness asserts zero. Phase 4 bounded the *client* side: the Razorpay client carries a
   whole-call deadline across every retry and clamps a stated `Retry-After`, so a gateway asking for
   an hour cannot park a worker past its TTL. The real latency distribution of a live SMS provider
   is still unknown, and the TTL must be set from its tail rather than its median.
6. ~~**Checkout method configuration limits.**~~ **Answered in Phase 3.** `config.display.hide`
   reaches instrument level, so netbanking banks, card issuers and wallets can be suppressed
   precisely — but a UPI payment's issuer is the customer's own bank and is invisible to Checkout,
   which covers around seventy per cent of modelled volume. Hence two levers rather than one; see
   [ADR 0002](decisions/0002-two-steering-levers-because-checkout-cannot-see-a-upi-issuer.md). Still
   unverified against a rendered page rather than the documentation.
7. **Very-low-volume slices are undetectable, and probably always will be.** A slice at ~4 attempts a
   minute cannot carry enough evidence to separate a broken rail from an unlucky run. Parent-slice
   coverage and the recovery arm bound the damage; whether that is sufficient is a question for a
   real merchant's traffic rather than the simulator.
8. **Incident altitude can be too fine on slow degradations.** A child slice sometimes alarms before
   its parent has accumulated enough evidence, so an issuer-wide problem is briefly reported as an
   app-specific one and only rolled up afterwards. A grace delay before emitting a child alarm would
   fix it; whether the added latency is worth the precision is unmeasured.
9. **Steering contaminates the estimate that justifies it, and the repair is only half done.** Rate
   is read from the control arm, which is unbiased; *volume* is not, so a suppressed rail's apparent
   share collapses to the holdout fraction and the modelled benefit shrinks with it. The direction is
   safe — it makes the system under-steer, never over-steer — but on a thin rail it is enough to make
   the lever flip from suppression to demotion mid-incident. Estimating counterfactual volume from
   the control arm needs the holdout fraction and breaks down with several simultaneous steers.
10. **Switch elasticity is assumed, not measured.** How many customers take a newly-promoted method
   is a fact about people that no simulator can supply, and it sets how much collateral harm a
   demotion does. The harness sweeps it and the policy is not fragile to it in the direction that
   decides *whether* to steer, but at 90% elasticity the system does three times the collateral
   damage it priced. A live deployment can measure this from its own funnel and should.
11. ~~**Recovery attribution.**~~ **Answered in Phase 4.** A tenth of casualties are held out of
   treatment entirely, and the harness reports incremental recovery — gross minus what the untouched
   population collected — rather than the gross figure every dunning dashboard shows. The gap is
   large: on the class that recovers best unaided, nearly nine in ten of the recoveries a message
   appears to produce were already on their way. It costs real revenue and is run anyway.
12. **The fixed ladder recovers slightly more money than Kairos does.** Measured: about 6% more
   incremental revenue, by sending 2.1x the messages and costing 153 customers their consent rather
   than 43. Whether the trade is worth taking depends entirely on what a merchant thinks consent is
   worth, and the harness prices it at ₹200 per opt-out on a stated derivation rather than a
   measurement. A merchant with a real churn model would get a different answer, and the honest claim
   is that Kairos matches brute force at a third of the damage — not that it beats it.
13. **The spontaneous window is probably too short.** The sweep says messages and wasted actions fall
   monotonically with it while incremental recovery does not, so 45 minutes is defensible and two
   hours looked better. The opt-out counts across the sweep are too noisy for the cheapest row to be
   stable, so the default was left where it was rather than tuned to one run. Longer windows, and a
   per-class window, are unmeasured.
14. **The recovery probability model is blind to the payment method.** It keys on action, class,
   rail health and attempt ordinal, on the argument that what predicts recovery is what the customer
   has to do next rather than which rail they did it on. That argument is untested; a real merchant's
   data would settle it in a week.
15. **A fleet shares its queue and its budget, but not its audit chain.** `CasualtyStore` now has a
   Postgres implementation alongside the in-memory one, so `recover-worker` is horizontally scalable:
   the lease is a guarded `UPDATE` rather than a row lock, because the lease has to outlive the
   transaction that takes it, and two workers draining the same queue act on each casualty exactly
   once. The SQL is tested against a real PostgreSQL 18 in the unit suite — PGlite, the server
   compiled to WebAssembly, so the planner that runs it in CI is the planner that runs it in
   production and no daemon is needed. Spend authority was already shared, through ThrottleKit's
   Postgres `Store`. **What is still per-process is the audit ledger.** `MemoryLedger` is a hash
   chain in one worker, so N workers produce N chains: each internally verifiable, none of them the
   whole story. Nothing is lost and nothing is forgeable, but "show me everything done under this
   mandate" has to be answered by interleaving N chains rather than reading one. A shared appender —
   an insert serialised per campaign, deriving each record's `prev` from the committed head — is the
   remaining piece, and it is not built. See
   [ADR 0008](decisions/0008-the-casualty-lease-is-a-column-not-a-row-lock.md) for why the lease is a
   column rather than the `SELECT … FOR UPDATE SKIP LOCKED` this file used to promise.
16. **Nothing gates the full profile.** The regression gate runs the `quick` scorecard, because that
   is what fits in a pull request; the `full` numbers are the ones published in
   [MEASUREMENT.md](MEASUREMENT.md) and nothing re-checks them. The two profiles have different
   config hashes and are correctly refused as comparable, so this is a gap rather than a hazard — but
   a change could move a published figure while staying inside every band that is enforced. A
   nightly full run against its own baseline is the obvious fix and is not built.
17. **Reproducibility is proven across machines, not across engines.** The gate's first CI run
   reproduced the local scorecard *exactly* — every metric at a delta of zero, ₹5,10,497.00 of
   incremental recovery on Windows and on an Ubuntu runner alike — so the seeded arithmetic does not
   depend on the operating system or on a Node patch level. Whether it survives a change of Node
   *major* is still an assumption: nobody has run the same seed on 22 and on 24 and diffed the
   result. The bench job pins one major and prints an advisory on a mismatch, which handles the risk
   without measuring it.

18. **The message-quality weights are invented, and the multilingual claim rests on them —
   now with the sensitivity measured.** Phase 5.75 swept the readability penalty across its whole
   range instead of quoting one point from it, and the answer is sharper than expected: at a
   penalty of 1.00, where a message in the wrong script works exactly as well as one in the right
   one, generated copy is worth **₹10,367** against ₹1.05 lakh at the default, on a range across
   seeds that straddles zero — a tenth of the value, and not distinguishable from none. The
   generated arm's own figure does not move across the sweep at all, because every message it sends
   is legible and the penalty has nothing to bite on. **All of the value is readability; none of it
   is better writing.** Everything the model produced about naming the rail, being specific about
   the next step and fitting the channel is worth approximately no money on this evidence. What
   remains unmeasured is where on that curve the truth sits, and ADR 0007 still spends real postage
   on the assumption that it is nearer 0.5 than 1.0. The original note follows.

   **The message-quality weights are invented, and the multilingual claim rests on them.**
   `scoreMessage` splits a message's effect four ways — names the cause (0.4), names the action
   (0.4), fits its channel (0.2), and readable-or-halved. The *ordering* is defensible from first
   principles; the *levels* are not measured, because measuring them needs customers rather than a
   simulator. They were chosen conservatively on purpose: `ILLEGIBLE_PENALTY = 0.5` scores a
   message somebody cannot read at half effectiveness rather than zero, which makes the
   multilingual case *harder* to win. That matters because
   [ADR 0007](decisions/0007-an-indic-recovery-sms-buys-a-second-segment.md) commits to paying
   double postage for an Indic SMS on the strength of it. If the true penalty is milder than a
   half, that decision loses money and nothing in this repository would notice.

19. ~~**The detector opens an incident in three minutes and closes it in six hours.**~~
   **Answered.** The way back now has its own test, and the detection curve did not move.

   The original defect: on the console's `issuer-outage` the rail is healthy again at +81 minutes
   and the incident did not resolve until **+442**. The detection study measures latency and false
   alarms and had never measured *resolution* latency, so nothing caught it for five phases.

   **The diagnosis was sharper than the first write-up.** It is not that a one-sided CUSUM decays
   slowly in general — it is that after a rail heals, statistic `i` drifts at `−KL(p₀ ‖ p₀+δᵢ)`,
   which is monotone increasing in δ. The bank reports its *maximum*, so the alarm was governed by
   the fastest riser and the clear by the slowest faller — and which statistic falls slowest is not
   luck, it is always the most sensitive shift, whose entire job is to be slow. **Sensitivity and
   resolution latency were coupled through a quantity nobody chose**: adding a δ to catch milder
   degradations silently made every incident close later. Traced on the console run, δ=0.18 and
   δ=0.40 were back at zero within forty minutes of recovery while δ=0.03 was still at 3.63 six
   hours later, and it alone kept the incident open.

   That also disposes of one of the two repairs this entry used to propose. Resetting the statistic
   on the move to `clearing` cannot help, because `clearing` is only entered once the statistic is
   already below `clearThreshold` — it would have saved the two-minute dwell out of 361 minutes. A
   forgetting factor is the other, and it fails differently: the same λ has to hold the alarm up
   while the rail is broken and let it go when the rail heals, and no value does both.

   **What was done instead.** Closing is now decided by its own statistic — the same Bernoulli
   log-likelihood ratio with its two rates exchanged, accumulating evidence for "the rate is back
   at `p₀`" against "it is still at the rate the alarm was raised on". Three properties make it the
   right instrument: under the alternative its drift is `−KL(p₁ ‖ p₀) < 0`, so it pins at its floor
   and *no* amount of time clears a rail that is still broken; it crosses at the standard CUSUM
   crossover between the two rates rather than at either of them; and resolution latency now mirrors
   detection latency, because it is the same test run backwards. Two changes travel with it — the
   bank restarts when an incident closes, which is Page's own procedure and the step this detector
   was missing, and an incident that resolves retires the evidence of the slices rollup had it
   standing in for.

   **It is free where it matters.** The measured detection curve is *bit-identical* at h=10, 12, 14,
   17 and 21 — every false-alarm count, every detection rate, every median and p90 latency, to the
   millisecond. That is not luck either: detection latency and the false-alarm rate are properties
   of the path out of `quiet`, and the recovery statistic does not exist there. Below the operating
   point the curve moves, and it moves *better*: at h=6 detection goes from 67% to 92%, because the
   pathology [MEASUREMENT.md](MEASUREMENT.md) describes — "a false alarm early in a run leaves the
   slice already alarmed when the real degradation arrives" — is itself a consequence of incidents
   that never close.

   **What it cost, measured rather than asserted.** Across the detection sweep's twenty opened
   incidents, cover held on a healthy rail falls from 331 to 93 minutes, and cover lost on a rail
   still at its worst rises from 0 to 10 — two trials in twenty, both the same mechanism: an alarm
   raised during a burst freezes a claim the sustained traffic never supports, the recovery test
   correctly demolishes it, and cover lapses for one detection latency until a second incident opens
   with the right claim and holds. Reading the *smallest* crossing shift rather than the leading one
   removed a third such case; it does not remove them all. That is a metric with a band, not an
   invariant, because it is not a thing that cannot happen — see
   [MEASUREMENT.md](MEASUREMENT.md#the-way-back).

   The downstream arms moved, which is the point: steering on the netbanking incident now cuts the
   loss rate by 49.8 points rather than 35.5, over a much shorter window. The recovery arm moved the
   other way — see open question 20.

20. **Acting on the true recovery edge makes more of the acting unnecessary.** Fixing question 19
   moved the recovery arm, and not the way the entry predicted. Incidents now close when the rail
   is genuinely healthy rather than hours later, so a `transient` casualty is retried on the edge
   the arm's whole timing claim is about — and incremental recovery went *down* 1.7%, messages up
   6.4%, opt-outs from 43 to 50, wasted actions up 5.2%.

   The mechanism is the same one open question 11 is about. Acting sooner after a rail heals means
   overlapping more with the customers who were coming back on their own, and incremental recovery
   subtracts exactly those. The arm is now doing what it says, and what it says is worth slightly
   less than the version that was accidentally late. Calibration improved on the same run —
   expected calibration error 1.51% → 1.33%, skill 0.237 → 0.255 — which is consistent: the
   probability model is being asked about rails whose health it can actually observe.

   The obvious response is that the spontaneous window is now tuned against a detector that no
   longer exists, and open question 13 already suspected 45 minutes was too short. Re-sweeping it
   against the fixed detector is the work, and it is not done. Until it is, the honest reading of
   the recovery figures is that they are a floor set by a parameter chosen for different behaviour.

21. **A slice that is cold when an outage starts learns the outage as its baseline.** Surfaced by
   fixing question 19, which stopped a six-hour incident from hiding it. `minObservations` stops a
   young slice *alarming*, but nothing stops it learning: `observeBaseline` folds in every attempt
   while the slice is `quiet`, and a slice that never alarms never freezes. On the console's
   `issuer-outage` the HDFC netbanking slice ends the outage with a baseline of 23.8% against a true
   9.4%, and it decays back over roughly two thousand observations — sixteen hours at that rail's
   volume. The direction is safe (it under-detects rather than over-detects) and rollup covers the
   slice throughout, but a rail that has just had an outage is exactly the one most likely to have
   another.

   The natural repair is to freeze a slice's baseline whenever an ancestor has an open incident,
   which the engine already knows and the detector does not. It was not done here because it
   changes what every covered slice learns and would re-baseline the detection curve — the thing
   this change was careful not to do. Gating the *accumulation* on `minObservations` was tried and
   rejected on measurement: it silently lost the incident entirely on two of the six console
   scenarios, because a method-level slice at 90 attempts a minute takes 35 minutes to warm up and
   both of those outages start before that.
