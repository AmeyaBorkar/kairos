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

**Steering** — suppressing a broken card instrument cuts the loss rate for exposed customers from
**41% to 12%**, with no measurable effect on anyone else. Demoting UPI to deal with one issuer's
outage helps exposed customers by **13 points** and **measurably harms bystanders by 1.85 points**,
because the healthy UPI users it nudges land on cards, which fail six times as often. That cost is
reported, not netted away. A moderate UPI outage produces **no steer at all** — there is nowhere
better to send anyone, and a system that steered anyway would cause the loss it exists to prevent.

**Recovery** — against a fixed +1h/+24h/+72h ladder given the same budget, contact cap and quiet
hours, Kairos recovers **6% less money** and does it with **half the messages** and **43 customers
lost to opt-outs rather than 153**. Priced at what consent is worth, that is a **72% lower true
cost**. Brute force finds money; it finds it by spending goodwill nobody put on the invoice. The
recovery probability is calibrated to **1.6% expected error**, which is the property an
expected-value gate actually needs — not accuracy, but that 30% means thirty per cent.

A tenth of casualties are held out of treatment entirely, so every recovery figure above is
*incremental*: 24% of the lost money came back with no help at all, and a system reporting gross
recovery would be reporting the customer's own behaviour and billing for it.

**Proof** — all of the above is one artifact and one verdict, re-checked on every change.
Seventeen claims are checked exactly, because they have no sampling distribution: spend either
exceeded the mandate or it did not. Twenty-one are estimates and carry a band, and the band is
measured rather than guessed — `bench:variance` holds the code still, varies only the seed, and
reports how far each number wanders when nothing is wrong. That is the size of a meaningless change,
which is what a gate has to survive. **Eight of the twenty-one bands are wider than the value they
guard, and the gate says so**, because a reader who sees PASSED is owed the difference between a
claim that cannot break and one that merely cannot be measured this cheaply
([ADR 0005](docs/decisions/0005-a-benchmark-that-reproduces-exactly-still-needs-a-band.md)).

Design claims that did not survive contact with measurement — each corrected in the open rather than
quietly:

- the detector's threshold was wrong by a wide margin (Phase 1);
- the ThrottleKit mechanism named for the campaign budget was the wrong one
  ([ADR 0001](docs/decisions/0001-commitment-accounting-over-throttlekits-store.md));
- reserving the worst case does *not* sterilise a lifetime budget, so the reservation learner did not
  earn its place (Phase 2);
- suppression cannot be the primary steering lever, because Razorpay Checkout cannot see a UPI
  payment's issuer — roughly seventy per cent of Indian volume
  ([ADR 0002](docs/decisions/0002-two-steering-levers-because-checkout-cannot-see-a-upi-issuer.md));
- the recoverability taxonomy was missing its largest class, and the one it was missing is the one
  that must be asked exactly once
  ([ADR 0003](docs/decisions/0003-a-sixth-recoverability-class-for-the-customer-who-must-simply-try-again.md));
- "retry when the rail heals" is available on about one payment in eight, because everything else
  needs the customer to enter a PIN
  ([ADR 0004](docs/decisions/0004-a-retry-is-only-free-when-the-customer-is-not-needed.md));
- waiting before spending was expected to trade recovery for restraint, and costs nothing at all —
  it sends fewer messages, wastes far fewer of them, and recovers *more* (Phase 4);
- "the kernel never overspends" was too strong: reserving the worst case cannot, but the adaptive
  sizers under-reserve on purpose and buy a *bounded* residual rather than none — ₹8 of one
  ([ADR 0005](docs/decisions/0005-a-benchmark-that-reproduces-exactly-still-needs-a-band.md));
- "the steering lever never changes mid-incident" was true on eight seeds of a short run and false on
  a long one, which is what a study at a single size cannot tell you (Phase 5).

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
