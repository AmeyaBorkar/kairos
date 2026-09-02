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

**Detection** — at the chosen operating point, **0.14 false alarms an hour, 83% of degradations
caught, 93s median latency**, and an issuer collapse caught in **5 seconds**. An incident closes a
median of **2.5 minutes** after the rail is genuinely healthy, measured from the simulator's clock
rather than the detector's opinion of it. A degradation confined to a slice seeing four attempts a
minute is **not detected at all**, which is a limit of the available evidence rather than a bug, and
is documented as such.

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
hours, Kairos recovers **8% more money** and does it with **half the messages** and **50 customers
lost to opt-outs rather than 155**. Priced at what consent is worth, that is a **68% lower true
cost**. Brute force finds money; it finds it by spending goodwill nobody put on the invoice. The
recovery probability is calibrated to **1.3% expected error**, which is the property an
expected-value gate actually needs — not accuracy, but that 30% means thirty per cent.

A tenth of casualties are held out of treatment entirely, so every recovery figure above is
*incremental*: 24% of the lost money came back with no help at all, and a system reporting gross
recovery would be reporting the customer's own behaviour and billing for it.

**Proof** — all of the above is one artifact and one verdict, re-checked on every change.
Seventeen claims are checked exactly, because they have no sampling distribution: spend either
exceeded the mandate or it did not. Twenty-one are estimates and carry a band, and the band is
measured rather than guessed — `bench:variance` holds the code still, varies only the seed, and
reports how far each number wanders when nothing is wrong. That is the size of a meaningless change,
which is what a gate has to survive. **Nine of the twenty-three bands are wider than the value they
guard, and the gate says so**, because a reader who sees PASSED is owed the difference between a
claim that cannot break and one that merely cannot be measured this cheaply
([ADR 0005](docs/decisions/0005-a-benchmark-that-reproduces-exactly-still-needs-a-band.md)).

**Language** — a model writes the recovery copy, once per *situation* rather than once per message:
180 calls instead of 5,730, into a file that is reviewed in a pull request and committed. No
inference happens on the path where money moves, the benchmark stays seeded while using real model
output, and CI never makes a call. The prompt cannot contain a customer's name because a customer's
name is never assembled — the model writes a sentence with holes and a pure function fills them. An
inference call is an action like any other: admitted against a signed mandate, reserved before the
call, reconciled against the tokens the provider reports, and priced at list rate even on a free
tier ([ADR 0006](docs/decisions/0006-copy-is-written-once-reviewed-and-committed.md)).

The library is now read at send time, and a fifth benchmark arm measures what it is worth against the
same system running hand-written templates: **₹71,850 more recovered, on 491 fewer messages and 17
fewer opt-outs.** The result is narrower than it sounds, and the sweep beside it is the honest part —
the entire gain is *readability*, not better writing. Set the readability penalty to 1, where a
message in the wrong script works as well as one in the right script, and generated copy is worth
₹10,367 against ₹1.05 lakh at the default, on a range across seeds that straddles zero. Everything the model produced about naming the
rail and being specific about the next step is worth approximately nothing on this evidence.

`pnpm explain <target>` answers "why did Kairos do that?" from the audit chain. Every figure in the
answer must appear character-for-character in a record; one that does not is refused rather than
captioned, because a warning printed above fluent prose is read by nobody.

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
- the copy prompt was asking a model to subtract a greeting and three substitutions it had never
  seen the length of — eleven per cent of the first batch survived validation, and eighty-eight per
  cent survived once it was told the number it could actually act on (Phase 5.5);
- a one-segment recovery SMS in an Indic script is not a demanding target but an impossible one:
  seventy units, less the greeting and the placeholders, is twenty-five characters of Hindi
  ([ADR 0007](docs/decisions/0007-an-indic-recovery-sms-buys-a-second-segment.md));
- the prompt file claimed a provider cache that, measured, never engaged once in sixteen calls
  sharing an identical 829-token prefix — the ordering stays, the claim is gone (Phase 5.5);
- generated copy was expected to win on *writing* — naming the rail, saying what to do next. Swept
  against the readability weight it rests on, it wins on **readability alone**: at a penalty of 1.00
  the advantage is ₹10,367 on a range that straddles zero, against ₹1.05 lakh at the default
  (Phase 5.75);
- an unreadable message was modelled as slightly worse at helping people and exactly as good at
  bringing them back, which is not a model of anything — legibility now prices the response rate,
  once, where it acts (Phase 5.75);
- the detector was measured on how fast it opens an incident and never on how fast it closes one. It
  detected in about three minutes and resolved about **six hours** after the rail recovered, because
  a bank of CUSUMs reports its maximum and after a recovery that maximum is always the most sensitive
  statistic — the one whose job is to be slow. The alarm was decided by the fastest riser and the
  clear by the slowest faller, so *adding* a hypothesis to catch milder degradations made every
  incident close later. Fixed by giving the way back its own statistic, at no measurable cost to the
  detection curve at or above the operating threshold (open question 19);
- and fixing it moved the recovery arm the wrong way. Retrying on the true recovery edge overlaps
  more with the customers who were coming back unaided, so incremental recovery fell 1.7% while
  messages rose — the arm now does what it claimed, and what it claimed is worth slightly less than
  the version that was accidentally late (open question 20).

