# 9. The form authors a mandate and a separate command signs it

- **Status** — accepted
- **Date** — 2026-09-03
- **Constrains** — `apps/mandate`, and how a merchant comes to hold a mandate at all

## Context

A mandate is the only thing that lets Kairos spend money, and until now there was no way to produce
one except to construct it in code and call `sealMandate` at a call site. That is fine for a worker
booting itself from environment variables. It is not a path a merchant can walk.

The gap is not ergonomic. It is that a mandate is **unreadable by design**:

```json
{ "budgetPaise": 500000, "maxActionCostPaise": 60, "maxInFlight": 16,
  "reservationTtlMs": 120000, "contactCap": { "limit": 3, "windowMs": 604800000 },
  "quietHours": { "startMinute": 1260, "endMinute": 480, "offsetMinutes": 330 },
  "validFrom": 1788390000000, "validUntil": 1790982000000 }
```

Every field is in the units the kernel enforces, which are not the units anybody thinks in. Worse,
the two numbers a person signing this most needs are **not in the object at all**: the most that can
be committed at once is `maxActionCostPaise × maxInFlight`, and how many actions the budget buys is
`budgetPaise ÷ maxActionCostPaise`. Somebody authorising spend cannot be asked to do that arithmetic
in their head, and a system whose whole thesis is bounded autonomy cannot ask them to sign a bound
they cannot read.

There is also a field nobody should be typing. `maxActionCostPaise` is a property of the price list,
not a preference: set below the worst message the system can compose, it refuses that message *at
settlement*, after it has already been sent. Set far above, it silently widens the blast radius.

## Decision

**Two programs. A form that authors a spec, and a command that signs one.**

The form collects a **spec** — rupees, days, clock times, a purpose — and the spec is worthless on
its own, because the kernel rejects an unsigned mandate. Sealing happens in a process the operator
started, from `KAIROS_MANDATE_SECRET`, on a machine they chose.

```
kairos-mandate form [--port 8181]     # author one in a browser, on loopback
kairos-mandate seal   spec.json       # spec in, signed mandate out
kairos-mandate explain mandate.json   # what a signed mandate authorises, in words
kairos-mandate verify  mandate.json   # exit 1 if a field was edited after signing
```

`seal` prints the plain-English reading to **stderr** and the mandate to **stdout**, so
`kairos-mandate seal spec.json > mandate.json` still shows the operator what they just authorised.
Signing something nobody read is the failure this tool exists to prevent, and a redirect is the
obvious way to accidentally do it.

## Why the split, and why the conversion is still server-side

**The key never goes where it does not have to.** Anyone holding it can mint a mandate with any
budget and a cleared kill switch, and the kernel will honour it. A form that signed in the browser
would have to be handed the key; a form that collects a spec needs nothing. A merchant on a locked
network can author a spec, send the JSON, and have somebody else seal it.

**The conversion is server-side for a correctness reason, not a security one.** There must be exactly
one implementation of "₹5,000 for 30 days", so the page posts its spec back and renders what
`toMandate` and `explainMandate` say. A form that did its own arithmetic would be a second place to
write ₹5,000 as five thousand paise — an error no type can catch, because both are integers and both
are plausible.

**Purpose replaces the two dangerous fields.** A merchant answers what the mandate is *for*, and the
action set and the per-action ceiling follow from the same price list the worker derives them from.
Narrowing within a purpose is allowed — a merchant with email consent and no SMS consent is
tightening their own grant. Widening is refused by name, because an action outside the purpose would
be governed by a ceiling derived for a different price list.

**Validation happens where the mandate is written.** `validateMandate` — the same check the kernel
runs at admission — runs at authoring time, so a mandate that could not be enforced is refused by the
tool that produced it rather than discovered by a worker's crash loop.

## Consequences

**The form is loopback-only and not configurable.** This process may hold a signing key; a form bound
to `0.0.0.0` is a key-minting endpoint on the network, and an operator who genuinely wants that should
have to build it deliberately rather than pass a flag. Requests carrying somebody else's `Origin` are
refused, and a missing `Origin` is allowed because that is what every non-browser client sends.

**Running without a key is a supported state.** The form explains a mandate and refuses to sign one,
saying so rather than pretending. That is the right shape for a review meeting: everybody can see what
is about to be authorised; only one machine can authorise it.

**The reading is the artifact, not a nicety.** `explain` states the two derived numbers, says out loud
when it did *not* check a signature — because "no complaint" and "not checked" look identical on a
terminal and only one of them means the mandate is genuine — and reports a mandate whose budget was
raised after signing as `DOES NOT VERIFY`.

**Still missing: distribution.** A sealed mandate is a file somebody has to get to a worker, and there
is no control plane that hands one out, rotates it, or revokes it short of the kill switch. The
store-backed switch covers the emergency; the ordinary lifecycle does not exist yet.
