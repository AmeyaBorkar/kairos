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
