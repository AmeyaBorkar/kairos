# Measurement

Every number Kairos reports is produced by a seeded, reproducible experiment. This document holds
the results as they are measured, phase by phase, including the ones that are unflattering.

Reproduce with:

```sh
pnpm build
pnpm bench:detect          # full sweep, ~11s
pnpm bench:detect:quick    # reduced sweep for CI
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

## Phase 2 onward

Not yet measured. Terminus bound-holding under concurrency, recovery rate against baselines,
calibration of `p(recover)`, false-positive cost in rupees, and the compliance assertions over the
ledger all land with their phases.
