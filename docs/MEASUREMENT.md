# Measurement

Every number Kairos reports is produced by a seeded, reproducible experiment. This document holds
the results as they are measured, phase by phase, including the ones that are unflattering.

Reproduce with:

```sh
pnpm build
pnpm bench:detect          # detection curve, ~11s
pnpm bench:detect:quick    # reduced sweep for CI
pnpm bench:spend           # overspend under concurrency, ~3s
pnpm bench:spend:quick     # reduced sweep for CI
```

---

## Phase 1 — Detection

### What was measured

A sweep over the CUSUM alarm threshold `h`, run against simulated traffic at 400 attempts/minute
across 25 slices, using [`INDIA_PROFILES`](../adapters/simulator/src/profiles.ts) for the volume mix
and per-slice baseline failure rates.

Each threshold gets two arms:

- **Healthy arm** — 4 independent runs of 70 minutes with no degradation. Every incident opened is a
  false alarm, including ones raised during warm-up: a detector that fires while it is still
  learning is still firing.
- **Detection arm** — 6 scenarios × 4 seeds. A degradation is injected after 25 minutes of quiet
  traffic and the detector has 45 minutes to catch it.

**Detection latency is measured from the true onset injected by the simulator**, not from the
detector's own changepoint estimate. Measuring from the estimate would flatter the result by exactly
the quantity being measured. The estimate's own accuracy is reported separately as *onset error*.

### The curve

| threshold | false alarms/hr | count | detected | median latency |
|---:|---:|---:|---:|---:|
| 6 | 16.71 | 78 | 67% | 81s |
| 8 | 3.00 | 14 | 88% | 71s |
| 10 | 0.86 | 4 | 83% | 84s |
| **12** | **0.21** | **1** | **83%** | **93s** |
| 14 | 0.00 | 0 | 83% | 106s |
| 17 | 0.00 | 0 | 83% | 122s |
| 21 | 0.00 | 0 | 83% | 135s |

Two things worth reading off it.

**Low thresholds are worse in both directions at once.** At `h = 6` the detector fires 16.7 times an
hour on healthy traffic *and* detects less often than `h = 12` — because a false alarm early in a run
leaves the slice already alarmed when the real degradation arrives, so the genuine event is never
raised. Noise does not merely add cost; it destroys sensitivity.

**Above `h = 14` you pay latency for nothing.** False alarms are already zero, detection rate is
flat, and every further step just makes the system slower to react.

### Operating point

**`h = 12`**, selected as the fastest threshold within a budget of 0.25 false alarms per hour.

The budget is deliberately tight and is a product decision, not a statistical one: a false alarm
steers customers off a healthy rail and causes precisely the loss the system exists to prevent.

`h = 14` is the honest alternative — zero false alarms across the healthy arm at the cost of 13
seconds of median latency. Given that a single false alarm was observed at `h = 12` across 4.7 hours
of healthy traffic, and that steering carries a mandatory holdout that bounds the damage of a wrong
call, the faster point is defensible. It is worth revisiting once the steering arm can price a false
alarm in rupees rather than in counts.

### Per scenario at `h = 12`

| scenario | detected | median | p90 | onset error | right slice |
|---|---:|---:|---:|---:|---:|
| issuer-collapse — HDFC UPI to 55% instantly | 100% | **5s** | 6s | 1s | 100% |
| single-app — PhonePe-on-HDFC to 45% | 100% | 44s | 48s | 21s | 100% |
| issuer-moderate — SBI UPI to 22% over 2 min | 100% | 110s | 155s | 38s | 100% |
| card-network — HDFC Visa 11% → 34% | 100% | 236s | 423s | 19s | 75% |
| slow-bleed — ICICI UPI to 14% over 15 min | 100% | 413s | 480s | 203s | 100% |
| **thin-slice — Canara-on-Paytm to 50%** | **0%** | — | — | — | — |

**The headline.** A rail collapse is caught in **5 seconds**. The comparison point — the forty
minutes it typically takes a merchant to notice, investigate and act — is an industry-anecdotal
figure, not something measured here, and is quoted as an order of magnitude rather than a benchmark.

**Difficulty orders exactly as it should.** A cliff-edge collapse on a high-volume rail is
near-instant; a slow bleed to 14% on a rail whose baseline is already 2% takes seven minutes, because
that is genuinely how long it takes for the evidence to exist. Nothing here beats information theory,
and a detector claiming otherwise would be reporting noise.

