# 5. A benchmark that reproduces exactly still needs a band

- **Status** — accepted
- **Date** — 2026-08-26
- **Constrains** — the `bench.yml` regression gate promised in
  [ARCHITECTURE.md §17](../ARCHITECTURE.md), and every number in
  [MEASUREMENT.md](../MEASUREMENT.md) that a future commit could quietly undo

## Context

Every benchmark in this repository is seeded. The same configuration produces the same numbers
for ever, on the same runtime, down to the paise. That is a property worth having and it makes an
obvious gate available: record the numbers, compare exactly, fail on any difference.

That gate would be worthless within a fortnight.

The reason is that a fixed-seed benchmark does not measure a number, it draws a *sample*. Change
anything about how the code consumes its generator — add a draw, reorder a loop, extract a helper
that happens to sit between two calls — and the run does not become worse. It re-rolls. Every
downstream value moves by roughly as much as changing the seed would move it, which on the recovery
arm is several thousand rupees and on the detection arm is tens of seconds. None of those changes
made anything worse. All of them would go red.

A gate that goes red for innocent reasons gets re-blessed without being read, and a gate nobody
reads is worse than no gate: it occupies the slot where a real one would go.

The opposite failure is just as available. Pick tolerances by feel, generously, and the gate stays
green through a genuine regression while looking like diligence.

## Decision

**Split the claims by kind, and derive the bands from measurement.**

### Invariants have no tolerance, ever

A claim with no sampling distribution gets none. Spend either exceeded the budget or it did not.
The chain either hashes or it does not. No failure in our own traffic model fell through to
`unknown`, or one did. Putting a tolerance on "the kernel did not overspend" would be saying it may
overspend a little, and it may not.

Two properties follow, and both are enforced rather than described:

- **Invariants survive a change of experiment.** A latency measured at 400 attempts a minute says
  nothing about a run at 200, so when the configuration changes the metric bands are not stale, they
  are *meaningless*. "The ledger verified" is not: it holds whatever traffic you point at it. So a
  config-hash mismatch stops the metric comparison and leaves all seventeen invariants running.
- **`positive` invariants guard the controls.** If the unguarded spend arm stopped overspending
  because the harness broke rather than because the race went away, every claim about the kernel
  would still pass while demonstrating nothing. An experiment has to be able to fail before its
  success means anything.

### Metrics carry a band, and the band is measured

`bench:variance` holds the code still, varies only the seed, and reports the spread. That spread is
the size of a meaningless change, so it is the right scale for a tolerance: three standard
deviations lets an innocent re-roll through about 997 times in a thousand.

Two tolerances are not derived, and each says so in the file. `detect.falseAlarmsPerHour` takes the
false-alarm budget the detection report already declares — the project has said what it will
tolerate, and a second number invented for the gate would only be a second opinion.
`detect.detectionRate` takes one trial out of the eighteen the gate runs, because its spread across
eight seeds was exactly zero and a band of zero would fire the first time any scenario went the
other way.

### A bless updates values and never widens a band

Tolerances are carried across by id from the previous baseline. Recomputing them from the run being
blessed would let a drifting metric set its own gate wider on the way past, and the band would
ratchet open one innocent commit at a time until it caught nothing. Widening is an edit to a
committed file, reviewed like any other change, with the `sd` and `seeds` fields sitting beside the
tolerance for a reviewer to check it against.

## What it found, before it had run twice

The study is not ceremony. Its first four runs each changed something real.

**The overspend claim was wrong.** The scorecard asserted that the kernel never spends past the
budget. It spends ₹8 past it. Reserving the *worst case* cannot overspend and is gated at exactly
zero; the adaptive sizers deliberately reserve less in order to fit more actions into the same
budget, and what they buy is a *bounded* residual, not the absence of one. Gating them at zero
would either have been a lie or would have forbidden the feature. The two are now separate claims.

**Two harnesses held two copies of the same scenario.** Onsets transcribed ten minutes late pushed
the degradation's peak past the end of the gate's window, and `detectionHeld` went false for a
reason that had nothing to do with the detector. The scenarios now live in one file.

**A budget was being checked against a measurement that could not resolve it.** The gate observed
fifty minutes of healthy traffic, in which a single false alarm reads as 1.2 an hour — five times
the declared budget of 0.25. The answer to a rate you cannot resolve is more denominator, not a
wider band, so the healthy arm got its own sample-size knob and now runs nearly seven hours per
threshold.

**A scenario was dropped for being unmeasurable, then rescued.** HDFC netbanking's steering window
saw single-digit treated attempts, and its lift varied across seeds by almost its own mean; a band
honestly derived from that is a hundred percentage points, which no regression could cross. Rather
than gate it dishonestly or lose the suppressible case, the gate profile was made large enough to
resolve it — spread fell from 97% of the mean to 20%, for about ten seconds of CI.

**An invariant was true by luck.** Lever changes were zero on all eight seeds, so they were promoted
to a claim: the steering lever never changes mid-incident. The full profile then returned three, and
was right to — over forty-five minutes an incident ramps, peaks and recovers, and the lever that
suits a rail failing at 20% is not the one that suits it at 45%. A study run at one size cannot tell
you that. It is a metric with a band again, and the band guards what was actually worth guarding,
which is flapping rather than change.

## Consequences

**The gate says how much it is worth.** Eight of twenty-one bands are wider than half the value they
guard, and the report prints which ones. Those catch breakage, not degradation. That is a legitimate
state for a gate measured on twenty minutes of simulated traffic to be in, and a reader who sees
PASSED is owed the distinction rather than left to assume the sheet is uniform.

**The gate profile is not the smallest one that runs.** Every size in it was raised until the seed
study said the headline numbers could be told apart from noise: the recovery total's spread fell from
12% of its mean to 4%, and calibration error from 5.7% to 1.9%, which is where the full profile
lands. Fifteen seconds of CI is a low price for bands that mean something.

**Re-blessing is a visible act.** The baseline is only rewritten when a number actually moves, so
`git log docs/results/baseline-quick.json` reads as a list of the times this project changed what it
claims.

**The seed study is the thing to re-run, and it is not automatic.** Nothing in CI depends on it,
because a gate that recalibrates itself is not a gate. When the harness changes shape, somebody runs
`pnpm bench:variance`, reads it, and edits the bands.
