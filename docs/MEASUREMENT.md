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
pnpm bench:prevent         # steering lift against a holdout
pnpm bench:prevent:quick   # reduced sweep for CI
pnpm bench:recover         # recovery against a control arm and three baselines, ~25s
pnpm bench:recover:quick   # reduced sweep for CI

pnpm bench:scorecard       # all four arms, consolidated, ~29s
pnpm bench:gate            # the same at gate size, judged against the committed baseline, ~15s
pnpm bench:variance        # how far each number moves when only the seed changes, ~2min
pnpm bench:bless           # rewrite the baseline. Never widens a band.
```

All of the above run offline and need no credential. One thing in this document does not, and it is
run by a person rather than by a machine:

```sh
cp .env.example .env       # then fill in GOOGLE_API_KEY
pnpm --filter @kairos/scribe run compose   # regenerate the copy library, ~180 calls, ~10 minutes
```

---

## Phase 1 — Detection

### What was measured

A sweep over the CUSUM alarm threshold `h`, run against simulated traffic at 400 attempts/minute
across 25 slices, using [`INDIA_PROFILES`](../adapters/simulator/src/profiles.ts) for the volume mix
and per-slice baseline failure rates.

Each threshold gets two arms:

- **Healthy arm** — 12 independent runs of 70 minutes with no degradation, 14 hours in total. Every
  incident opened is a false alarm, including ones raised during warm-up: a detector that fires
  while it is still learning is still firing. This arm was 4 runs when the curve below was first
  published and the count was raised in Phase 5 to give the rate a denominator it could be resolved
  against; the table has been regenerated at the current size.
- **Detection arm** — 6 scenarios × 4 seeds. A degradation is injected after 25 minutes of quiet
  traffic and the detector has 45 minutes to catch it.
- **Resolution arm** — the same 6 scenarios × 4 seeds, watched for 90 minutes *past* the moment the
  rail is healthy again. Its own window rather than a longer shared one, because stretching the
  detection window would move the healthy arm's denominator and the detection arm's deadline with
  it — re-baselining two published measurements in order to add a third.

**Detection latency is measured from the true onset injected by the simulator**, not from the
detector's own changepoint estimate. Measuring from the estimate would flatter the result by exactly
the quantity being measured. The estimate's own accuracy is reported separately as *onset error*.

### The curve

| threshold | false alarms/hr | count | detected | median latency |
|---:|---:|---:|---:|---:|
| 6 | 16.29 | 228 | 92% | 68s |
| 8 | 3.07 | 43 | 88% | 71s |
| 10 | 0.79 | 11 | 83% | 84s |
| **12** | **0.14** | **2** | **83%** | **93s** |
| 14 | 0.00 | 0 | 83% | 106s |
| 17 | 0.00 | 0 | 83% | 122s |
| 21 | 0.00 | 0 | 83% | 135s |

Two rows moved since this table was first published, for two unrelated reasons, and both are worth
separating. Every false-alarm figure changed when the healthy arm grew from 4 runs to 12 — the same
detector, a bigger denominator, which is why `h = 12` reads 0.14 here and 0.21 in older text. The
`h = 6` row changed because of the fix described in [the way back](#the-way-back); see the note
under **low thresholds** below. Everything at `h = 10` and above is otherwise untouched, and the
per-scenario table further down is identical to the cell.

Two things worth reading off it.

**Low thresholds are worse in both directions at once — and they used to look worse still.** At
`h = 6` the detector fires 16.3 times an hour on healthy traffic, which is 116× the operating
point's rate for 25 seconds of latency. It also *used* to detect less often than `h = 12`, at 67%,
because a false alarm early in a run left the slice already alarmed when the real degradation
arrived and the genuine event was never raised. That symptom is gone — `h = 6` now detects 92% —
because an incident that closes on time stops occupying the slice. The underlying trade did not
change: noise still costs, it simply no longer destroys sensitivity as well. The operating point is
chosen on the false-alarm rate regardless, and 16 an hour is not a rate anybody can leave running.

**Above `h = 14` you pay latency for nothing.** False alarms are already zero, detection rate is
flat, and every further step just makes the system slower to react.

### Operating point

**`h = 12`**, selected as the fastest threshold within a budget of 0.25 false alarms per hour —
0.14 measured, two alarms across 14 hours of healthy traffic.

The budget is deliberately tight and is a product decision, not a statistical one: a false alarm
steers customers off a healthy rail and causes precisely the loss the system exists to prevent.

`h = 14` is the honest alternative — zero false alarms across the healthy arm at the cost of 13
seconds of median latency. Given that two false alarms were observed at `h = 12` across 14 hours of
healthy traffic, and that steering carries a mandatory holdout that bounds the damage of a wrong
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

### The way back

**How long an incident outlives the outage that opened it.** At `h = 12`:

| | median | p90 | resolved | held at peak | cover lost |
|---|---:|---:|---:|---:|---:|
| before | 576s | 1440s | 19/20 | 20/20 | 0 |
| **now** | **150s** | **949s** | **20/20** | **20/20** | **2** |

Across the whole sweep, and per scenario at the operating point:

| threshold | resolved | median | p90 | held at peak | cover lost |
|---:|---:|---:|---:|---:|---:|
| 6 | 15/24 | 4948s | 5359s | 17/24 | 13 |
| 8 | 19/24 | 3210s | 5164s | 16/24 | 10 |
| 10 | 20/23 | 132s | 1922s | 17/23 | 6 |
| **12** | **20/20** | **150s** | **949s** | **20/20** | **2** |
| 14 | 20/20 | 142s | 639s | 19/20 | 1 |
| 17 | 20/20 | 183s | 748s | 19/20 | 2 |
| 21 | 20/20 | 273s | 749s | 20/20 | 0 |

| scenario | opened | resolved | median | p90 | cover lost |
|---|---:|---:|---:|---:|---:|
| issuer-collapse | 4/4 | 4 | 114s | 116s | 0 |
| issuer-moderate | 4/4 | 4 | 66s | 303s | 1 |
| slow-bleed | 4/4 | 4 | 262s | 407s | 0 |
| single-app | 4/4 | 4 | 150s | 153s | 0 |
| thin-slice | 0/4 | — | — | — | 0 |
| card-network | 4/4 | 4 | 762s | 1174s | 1 |

**The low thresholds are bad at this too**, and worse than they are at detecting. At `h = 6` nine of
twenty-four incidents never close at all and thirteen lose cover mid-outage — a detector alarming
sixteen times an hour spends its whole time opening and abandoning incidents. That the resolution
column degrades in the same direction as the false-alarm column is a useful consistency check: they
are measuring the same thing going wrong.

Both rows are measured the same way, at the same threshold, on the same seeds. A resolution latency
is only recorded for a trial where the incident actually outlived the outage: where cover ended
*before* the rail healed, the difference is negative, and folding a negative into this median would
shrink the headline for the one reason that is not an improvement. Those trials appear in
`cover lost` instead.

This arm did not exist until [open question 19](ARCHITECTURE.md#18-open-questions) was closed, and
its absence is the reason that question survived five phases: the sweep above could report a
93-second median detection latency while the same detector held incidents open for six hours, and
nothing in this repository disagreed with either number. It took building a console to notice.

**The defect.** After a rail heals, statistic `i` drifts at `−KL(p₀ ‖ p₀+δᵢ)`, which is monotone
increasing in δ. The bank reports its maximum, so the alarm was governed by the fastest riser and
the clear by the *slowest faller* — always the most sensitive shift in the bank, whose entire job is
to be slow. Sensitivity and resolution latency were coupled through a quantity nobody chose. On the
console's four-hour run, δ=0.18 and δ=0.40 were back at zero within forty minutes of the rail
recovering; δ=0.03 was still at 3.63 six hours later and kept the incident open on its own.

**The repair.** Closing has its own statistic — the same Bernoulli log-likelihood ratio with `p₀`
and `p₁` exchanged, accumulating evidence for "the rate is back at baseline" against "it is still
at the rate the alarm was raised on". It runs only while an incident is open, which is what makes
it unable to touch anything above: detection latency and the false-alarm rate are properties of the
path out of `quiet`, and this statistic does not exist there.

**The curve did not move.** At `h = 10, 12, 14, 17` and `21` every figure in the tables above is
bit-identical before and after — false-alarm counts, detection rates, medians and p90s, to the
millisecond. Below the operating point it does move, and it moves better: `h = 6` goes from 67% to
92% detected, because "a false alarm early in a run leaves the slice already alarmed when the real
degradation arrives" is itself a symptom of incidents that never close.

**What it cost.** Two of twenty trials lose cover while the rail is still at its worst, against zero
before. Both are the same mechanism: a burst of failures pushes the most aggressive statistic across
the threshold first, so the alarm freezes a claim the sustained traffic never supports — on
`card-network`, an incident opened saying the rail had gone from 12% to 52% while it was running at
19%. The recovery test demolishes that in under four minutes, correctly, and cover lapses for one
detection latency until a second incident opens with the right claim and holds. Freezing the
*smallest* crossing shift rather than the leading one removed a third such case; it does not remove
them all.

Totalled across the sweep's twenty incidents, the trade is **331 minutes of steering a healthy rail
down to 93**, against **0 minutes of not steering a broken one up to 10**. It is reported as a
banded metric rather than an invariant because it is not a thing that cannot happen.

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
2. **The sample is small.** 24 detection trials and 12 healthy runs per threshold. Confidence
   intervals on a 0.14/hour false-alarm rate estimated from **two** observed alarms are wide — wide
   enough that the honest reading is "roughly one an evening", not two decimal places. Treat the
   curve's shape as informative and any individual cell as indicative. The same applies with more
   force to the resolution arm's `cover lost` column, which is two events out of twenty.
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

## Phase 4 — Recovery

### What was measured

`pnpm bench:recover`. Four hours of simulated Indian traffic at 300 attempts a minute with two
injected outages, producing **5,556 casualties worth ₹48,04,504**, then worked for forty days.

Four arms over the same population, the same seed and the same simulated world, so a casualty's fate
under no intervention is the same fact in all of them. The baselines are given every advantage that
is not the point of the comparison — the same Terminus mandate, budget, contact cap, and a message
deferred rather than dropped when it lands in quiet hours. They are denied only Kairos's
classification, which a naive ladder has not done and must not benefit from.

Kairos schedules on what **its own detector** believes, not on the ground truth the harness holds.
Anything else would measure a system that already knows when rails break.

### What the casualties are made of

| Class | Casualties | Share |
|---|---:|---:|
| `transient` | 2,684 | 48.3% |
| `customer-retry` | 1,158 | 20.8% |
| `timed` | 1,057 | 19.0% |
| `customer-action` | 424 | 7.6% |
| `dead` | 233 | 4.2% |

Nothing fell through to `unknown`, which is the minimum bar for the measurement to mean anything: a
classifier that could not name the failures in our own traffic model would be measuring its fallback.

**Only 12.0% of these payments can be charged again without the customer being present.** The class
the recovery-edge idea exists for is 48% of the casualties; the operation it describes is available
on an eighth of them. See
[ADR 0004](decisions/0004-a-retry-is-only-free-when-the-customer-is-not-needed.md).

### The comparison

| Arm | Recovered | Incremental | Postage | Lost | True cost | Messages | Retries | Wasted |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| do nothing | ₹11,39,929 | — | ₹0 | 0 | ₹0 | 0 | 0 | 0 |
| chronos ladder (+1h, +24h, +72h) | ₹17,23,935 | ₹5,84,006 | ₹2,095 | 132 | ₹28,495 | 10,681 | 0 | 731 |
| message everyone, immediately | ₹12,80,665 | ₹1,40,736 | ₹1,085 | 67 | ₹14,485 | 5,544 | 0 | 756 |
| kairos + template copy | ₹17,53,772 | ₹6,13,843 | ₹852 | 58 | ₹12,452 | 5,817 | 251 | 746 |
| **kairos + generated copy** | **₹18,21,998** | **₹6,82,069** | **₹851** | **54** | **₹11,651** | 5,749 | 251 | 746 |

Regenerated at `5cfa489`. The copy this table carried before Phase 5.75 was a mix of two eras — its Kairos
row had been refreshed when the fifth arm arrived in Phase 5.75 and its baseline rows had not, so it
reported a ladder that no configuration in the repository produces. That is [open question
16](ARCHITECTURE.md#18-open-questions) again: nothing re-runs the full profile, so it drifts, and it
drifted here in the most misleading possible direction — the comparison got easier without anybody
choosing to make it easier.

**`incremental` is recovery minus what the do-nothing arm collected**, and it is the column no
dunning dashboard shows. The do-nothing arm recovered ₹11.4 lakh with no help at all — 24% of the
lost money simply came back — so a system reporting gross recovery would be reporting the customer's
own behaviour and billing for it.

`true cost` adds the priced value of every customer lost to an opt-out, at ₹200 each. That figure is
derived rather than measured — a customer with two failed payments a year, a 30% margin and a fifth
recovery rate is worth roughly ₹150 a year in recoveries, so a few years of consent is a couple of
hundred rupees — and it is the term that dominates. Postage is almost free; consent is not.

### The result, stated the way it came out

**On templates, Kairos recovers about 3% less than the fixed ladder.** Brute force works: messaging
every casualty three times finds money that thinking about it does not.

It works by sending **2.0× the messages** and costing **155 customers their consent rather than 67**.
Priced, that is **133% more true cost** for 3% more revenue. The claim worth making on this row is
that Kairos matches brute force at well under half the damage — not that it beats it. With generated
copy it does beat it, on both counts at once, and that is the [Phase 5.75
result](#the-result) rather than this one.

The immediate-blast arm is the useful control on the other side: one message to everyone, at once,
recovers only ₹1.41 lakh incremental against the ladder's ₹6.41 lakh. Timing is most of what the
ladder is doing, and most of what Kairos improves on.

### The spontaneous window, which reversed

The window exists on the argument that a nudge ninety seconds after a cancelled payment is mostly
paid for by people already reaching for another card — so waiting trades recovery for restraint.

| Window | Incremental | Messages | Wasted | Opt-outs | True cost |
|---|---:|---:|---:|---:|---:|
| none | ₹5,16,393 | 6,583 | 1,093 | 42 | **₹9,094** |
| 5 min | ₹5,78,793 | 6,136 | 1,024 | 65 | ₹13,959 |
| 15 min | ₹5,89,826 | 6,081 | 931 | 64 | ₹13,634 |
| **45 min** (default) | **₹6,21,443** | 6,221 | 770 | 67 | ₹14,373 |
| 120 min | ₹6,12,956 | **5,514** | **537** | 55 | ₹11,851 |

**Measured at `f163eb1` and not re-run since.** Its default row therefore no longer matches the
comparison above, which was regenerated at `5cfa489`. The rows are still comparable *with each
other*, which is the only comparison this table is for; re-sweeping is open question 13.

**There is no trade.** Wasted actions fall monotonically with the window and incremental recovery
does not fall with them, because the two mechanisms point the same way: a customer who returns
unaided closes their own casualty and never costs a message, and a transient casualty asked later is
asked when its rail is likelier to have healed. Waiting two hours rather than none sends 16% fewer
messages, wastes 51% fewer of them, and recovers 19% more.

**The default is now at the peak of this curve**, which it was not when the window was chosen — and
that is a coincidence rather than tuning, because nothing about the window changed. The detector did:
closing [open question 19](ARCHITECTURE.md#18-open-questions) moved every row, and 45 minutes came
out on top of the one that matters. It is still worth re-sweeping, because the difference between 45
and 120 is ₹8,487 on a quantity whose eight-seed standard deviation is ₹38,973 — which is to say the
peak is not resolvable and this table cannot pick between the middle three rows. See [open question
13](ARCHITECTURE.md#18-open-questions).

The 45-minute default was chosen before this table existed and the sweep says it is too short. It was
left alone rather than tuned to one run, because the opt-out counts are noisy enough that the
cheapest row is not stable — see open question 13.

### Calibration

6,472 predictions. **Expected calibration error 1.3%**, Brier 0.1244, skill score 0.255.

| Predicted | n | Mean p | Actual | Gap |
|---|---:|---:|---:|---:|
| 0–10% | 1,418 | 5.8% | 4.7% | −1.1 |
| 10–20% | 1,594 | 13.7% | 11.9% | −1.8 |
| 20–30% | 818 | 24.7% | 23.8% | −0.9 |
| 30–40% | 505 | 37.6% | 37.8% | +0.2 |
| 40–50% | 1,379 | 42.5% | 40.6% | −1.9 |
| 50–60% | 18 | 57.9% | 83.3% | +25.5 |
| 60–70% | 9 | 64.1% | 66.7% | +2.5 |
| 70–80% | 2 | 73.4% | 50.0% | −23.4 |
| 80–90% | 5 | 84.3% | 100.0% | +15.7 |
| 90–100% | 220 | 94.9% | 99.1% | +4.2 |

The gate multiplies this probability by a rupee amount, so the property that matters is not accuracy
but whether 30% means thirty per cent. It is within two points across every bin carrying real volume.

The four middle bins are worthless — nine, two and five predictions — and are shown rather than
hidden, because a calibration curve with its thin bins removed is a curve chosen after seeing the
answer. The 90–100% bin is the autonomous retries fired on a healed rail, which is exactly the
population the model should be nearly certain about.

The skill score sits beside the calibration error because a model that repeats the base rate for ever
is perfectly calibrated and worth nothing.

### The recovery control arm

**2,172 casualties held out of treatment entirely**, of which **₹5,56,747 came back unaided**.

That population costs real recovered revenue and is the only reason any number above has a
denominator. It answers open question 11.

### Compliance

The audit chain verifies and every admission, allowed or refused, carries a named binding axis. In
this run Kairos was refused on **no axis at all** — an earlier version was refused 233 times on quiet
hours, which turned out to be a defect rather than a bound doing its job: the worker acted whenever
the store said a casualty was due, without re-checking the schedule, so it proposed messages at three
in the morning that Terminus then had to decline. Deferring reaches the same outcome without the
wasted pass. The bounds themselves are measured under contention in Phase 2, not here.

### Caveats

1. **Customer behaviour is a model, not an observation** — the same caveat as prevention, and it
   binds harder here. Spontaneous return rates, nudge uplift, opt-out rates and how quickly somebody
   replaces an expired card are all invented. Their *ordering* is defensible — a customer who
   cancelled ninety seconds ago is standing at a checkout, one whose card expired is not — and their
   levels are guesses.
2. **The opt-out cost is derived, not measured**, and it decides the whole comparison. At ₹0 the
   fixed ladder wins outright; at ₹200 Kairos wins on cost and loses on revenue; at ₹1,000 Kairos
   wins on both. A merchant with a real churn model would get a real answer, and this one is stated
   where it can be argued with.
3. **No live gateway or messenger.** The decision path, the composition, the segment counting and the
   cost accounting are real. The final network call is not made by anything in this repository, and
   the worker ships in dry-run delivery for that reason.
4. **One merchant shape.** 14% of payments mandated. A subscription business would get a recovery arm
   that is nearly free to run and a very different table.
5. **The rupee totals are the least trustworthy numbers here**, for the same reason as in prevention:
   they multiply modelled recovery rates by a simulated amount distribution. The *ratios* between
   arms are the result; the absolute figures illustrate them.

---

## Phase 5 — Proof

### What is measured, and what kind of thing it is

Every claim in this document is now one of two things, and the difference decides how it is checked.

An **invariant** has no sampling distribution. Spend either exceeded the budget or it did not; the
chain either hashes or it does not. There are seventeen, they are checked exactly, and none of them
has a tolerance — putting one on "the kernel did not overspend" would be saying it may overspend a
little.

A **metric** is an estimate and carries a band. There are twenty-one. The band is not a judgement
call: `pnpm bench:variance` holds the code still, varies only the seed, and measures how far each
number wanders. That spread is the size of a *meaningless* change — because a code change that
consumes randomness differently has, for a seeded benchmark, done exactly what changing the seed
does — so three standard deviations of it lets an innocent refactor through and stops a real
regression.

Two bands are not derived and say so in the file. The false-alarm rate takes the 0.25-an-hour budget
the detection report already declares, because the project has said what it will tolerate and a
second number invented for the gate would be a second opinion. The detection rate takes one trial
out of the eighteen the gate runs, because its spread across eight seeds was exactly zero and a band
of zero would fire the first time any scenario went the other way.

The reasoning is in
[ADR 0005](decisions/0005-a-benchmark-that-reproduces-exactly-still-needs-a-band.md).

### The full scorecard

`docs/results/scorecard-full.{txt,json}`, config `1715c07b4cfff993`.

| | Full profile |
|---|---:|
| Detection latency, median, at `h=12` | **1.5 min** |
| False alarms per hour of healthy traffic | **0.143** |
| Degradations detected | 83.3% |
| Incidents reported at the right slice | 79.2% |
| Resolution latency, median | **2.5 min** |
| Resolution latency, p90 | 15.8 min |
| Incidents open at the worst moment of their outage | 100% |
| Trials where cover lapsed mid-outage | 2 of 20 |
| Overspend, reserving the worst case | **₹0** |
| Overspend, adaptive sizers, bounded | ₹7 |
| Loss rate avoided, suppressible incident | **49.8%** |
| Loss rate avoided, demotable incident | 11.0% |
| Recovered above what came back unaided | **₹6,13,843** |
| True cost of recovering it | ₹12,452 |
| Calibration error | **1.84%** |
| Brier skill over the base rate | 0.252 |

The previous published copy of this table was generated at revision `28ffd73` and had been overtaken
by three phases of work before anything noticed — which is [open question
16](ARCHITECTURE.md#18-open-questions) happening rather than being hypothesised about. Nothing
re-runs the full profile, so it drifted — and it drifted a second time between `f163eb1` and
`5cfa489`, which is the same gap happening again on a shorter timescale. The figures above were
regenerated at `5cfa489`, at which they reproduce exactly.

Four rows moved for a reason worth stating plainly, and it is not the detector's accuracy: closing
[open question 19](ARCHITECTURE.md#18-open-questions) made incidents end when the rail is actually
healthy. Steering on the netbanking incident now avoids 49.8 points of loss rather than 35.5, over a
much shorter window. Recovery moved the other way — the arm now retries on the true recovery edge,
which overlaps more with the customers who were coming back unaided, so incremental recovery falls
1.7% and cost rises. That is [open question 20](ARCHITECTURE.md#18-open-questions), and the
recovery arm's own comparison below has not been re-tuned against it.

### How much the gate is actually worth

**Eight of twenty-one bands are wider than the value they guard**, and the gate prints which. Those
catch a claim breaking, not a claim degrading, and a reader who sees PASSED is owed that distinction
rather than left to assume the sheet is uniform. The tight ones are the ones worth trusting:
recovery's incremental total is gated at ±14% of itself, messages at ±16%, actions under contention
at ±17%.

The gate profile is deliberately not the smallest one that runs. Every size in it was raised until
the seed study said the headline numbers could be told apart from noise — the recovery total's
spread fell from 12% of its mean to 4%, and calibration error from 5.7% to 1.9%, which is where the
full profile lands. That cost about fifteen seconds of CI, which is a low price for bands that mean
something.

### What measuring it found

The point of a study like this is the things it says that you did not already believe. There were
five, and each changed the code rather than the write-up.

1. **The overspend claim was wrong.** The scorecard first asserted that the kernel never spends past
   the budget. It spends ₹8 past it. Reserving the worst case cannot overspend — that is gated at
   exactly zero — but the adaptive sizers deliberately reserve *less* in order to fit more actions
   into the same budget, and what they buy is a bounded residual, not the absence of one. Gating
   them at zero would have been a lie or a ban on the feature. They are two claims now.
2. **The prevention scenarios existed in two places.** Onsets transcribed ten minutes late pushed a
   degradation's peak past the end of the gate's window, and `detectionHeld` went false for a reason
   that had nothing to do with the detector. They live in one file now.
3. **A budget was being checked against a measurement that could not resolve it.** The gate observed
   fifty minutes of healthy traffic, in which a single false alarm reads as 1.2 an hour — five times
   the declared budget. The answer to a rate you cannot resolve is more denominator rather than a
   wider band, so the healthy arm got its own sample-size knob and now runs nearly seven hours per
   threshold.
4. **A scenario was dropped for being unmeasurable, and then rescued.** HDFC netbanking's steering
   window saw single-digit treated attempts and its lift varied across seeds by almost its own mean.
   A band honestly derived from that is a hundred percentage points, which no regression could
   cross. The gate profile was made large enough to resolve it instead — spread fell from 97% of the
   mean to 20%.
5. **An invariant was true by luck.** Lever changes were zero on all eight seeds, so they were
   promoted to a claim: the steering lever never changes mid-incident. Then the full profile returned
   three, and was right to — over forty-five minutes an incident ramps, peaks and recovers, and the
   lever that suits a rail failing at 20% is not the one that suits it at 45%. A study run at one
   size cannot tell you that. It is a metric again, and its band guards what was worth guarding,
   which is flapping rather than change.

### Caveats

1. **The gate runs one seed.** It has to: a gate that re-rolls its own dice is not reproducible. The
   bands make it survive a re-roll, which is not the same as measuring across many.
2. **The bands are as good as eight seeds make them.** A standard deviation from eight samples is
   itself uncertain by roughly a quarter of its size, which is why `suggestTolerance` rounds up
   rather than to nearest, and why `seeds` sits beside every `tolerance` in the baseline.
3. **Reproducibility holds across machines; across Node majors it is an assumption.** The gate's
   first CI run reproduced this scorecard exactly — every metric at a delta of zero, on an Ubuntu
   runner against a baseline blessed on Windows — so none of this depends on the operating system or
   on a patch level. V8 may still change the last place of a transcendental between *major*
   releases, and a long simulation can amplify that, so the bench job pins one major, the baseline
   records what it was blessed on, and a mismatch is printed as an advisory rather than mistaken for
   a regression. Nobody has actually diffed a run on 22 against one on 24.
4. **The seed study is not automatic, and must not be.** Nothing in CI runs it, because a gate that
   recalibrates itself is not a gate. When the harness changes shape, somebody runs it, reads it, and
   edits the bands by hand.

---

## Phase 5.5 — The copy library

Generated against the live API with `pnpm --filter @kairos/scribe run compose`, and committed at
`data/copy-library.json`. Every test and every CI run replays it; nothing below needs a key to check
except the generation itself.

### What was measured

Not recovery. That is the benchmark's fourth arm and it has not run — nothing consumes the library
at runtime yet, and the recovery worker still sends hand-written templates. What is measured here is
the thing that has to be true before that arm can mean anything: whether a model, asked once per
*situation* under a stated character budget, produces copy a deterministic validator accepts, and
what it costs to find out.

### The library

468 variants over all 180 situations — five failure classes, six rails where the rail changes what
the customer must do, four languages, three channels.

| language | SMS | WhatsApp | email | total |
|---|---:|---:|---:|---:|
| English | 42 | 41 | 43 | 126 |
| Hindi | 40 | 41 | 42 | 123 |
| Marathi | 36 | 34 | 41 | 111 |
| Tamil | 32 | 35 | 41 | 108 |
| **all** | **150** | **151** | **167** | **468** |

Coverage is complete; density is not. 132 segments carry three variants, 24 carry two and 24 carry
one. The thin ones are where the budget is tightest — Tamil and Marathi SMS — and a segment with one
variant gives the exploration bandit nothing to explore. That is a real cost of writing to a
character budget, and it is reported rather than smoothed over.

### What it cost

**190 calls, ₹8.15 at list rate**, for a library that serves 5,749 messages in a four-hour window
and every window after it until somebody changes the prompt. Per-message generation would have been
about forty times the calls, and would have to be paid again every window.

Priced at `gemini-3.1-flash-lite`'s published rate — $0.25 in and $1.50 out per million tokens at
₹96/USD — even though the tier this ran on billed nothing. A free tier is a development convenience,
and an accounting of ₹0 would be a true statement about this month and a false one about the first
month anybody deployed.

**85% of proposals were accepted** on the final prompt. The rejections were 55 missing a mandatory
placeholder and 27 over budget; no proposal in the final run wrote a URL, invented a rupee figure,
or answered in the wrong script.

### The honesty checks, over the whole library

Run as tests on every change, because a library gets edited by hand the moment somebody dislikes a
variant, and that step has no validator behind it.

| check | result |
|---|---|
| `timed` variants mentioning a balance or funds | **0 of 36** |
| `timed` and `unknown` variants inventing a cause | **0 of 72** |
| variants writing a URL of their own | **0 of 468** |
| variants writing a rupee figure rather than `{amount}` | **0 of 468** |
| variants missing `{amount}` or `{link}` | **0 of 468** |
| non-email variants over the 3-segment reservation ceiling | **0 of 301** |
| `transient` variants naming the institution | **28 of 30 (93%)** |

The last row is the mirror of the second. `transient` copy exists to say *what went wrong* — that is
where its uplift comes from — so the check there is that it does, not that it does not.

### Four things the measurement changed

**The prompt was asking for arithmetic the model could not do.** It stated the segment's *capacity*
and added "including the greeting that will be added before your text and the values that replace
the placeholders", while never saying how long a greeting is, or a link, or a rendered amount.
**Eleven per cent** of the first recorded batch survived the gauntlet. Telling the model the
characters left for its own text took that to **eighty-eight** — same model, same gauntlet, same
day.

**A one-segment Indic SMS is not a target.** Stating the real number exposed it: seventy units, less
a fourteen-unit greeting and a seventeen-unit placeholder surcharge, is thirty-nine characters of
which fourteen are the placeholders themselves. Twenty-five characters of Hindi is two words. See
[ADR 0007](decisions/0007-an-indic-recovery-sms-buys-a-second-segment.md) — an Indic recovery SMS
buys a second segment and costs twice as much to send, which is a cost line the multilingual claim
now has to carry.

**The budget read the encoding off the wrong string.** `bodyBudget` measured the greeting alone. On
WhatsApp the rupee sign is free, so an amount renders as `₹1,245.00` — and U+20B9 is not in GSM-7,
so an English WhatsApp message is UCS-2 at 134 units rather than GSM-7 at 306. The budget promised
279 characters where the truth was 103, and *every* English WhatsApp variant was rejected for a
length the prompt had told the model it had. Measuring the encoding on a message carrying the
substituted values took that cell from **0% to 90%**.

**The model invented a cause when told to name none.** Found by reading the finished library, which
is the entire reason it is committed rather than streamed. Six variants in 465 — all in `timed` and
`unknown` — said the payment had failed for *technical* reasons. Not a balance: the prompt guards
that heavily and nothing in the library mentioned one. This is the softer failure, a comforting
fiction about a fault at the bank's end, and it is still a false statement about somebody's money
sent under the merchant's own sender id. Both prompts now forbid it by name, and the gauntlet
enforces it structurally for those two classes, because a prohibited-phrase list does not depend on
the model having complied. The regenerated library has zero.

### Three findings about the provider

None came from a documentation page. All three came from a response.

**`gemini-2.5-flash` is retired.** A new API key gets `404: no longer available to new users. Please
update your code to use models/gemini-3.6-flash`. An adapter written from memory ships with that
model name in it.

**The free tier's daily quota selects the model, and neither the rate nor the price would have.**
`gemini-3.6-flash` allows twenty requests *per day*:
`GenerateRequestsPerDayPerProjectPerModel-FreeTier = 20`. A hundred and eighty segments at twenty a
day is a nine-day copy library. `gemini-3.1-flash-lite` measured at fifteen requests a minute with a
daily allowance large enough to write the whole thing several times over, costs a third as much per
token, and answers about five times faster.

**There is no `Retry-After` header.** A 429 carries the wait in the body as a `google.rpc.RetryInfo`
— `"29s"`, `"0.194s"` — beside a `QuotaFailure` naming the limit that bound and its value. An
implementation reading the header finds `null` and falls back to a guess that is slower than the
wait actually needed and, when short, a second refusal. The adapter reads the body, and corrects its
own pacing downward from what the server said.

And one that would otherwise have been a silent 23× under-report: **thinking tokens are billed as
output.** With no thinking configuration, a request for three SMS variants on `gemini-3.6-flash`
spent **751 thinking tokens against 33 of answer** and truncated its own JSON by exhausting
`maxOutputTokens`. At `thinkingLevel: "minimal"` it spent none. `usageMetadata.thoughtsTokenCount`
is reported separately and appears only when non-zero, so code written against one observed response
never sees it.

### Caveats

1. **Acceptance is not quality.** The gauntlet checks structure — placeholders present, no invented
   amount, no URL, right script, within budget, nothing prohibited. It cannot check whether a
   sentence is *good*, and it passed all six invented causes. A person reading the file is what
   caught those, which is why the file is committed.
2. **No customer has seen any of this.** Everything downstream is measured against `scoreMessage`,
   whose weights are invented — see open question 18. A message naming the rail and the action
   scores higher than one that does not because this project decided it should, not because anybody
   observed it.
3. **One model, one day, one prompt.** Nothing here compares providers, and "flash-lite's output is
   not visibly worse than flash's" is an impression from reading both rather than a measurement. The
   committed library is what lets somebody disagree.
4. **Marathi and Tamil are the thinnest, and nobody here is a native speaker.** The script check
   catches an answer in the wrong language; it cannot catch one that is grammatical nonsense in the
   right one. That review has not happened.
5. **Regenerating is neither free nor deterministic.** Sampling at temperature 1 is the point — the
   variants have to differ for the bandit to have anything to test — so a regeneration produces
   different copy, new variant ids, and a bandit that starts over. `promptHash` is what makes that
   visible rather than silent.

---

## Phase 5.75 — What the copy library is worth

Phase 5.5 generated 468 validated variants and measured everything about them except the only thing
that matters: whether they recover more money. Nothing consumed the library at runtime. This is the
measurement that closes that gap, and it produced a narrower claim than expected.

### The fifth arm

`kairos + generated copy` against `kairos + template copy`. Identical scheduling, expected-value
gate, seed, customers and world; the single difference is where the words come from, so any gap
between them is attributable to the copy and to nothing else.

Two changes were needed before the comparison could mean anything, and both were corrections.

**Customers now have a language.** The simulator modelled attempts in detail and people not at all,
so every arm was told its recipients read English. That was harmless while every arm sent the same
English template and stops being harmless the moment one arm can write Tamil: a benchmark whose
whole population reads the baseline's language cannot measure a language advantage and would report
zero for a real one. The modelled mix is 55% English, 25% Hindi, 10% Marathi, 10% Tamil — **every
one of those numbers is a stipulation**, and the measured value moves with the non-English share.

**Legibility moved to where it acts.** `scoreMessage` used to halve its content score for a message
in the wrong script, and the world then applied that score only to whether a `customer-action`
casualty got fixed. So an unreadable message pulled back exactly as many people as a readable one
and was merely slightly worse at helping them, which is not a model of anything. Nobody acts on a
message they cannot read. Legibility now multiplies the response rate; content still governs the
outcome. Charging one number for both put the penalty on the wrong quantity, and charging it in
both places would have billed it twice and flattered every multilingual result by construction.

### The result

| arm | incremental | messages | opt-outs | true cost | legible |
|---|---:|---:|---:|---:|---:|
| do nothing | — | 0 | 0 | ₹0.00 | — |
| chronos ladder | ₹5,84,006.00 | 10,681 | 132 | ₹28,495.00 | 53.6% |
| message everyone | ₹1,40,736.00 | 5,544 | 67 | ₹14,485.40 | 54.5% |
| kairos + template copy | ₹6,13,843.00 | 5,817 | 58 | ₹12,451.97 | 53.6% |
| **kairos + generated copy** | **₹6,82,069.00** | **5,749** | **54** | **₹11,650.99** | **100%** |

Generated copy recovered **₹68,226 more** than the same system running templates, on 68 fewer
messages and 4 fewer opt-outs. Fewer messages is not a separate saving — a customer who acts on the
first message never receives the second.

It also moves the headline the recovery report has carried since Phase 4. Kairos previously recovered
about 6% *less* incremental revenue than the fixed ladder and won on cost; with generated copy it
recovers **17% more, on 46% fewer messages and with 78 fewer customers lost to opt-out**.

**Both Kairos rows moved when open question 19 was closed**, and the baselines did not — the ladder
and the blast arm do not consult the detector, so they are untouched, which is a useful check that
nothing else drifted. The Kairos arms lost about 1.7% of incremental recovery and gained messages
and opt-outs, because an incident that closes on time means a `transient` casualty is retried on the
true recovery edge, and acting sooner overlaps more with customers who were returning unaided. The
window sweep above was measured against the old behaviour and has not been re-run; see [open question
20](ARCHITECTURE.md#18-open-questions).

### Do not read that number without this table

The gain is entirely a function of a weight nobody has measured. Rather than quote one point from
it, the harness sweeps the readability penalty across its whole range, four seeds per row:

| penalty | template | generated | mean gain | worst seed | best seed |
|---:|---:|---:|---:|---:|---:|
| 0.00 | ₹5,12,356.00 | ₹7,19,345.50 | ₹2,06,989.50 | ₹1,74,151.00 | ₹2,47,377.00 |
| 0.50 | ₹6,14,368.50 | ₹7,19,345.50 | ₹1,04,977.00 | ₹71,850.00 | ₹1,69,829.00 |
| 1.00 | ₹7,08,978.25 | ₹7,19,345.50 | **₹10,367.25** | −₹3,021.00 | ₹33,220.00 |

Four seeds at `f163eb1`, and not re-run since — so these do not line up with the single-seed
headline above, which was regenerated at `5cfa489`. The shape is what this table is for.

**The generated column does not move.** Every message that arm sends is legible, so the penalty has
nothing to bite on; all the movement is in the baseline. That is the whole finding: what the library
buys is *readability*, not better writing. At a penalty of 1.00 the gain is negative and its range
straddles zero — everything the model wrote about naming the rail, being specific about the next
step and fitting the channel is worth, on this evidence, approximately no money.

That is a much narrower claim than "we generate better copy", and it is the one the measurement
supports.

### Why the sweep is four seeds and not one

The first version was one seed and came out **non-monotonic** — a penalty of 0.25 scoring below
0.00, which is impossible. The step was ₹31,737 against a seed-to-seed coefficient of variation of
4.18% on this metric. The inversion was the noise floor announcing itself, and a curve whose middle
cannot be ordered is not a curve.

`recover.generatedGainPaise` is gated with a tolerance of ₹1,00,000 against a mean of ₹78,509 — a
band wider than the value it guards. Its own cv is **37.6%**, the highest on the scorecard, because
a difference between two noisy quantities is noisier than either. The gate can catch the gain
disappearing and nothing finer. **Do not quote that metric's point value as a finding**; quote the
sweep.

### What moved in the baseline, and why it should have

`recover.trueCostPaise` doubled, from ₹6,014.69 to ₹12,046.33, and its band was widened from ₹5,000
to ₹10,000. That is not a regression: the template arm is now measured against a population half of
which cannot read it, so it sends more messages and loses more consent. The cost the library exists
to remove should appear in the baseline rather than be tuned away.

### Caveats

1. **The language mix is invented**, and the gain scales with the non-English share. Halve it and
   you roughly halve the measured benefit. A real merchant knows their own distribution in a day.
2. **The gain is not resolvable at this sample size.** The point estimate has a 37.6% coefficient of
   variation. What is resolvable is its sign at low penalties and its absence at a penalty of 1.
3. **Legibility is modelled as a script check**, which is a crude proxy. A customer who reads
   English perfectly well is counted as unable to read Tamil and vice versa; nothing models partial
   comprehension, and real bilingualism is the norm in this market.
4. **No customer has seen any of this.** The same caveat as Phase 5.5, and it still dominates.

---

## Phase 6 — Demonstration

The console API and its scenarios are built and tested; the UI is not. `pnpm explain` is built.
Nothing here is a measurement, with one exception that belongs in this document because it was found
by building the console and is a fact about the detector rather than about the demo.

### The detector resolved an incident six hours after the rail recovered

Detection latency had been measured since Phase 1 — a median of 93 seconds at `h=12`. **Resolution
latency had never been measured at all**, and it was roughly two orders of magnitude worse. Building
a console is what found it; the sweep could not, because it stops watching two minutes after the
rail heals.

On the `issuer-outage` scenario the rail is healthy again at +81 minutes. The incident opened at +49
and did not resolve until **+442**. Traced per shift, the cause is not that a one-sided CUSUM decays
slowly in general — it is *which* statistic decays slowest:

```
        S(δ=0.03)  S(δ=0.08)  S(δ=0.18)  S(δ=0.40)
+ 80m       12.02      21.90      21.94      17.18   <- rail has recovered
+120m       10.69      15.51       0.00       0.00
+240m        9.87       4.01       0.00       0.00
+440m        3.63       0.00       0.00       0.00   <- clears, at last
        clearThreshold = 3.6
```

After a rail heals, statistic `i` drifts at `−KL(p₀ ‖ p₀+δᵢ)`, which is monotone increasing in δ.
The bank reports its **maximum**, so the alarm was decided by the fastest riser and the release by
the slowest faller — and the slowest faller is always the most sensitive shift, whose entire job is
to be slow. The two aggressive statistics were back at zero within forty minutes of recovery;
`δ=0.03` alone held the incident open for another five hours. **Adding a hypothesis to catch milder
degradations made every incident close later**, which is a coupling nobody chose and nobody would
have chosen.

It was expensive rather than untidy: steering kept diverting traffic off a healed rail for as long
as the incident stayed open, and the recovery arm's whole timing claim is that it retries on the
recovery edge.

**Fixed.** Closing has its own statistic now — see [the way back](#the-way-back) for the repair, the
measured before-and-after, and what it cost. The console test that used to assert this defect now
asserts its absence, so it cannot come back quietly either.