**Onset error grows with ramp length.** For a cliff the changepoint estimate lands within a second of
the truth; for the fifteen-minute bleed it runs 203 seconds late. That is expected — a gradual ramp
has no sharp changepoint to find — but it means incident onset times should be read as approximate
for slow degradations, and any rupee figure attributed to the pre-detection window inherits that
error.

### The blind spot

**Kairos does not detect a degradation confined to a very-low-volume slice.**

`thin-slice` is Canara-on-Paytm at roughly 4 attempts per minute. Over 45 minutes that is ~180
attempts, of which ~90 fail. That is not enough evidence to separate a broken rail from an unlucky
run at any threshold that keeps false alarms tolerable on the other 24 slices. The detector correctly
declines to guess.

This is a real limitation, not a bug to be tuned away. What bounds it:

- If a degradation is broad, the *parent* slice carries the volume and alarms on the parent's
  evidence, so the customers on the thin slice are still protected.
- A slice this thin is a small fraction of revenue by construction, so the loss during a
  slice-specific outage is correspondingly small.
- The recovery arm still collects the casualties and retries them once the rail recovers, so the
  money is chased even where the outage was never detected as an incident.

The alternative — lowering the threshold until thin slices alarm — is what the `h = 6` row costs:
16.7 false alarms an hour, steering real customers off healthy rails, and *worse* detection overall.

### Caveats

These bind every number above.

1. **The traffic is simulated.** Volumes, method mix and baseline failure rates are modelled on
   published Indian payments behaviour, not measured from a live merchant. The detector's behaviour
   on real traffic will differ, and by how much is unknown until it sees some.
2. **The sample is small.** 24 detection trials and 4 healthy runs per threshold. Confidence
   intervals on a 0.21/hour false-alarm rate estimated from a single observed alarm are wide.
   Treat the curve's shape as informative and any individual cell as indicative.
3. **Degradations are injected one at a time.** Concurrent outages on unrelated rails are not yet
   exercised, and neither is a degradation that begins during another's recovery.
4. **`right slice` is measured only where detection happened**, so a 0% detection rate reports no
   altitude at all rather than a failure to attribute.

---

## Phase 2 — Terminus

### What was measured

A recovery campaign draining 4,000 casualties across 300 customers against a ₹500 budget, run twice
over: once through a naive check-the-budget-then-spend worker, once through the admission kernel. The
independent variable is **worker count**, swept from 1 to 64, because that is the number a deployment
changes without thinking about it.

Both arms are genuinely concurrent and both are deterministic. The microtask queue is FIFO, so a
fixed number of yields between the decision and the settlement fixes the interleaving; same seed, same
numbers, every time.

**Costs are revealed after commitment.** A message estimated at one GSM-7 segment costs three when the
model writes it in Devanagari, because UCS-2 fits 70 characters to a segment rather than 160. 35% of
messages land on the expensive script. The estimate never changes.

### Overspend against fleet size

| workers | naive spend | naive over | kernel spend | kernel over |
|---:|---:|---:|---:|---:|
| 1 | ₹500 | — | ₹499 | — |
| 2 | ₹501 | ₹1 | ₹499 | — |
| 4 | ₹505 | ₹5 | ₹498 | — |
| 8 | ₹511 | ₹11 | ₹498 | — |
| 16 | ₹524 | ₹24 | ₹498 | — |
| 32 | ₹545 | ₹45 | ₹498 | — |
| **64** | **₹600** | **₹100** | **₹498** | **—** |

The kernel column is the same number seven times. That is the entire claim: the overspend bound is
`maxInFlight × (maxActionCost − reservation)`, and neither term is the worker count, so the fleet can
grow by 64× without moving it. Reserving the worst case makes the residual exactly zero, and it is
observed to be exactly zero.

**Utilisation is not the price.** Every kernel row spends ≥99.6% of its budget. This contradicts what
§8 originally asserted — that reserving the worst case sterilises the budget — and the reason is worth
stating because it only became obvious once measured: **a reservation is released at settlement, not
consumed.** Holding ₹3 for an action that costs ₹1 returns ₹2 immediately. On a lifetime budget that
runs to exhaustion, over-reserving costs nothing except at the very tail.

### The other failure mode, which is worse

| workers | naive contacts past cap | kernel |
|---:|---:|---:|
| 1 | 0 | 0 |
| 2 | 138 | 0 |
| 8 | 224 | 0 |
| **64** | **271 of 346 sent** | **0** |

