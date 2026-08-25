# Kairos

**Catch the moment.** Payment-health defence for Indian merchants — every action bounded by a limit
it cannot exceed.

A bank's rail starts failing at 14:14. Not down, just failing about a third of the time. Customers
tap Pay, get an error, and leave. At almost every merchant nothing happens for forty minutes: someone
notices soft numbers, asks in a group chat, investigates, maybe disables something. Those sales are
gone, and they never appear in any report *as* a loss.

Kairos notices in about three minutes, steers customers off the failing rail before they ever see an
error, and then chases the ones already lost — knowing *why* each of them failed, so it retries the
moment the rail heals instead of guessing at a fixed schedule.

> Greek has two words for time. **Chronos** is clock time — sequential, measured, indifferent.
> **Kairos** is the critical moment, the narrow window where action still works.
> Every dunning system in the world retries on chronos. This one retries on kairos.

---

## Why the bounds matter

The moment a system can reorder a live checkout and spend real money with nobody supervising it, the
hard question stops being *can it detect problems* and becomes **how do you let it touch money at
all**.

If the detector is wrong, steering diverts customers away from a perfectly healthy rail and causes
exactly the loss it exists to prevent. If the recovery worker is scaled to three instances, a
check-then-act against a shared budget races and the campaign overspends. If a message is generated in
Devanagari rather than Latin script, it silently costs three SMS segments instead of one — and you
learn that *after* you have already sent it.

So every money action in Kairos clears **Terminus**, a governance kernel built on
[ThrottleKit](https://github.com/AmeyaBorkar/throttlekit), where limits are arithmetic guarantees
rather than policy checks: bounded blast radius, bounded spend with commitment accounting, per-customer
contact caps, hard stopping rules, and a tamper-evident record of which bound was binding on every
single decision.

## What it measures

No effect is claimed without a control group behind it. Every steering decision holds back a random
slice of customers untouched, so recovered revenue is
`(control loss rate − treated loss rate) × treated volume` — measured, not modelled.

The scorecard reports detection latency against false-alarm rate, calibration of its own recovery
predictions, false-positive cost in rupees, budget utilisation, throughput, compliance assertions over
the full audit log — and an honest list of the cases where Kairos lost to the baseline.

## Measured so far

Every number here is produced by a seeded experiment in this repo, reproducible with one command, and
reported alongside what it cost and where it fails. Full results and caveats in
**[docs/MEASUREMENT.md](docs/MEASUREMENT.md)**.

**Detection** — at the chosen operating point, **0.21 false alarms an hour, 83% of degradations
caught, 93s median latency**, and an issuer collapse caught in **5 seconds**. A degradation confined
to a slice seeing four attempts a minute is **not detected at all**, which is a limit of the available
evidence rather than a bug, and is documented as such.

**Spend** — a naive check-then-spend worker overruns a ₹500 budget by **₹100 at 64 workers**, and
delivers **271 messages past a three-per-week contact cap**. Through the kernel, at every fleet size
from 1 to 64: **₹0 over, 0 violations, ≥99.6% of the budget still spent.** The bound is
`maxInFlight × (maxActionCost − reservation)` — both terms are mandate fields, neither is the worker
count.

Two design claims did not survive contact with measurement, and both corrections are recorded rather
than quietly applied: the detector's threshold was wrong by a wide margin, and the ThrottleKit
mechanism named for the campaign budget turned out to be the wrong one
([ADR 0001](docs/decisions/0001-commitment-accounting-over-throttlekits-store.md)).

## Status

Under active development. See **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for the full design:
module decomposition, the detection algorithm and why that one, the Terminus policy set, failure modes
and what each degrades to, the measurement design, and the build sequence.

## Development

```sh
pnpm install
pnpm build
pnpm test
pnpm lint
```

Requires Node ≥ 22 and pnpm ≥ 11.

## Licence

MIT © Ameya Borkar