## Plugging it in

Three touchpoints, in the order a merchant reaches them.

**1 · The checkout asks what to render.** One call, on the page that already exists. It answers in
Kairos vocabulary *and* as the `config` object Razorpay Checkout takes, so a merchant on another
gateway does not need a translation layer:

```sh
KAIROS_MANDATE_SECRET=$(openssl rand -hex 32) pnpm --filter @kairos/sentry run start
curl -X POST localhost:8080/plan -H 'content-type: application/json' \
  -d '{"customer":"cus_9f3b2a71c4e8d012","sequence":["upi","card","netbanking"]}'
```

```json
{
  "sequence": ["upi", "card", "netbanking"],
  "suppress": [],
  "demote": [],
  "steered": false,
  "arm": "treated",
  "checkout": { "display": { "sequence": ["upi", "card", "netbanking"], "preferences": { "show_default_blocks": false } } },
  "maxAgeMs": 15000,
  "reason": "nothing in force"
}
```

It always answers `200`, including when the body is wrong, because the failure mode of a
payment-health tool must never be "no payments" — a malformed request gets the merchant's own
ordering back with the fault named in `reason`. `arm` is the field worth wiring: echo it back on the
outcome and the holdout analysis is correct without anyone having to know what a holdout is.

**2 · The outcome stream comes back.** The same events a merchant already has a webhook for.

```sh
curl -X POST localhost:8080/outcomes -H 'content-type: application/json' \
  -d '{"attempts":[{"id":"pay_1","orderId":"order_1","customer":"cus_9f3b2a71c4e8d012",
       "amountPaise":120000,"method":"upi","issuer":"hdfc","status":"failed","at":1756900000000,
       "arm":"treated"}]}'
```

**3 · A worker drains the casualties.** Dry-run by default: it decides everything and sends nothing.

```sh
KAIROS_MERCHANT_ID=acme KAIROS_LINK_BASE=https://pay.acme.test \
KAIROS_MANDATE_SECRET=$(openssl rand -hex 32) pnpm --filter @kairos/recover-worker run start
```

Point `KAIROS_DATABASE_URL` at a Postgres and the same command is a fleet instead of an instance —
the queue and the spend authority both move into the database, and an atomic lease stops two workers
acting on one casualty. The schema is printable for a deployment that owns its own migrations:

```sh
pnpm --filter @kairos/postgres run schema | psql "$DATABASE_URL"
```

## Authoring a mandate

Nothing spends money without one, and a mandate is unreadable by design: a flat object of paise and
epoch milliseconds whose two most important numbers are not in it, but are products of numbers that
are. So there is a form for writing one and a reading of what it authorises.

```sh
pnpm --filter @kairos/mandate run start form      # http://127.0.0.1:8181
```

The page collects a *spec* — rupees, days, clock times — and posts it back for conversion and
explanation. It never holds the signing key: with `KAIROS_MANDATE_SECRET` set, the process serving
the page seals it; without one, the page says so and refuses rather than pretending. Loopback only,
and not configurable.

The same thing without a browser:

```sh
export KAIROS_MANDATE_SECRET=$(openssl rand -hex 32)
kairos-mandate seal spec.json > mandate.json   # reading to stderr, mandate to stdout
kairos-mandate explain mandate.json
kairos-mandate verify mandate.json             # exit 1 if a field was edited after signing
```

`seal` prints the plain-English reading to stderr and the mandate to stdout, so redirecting the
mandate to a file still shows you what you just authorised.

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

Requires Node ≥ 22 and pnpm ≥ 11. **No API key is needed for any of it** — the benchmark is seeded
and offline, and the reasoner adapter's tests replay a committed recording rather than calling
anybody.

The operator console runs against simulated traffic with no key at all. It drives the real detector,
controller, kernel and ledger, and every response says so:

```sh
KAIROS_MANDATE_SECRET=$(openssl rand -hex 32) pnpm --filter @kairos/console run start
curl localhost:8788/api/scenarios
curl -X POST localhost:8788/api/step -H 'content-type: application/json' -d '{"ticks":20}'
```

Six scenarios, including one where nothing happens and two that end with Kairos refusing to act. The
client drives the clock rather than the server running a timer, so an incident can be stepped through
by hand while recording.

Asking why something happened works without a key too — it prints the audit records, and adds prose
only if a model is configured and every figure in that prose came from a record:

```sh
pnpm --filter @kairos/console run explain -- --list
pnpm --filter @kairos/console run explain -- <target>
```

One job needs a key, and it is run by a person rather than by a machine: regenerating the copy
library after a prompt changes.

```sh
cp .env.example .env          # then fill in GOOGLE_API_KEY
pnpm --filter @kairos/scribe run compose --dry-run   # what it would ask for, and the budget
pnpm --filter @kairos/scribe run compose             # ~180 calls, about ₹10 at list rate
pnpm --filter @kairos/scribe run record              # re-record the adapter's test cassette
```

`compose` is resumable: it writes what it has, reports where it stopped, and asks only for the
segments still missing next time. A free tier's daily quota is a real bound, so that is not a
nicety.

## Licence

MIT © Ameya Borkar