At 64 workers the naive arm delivers **271 messages past the three-per-seven-days cap** — 78% of
everything it sends. The money bug costs a merchant ₹100. This one is a regulatory complaint, and it
appears at *two* workers, long before the budget race is visible at all.

It is also nearly invisible if measured carelessly. The naive arm's own contact counter is corrupted
by the same race it is meant to catch: two workers that both read `seen = 0` also both write `1`, so
the map ends up claiming one contact for a customer who received several. Counting violations from
that structure reports zero for a run full of them. The harness counts what was actually delivered
instead, in a separate tally with no await between the send and the increment.

### Two bugs, not one

Check-then-spend fails in two independent ways, and only one of them is about concurrency.

**Cost uncertainty** breaks it single-threaded: the check prices the action at its estimate and the
spend books the actual, so the last message through the gate overspends by up to
`maxActionCost − estimate`. One worker, ₹2 over. No amount of locking fixes this one.

**The race** is what turns ₹2 into ₹100. And the overshoot is roughly `workers × maxActionCost`, which
is an *absolute* quantity — so it is a 20% breach on a ₹500 campaign and a **185% breach on a ₹60
one**, with the same 64 workers. Small campaigns are where it is fatal, and small campaigns are what a
merchant runs first.

### Does learning the reservation earn its place?

§8 flagged `learnedReservation` as the component most at risk of being machinery for its own sake and
committed to cutting it if the gap was negligible. Two sweeps, both searching for the configuration
where a smaller reservation gets more work done.

Budget tightened toward the in-flight reservation total (8 in flight × ₹3 = ₹24 held at once):

| budget | worst-case | estimate | learned | predictive |
|---:|---:|---:|---:|---:|
| ₹30 | — | +12.5% *(₹2 over)* | **+6.3%** | **+6.3%** |
| ₹60 | — | +6.3% *(₹2 over)* | +0.0% | +0.0% |
| ₹125 | — | +0.0% | +1.4% | +1.4% |
| ₹250 | — | +0.7% *(₹3 over)* | +0.0% | +0.0% |
| ₹500 | — | +0.4% *(₹1 over)* | +0.0% | +0.0% |

Cost mix swept across the point where the newsvendor optimum leaves the ceiling:

| share at ceiling | learned lift | learned's smallest reservation |
|---:|---:|---:|
| 2% | +1.9% | ₹0.92 |
| 5% | +1.9% | ₹0.92 |
| 10% | +4.1% | ₹0.92 |
| 20% | +2.3% | ₹1.05 |
| 35% | +0.0% | ₹1.51 |
| 60% | +0.0% | ₹1.51 |

**The verdict is no.** The learner buys between 0% and 6.3% more messages, and gives up the only
overspend bound that is exactly zero — ₹11.92 against ₹0 at the measured configuration. For a kernel
whose entire claim is a provable ceiling, that is a poor trade.

The reason it wins so little is the more interesting half. With an overrun priced at four times a
needless hold, the newsvendor optimum sits at the 80th percentile of realised cost. When more than a
fifth of messages cost the ceiling, the 80th percentile *is* the ceiling — so the learner's correct
answer is to reserve the worst case, and it converges there. The two rows of `+0.0%` at 35% and 60%
are not the learner failing. They are the learner working, and finding that there was nothing to find.

It stays behind the `Sizer` interface, because deleting it would make this table unreproducible, and
because that interface is what made the comparison a one-line swap rather than an argument. The kernel
defaults to reserving the worst case.

Note also what the `estimate` column is doing: it buys its lift by **overspending**, in four cells out
of five. Trusting your own quote is not a cheaper form of safety, it is the absence of it.

### Compliance, asserted over the ledger

Across all 28 kernel runs: **28/28 audit chains verify**, **0 orphaned reservations**, **0 contact-cap
violations**, **0 refusals on the `audit` axis**. Every admission — allowed or refused — carries a
named binding axis, so the ledger answers "why did nothing happen for this customer?" directly rather
than by inference from an absence of activity.

### Caveats

1. **The concurrency is cooperative, not parallel.** Workers interleave on one thread at await
   points. That is a faithful model of Node's actual execution and of the interval between deciding
   and settling, but it is not multi-process contention against Redis. The atomicity the bound rests
   on is ThrottleKit's, proven bit-identical across backends; what is *not* yet measured is this same
   experiment against a real shared store.
2. **Costs are drawn from a two-point distribution**, one segment or three. Real SMS pricing has more
   mass in between and gateway fees have their own shape. The bound does not depend on the
   distribution, but the utilisation and lift numbers do.
3. **The naive arm is a fair implementation, not a strawman** — it checks the budget, respects a
   contact cap, and stops when the budget is spent. It is what careful code looks like before anyone
   has thought about the interval between the check and the spend. It is not, however, the *best*
   naive implementation: a single-process worker behind a mutex would fix the race and still lose to
   cost uncertainty.
4. **Reservation TTL is never exercised.** No action in this experiment outruns its 60-second
   reservation, so the orphan-settlement path — where money moves after its authority has lapsed — is
   covered by unit tests but not by the sweep. It needs real action durations, which arrive in
   Phase 4.

---

## Phase 3 — Prevention

### What was measured

Five degradations, each run end to end with detection, steering and a 10% holdout live, at 400
attempts a minute for 65 minutes. Customers arrive with a preferred rail, are shown whatever their
arm entitles them to, and choose accordingly. Whatever they end up paying with is what the detector
observes — so steering changes the evidence the next steering decision is made on, which turns out
to matter a great deal.

The scenario set is chosen so the answers can differ: precisely suppressible, addressable only by
demoting a whole method, and one the policy ought to refuse outright.

### The break-even, before any of it runs

The failure rate at which a steer becomes worth making is not a tuning parameter. It falls out of the
traffic mix, and it is very different depending on what Checkout can name.

| Slice | Lever | Break-even failure rate |
|---|---|---:|
| `card/hdfc/visa` | suppress | 13.5% |
| `netbanking/hdfc` | suppress | 15.0% |
| `wallet/paytm` | suppress | 16.0% |
| `upi` (whole method) | demote | 11.5% |
| `upi/hdfc` | demote | **26.5%** |
| `upi/sbi` | demote | **33.0%** |
| `upi/hdfc/phonepe` | demote | 46.5% |
| `upi/canara/paytm` | demote | **never** |

UPI fails around 2% and cards around 12%. That gap is the whole story: a UPI *issuer* has to be more
than twice as bad as a precisely-addressable rail before demoting the whole method pays for the
healthy users it drags along, and a UPI slice carrying 0.4% of volume is never worth demoting a
quarter of the checkout's traffic for, at any severity. See
[ADR 0002](decisions/0002-two-steering-levers-because-checkout-cannot-see-a-upi-issuer.md).

### Lift, decomposed by who was exposed

Three populations, because one number would hide the trade. **Exposed** is customers whose preferred
rail was the one degrading. **Collateral** is customers on the same method whose own rail was fine
and who were moved anyway. Restricting to the exposed is a legitimate subgroup rather than a
flattering one: preference is drawn before treatment and is independent of arm, so both arms are
filtered identically.

| scenario | who | control loss | treated loss | delta | 95% CI | real? |
|---|---|---:|---:|---:|---:|---|
| `card/hdfc/visa` → 40%, **suppressed** | exposed | 40.74% | 12.14% | **+28.60%** | ±13.36% | yes |
| | collateral | 18.44% | 13.13% | +5.30% | ±5.93% | noise |
| | overall | 6.46% | 4.92% | +1.54% | ±1.39% | yes |
| `upi/hdfc` → 55%, **demoted** | exposed | 50.00% | 36.78% | **+13.22%** | ±6.12% | yes |
| | collateral | 4.33% | 6.18% | **−1.85%** | ±1.78% | **harmful** |
| | overall | 16.81% | 14.47% | +2.34% | ±2.22% | yes |
| `upi` → 30%, **demoted** | exposed | 26.63% | 22.25% | +4.38% | ±2.97% | yes |
| | overall | 22.14% | 18.96% | +3.19% | ±2.38% | yes |
| `upi/hdfc` → 14% | — | *no steer issued* | | | | |
| `netbanking/hdfc` → 45% | exposed | 32.00% | 15.08% | +16.92% | ±18.70% | noise |

**Suppression is clean.** Removing a broken card instrument cuts the exposed group's loss rate from
41% to 12%, and the collateral column is consistent with zero — which is what "precisely
addressable" means arithmetically: nobody else's checkout changed.

**Demotion is not free, and the harness says so.** Demoting UPI to deal with one issuer's outage
helps the exposed group by 13 points and **measurably harms the bystanders by 1.85 points**, because
the healthy UPI users it nudges land on cards, which fail six times as often. The net is positive and
the cost is real. It is reported rather than netted away, because a merchant is entitled to know that
the remedy has victims.

**Declining is a result.** The 14% UPI scenario produces no steer at all — the destination rails are
no better than the failing one, so there is nowhere to send anyone. A system that steered anyway
would be causing the loss it exists to prevent.

**The netbanking row is not a measurement.** That rail carries 2.3% of volume, so a 10% holdout over
35 minutes yields 25 control observations, and an interval of ±18.7 points around a 16.9-point
difference concludes nothing. That is [§18](ARCHITECTURE.md) question 3 made concrete rather than
theoretical, and the arithmetic is worth stating: the control arm accumulates roughly
`holdout × railShare × attemptsPerMinute × minutes` observations, so measuring a 2% rail at a 10%
holdout needs either hours or pooling across incidents.

### When the assumption about customers is wrong

Steering rests on a belief nothing in a simulator can supply: how many people take the newly-promoted
option instead of hunting for their usual one. The policy holds 0.35. Below, only the customers
change.

| customers actually switch | exposed delta | real? | collateral delta | real? |
|---:|---:|---|---:|---|
| 5% | +3.21% | noise | +0.46% | noise |
| 20% | +11.63% | yes | −1.55% | harmful |
| 35% *(as believed)* | +13.22% | yes | −1.85% | harmful |
| 60% | +24.70% | yes | −4.24% | harmful |
| 90% | +37.91% | yes | −5.55% | harmful |

The benefit and the harm both scale with elasticity, and the ratio stays favourable throughout — the
policy is not fragile to this assumption in the direction that would matter most, which is being
wrong about whether to steer at all. What it *is* wrong about is magnitude: at 90% elasticity it does
three times the collateral damage it priced. **The assumed elasticity is a safety parameter, and
under-estimating it means under-estimating the harm being done to bystanders.** A live deployment
could measure it from its own funnel, and should.

### Three corrections the measurement forced

**The detector's altitude is the wrong one to act at.** Rollup reports the coarsest slice that
explains an outage, which is right for raising one alarm instead of four hundred and wrong for
acting: an incident reported on `netbanking` cannot be suppressed precisely, while the
`netbanking/hdfc` inside it can. Steering now prices every candidate inside the incident and takes
the best. The first version of that search nominated a small *healthy* slice as the target, because
doing so sweeps the broken traffic into the collateral term where moving customers off it reads as a
benefit — the arithmetic came out right and the reported target was nonsense.

**A steer must be justified by the people it was called for.** The collateral term can be positive on
its own, since a chronically poor method's healthy users may be better off elsewhere. Left
unconstrained, that alone was enough to justify demoting a merchant's netbanking for half an hour
because one bank had a blip.

**A steer contaminates the estimate that justifies it.** The moment traffic leaves the failing rail
the evidence disappears, the rail looks healthy, the steer is withdrawn, and traffic returns to a rail
that is still broken. The blended estimate cannot see through its own intervention. The holdout can:
control-arm customers go on using the failing rail throughout, so their outcomes measure the world in
which nothing was done. **The control group is load-bearing for stability, not only for
measurement** — which is a second, independent reason to pay for one.

The repair is partial. Rate is read from the control arm; *volume* is not, so a suppressed rail's
apparent share collapses to the holdout fraction and the modelled benefit shrinks with it. The
direction is safe — the contamination makes the system under-steer, never over-steer — but on a thin
rail it is enough to make the lever flip from suppression to demotion mid-incident.

### Compliance

Across all ten runs: **10/10 audit chains verify**, **10/10 kept the incident open through the peak**
of the degradation, and no steer exceeded the configured blast radius. Every admission — including
every refusal — carries a named binding axis.

### Caveats

1. **Customer behaviour is a model, not an observation.** Both elasticity and abandonment are
   invented. They are swept rather than assumed, but the absolute lift figures inherit them entirely.
2. **Not verified against a live Razorpay Checkout.** The rendered configuration is checked against
   the documented schema in tests, not against a rendered page. `show_default_blocks: false` with a
   bare-method sequence is the specific behaviour most worth confirming.
3. **One incident at a time.** Concurrent outages on unrelated rails, and the interaction between two
   simultaneous steers competing for the same blast-radius budget, are not exercised.
4. **The rupee totals are the least trustworthy numbers here.** They multiply a measured loss-rate
   difference by a simulated amount distribution. The loss-rate deltas and their intervals are the
   results; the rupee figures are illustrations of them.

---

## Phase 4 onward

Not yet measured. Recovery rate against baselines, calibration of `p(recover)`, and false-positive
cost in rupees land with their phases.
