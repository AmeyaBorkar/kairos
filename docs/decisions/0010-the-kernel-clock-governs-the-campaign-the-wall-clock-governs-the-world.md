# 10. The kernel clock governs the campaign, the wall clock governs the world

- **Status** — accepted
- **Date** — 2026-09-04
- **Constrains** — `terminus`, `sentry`, `recover-worker`, and anything that ever reads a clock

## Context

Nothing in Terminus reads the clock directly. Every bound that involves time — reservation expiry,
mandate validity, quiet hours, the contact window — takes it from an injected `Clock`, so a decision
made last month can be reproduced by supplying the timestamp it was made at. That is principle P4
and it has been true since the kernel was written.

Demonstrating the system exposed a second question the port never had to answer. Recovery is slow on
purpose: backoff rungs measured in half-hours, quiet hours that hold a message until morning, a wait
for the moment a customer is likely to have money. Each of those is a decision the system is right to
make and none of them is watchable. The honest way to show them is to move the clock rather than to
shorten the rules, so `scaledClock` runs the campaign at a stated multiple of real time.

That works, and it immediately makes a category of question ambiguous. A process now has two answers
to "what time is it", and several things that had never needed to choose suddenly had to:

- how long since the drain loop last completed a pass
- how long this process has been running
- whether an inbound webhook, stamped by a gateway, is recent enough to act on

Read off an accelerated clock, all three are wrong in the same direction and none of them is loud
about it. A worker fourteen minutes old reports fourteen hours of uptime. A liveness probe computes a
gap sixty times the interval that produced it and concludes the loop has stopped. A webhook carrying
a real `created_at` is stale within seconds of boot, so the route refuses every genuine delivery.

## Decision

**The kernel's clock governs the campaign. The wall clock governs everything the campaign touches
that is not inside this process.**

Campaign time is anything the mandate bounds or the schedule reasons about: reservation TTLs, contact
windows, quiet hours, mandate validity, backoff rungs, and the timestamp on a drain report — because
that report describes decisions made in that frame, and stamping it in another would put its contents
in a frame none of them belong to.

World time is anything measured against something outside the process: uptime, liveness, the
freshness of a delivery somebody else stamped. These read `Date.now()` even in a process whose
campaign runs at sixty times real speed.

`scaledClock` lives in `terminus` rather than in an application, because it is a combinator over the
port every bound is measured against. Scaling one clock scales reservation TTLs, contact windows,
quiet hours and mandate validity **together**, in one frame. A caller assembling this themselves
could scale two of them and open a gap between the third, and that gap would be a bound quietly not
binding.

## What this does not scale

The world. A gateway's rate limit, a provider's throughput and a person's patience are all still
measured in real seconds, so an accelerated clock compresses every contact cap and every backoff into
a window the outside world never agreed to. Three messages a week becomes three messages every few
minutes against a real phone.

That is not a configuration to warn about, so `recover-worker` **refuses** `KAIROS_CLOCK_SPEED` in
any delivery mode but dry-run, before a pool is opened or a mandate is sealed. `sentry` accepts it
unconditionally, because the only thing it can do is reorder a checkout, which reaches nobody and
spends nothing.

## The consequence worth stating plainly

**An accelerated stack cannot also be a live integration.** A webhook is stamped by the outside world;
the rolling window decays what it holds against whatever clock the detector runs on. Under
acceleration a real observation is accepted, verified, translated, logged — and then decayed to
nothing before anything can read it.

There is no correct merge. One detector has one clock, and a detector fed two timelines is reporting
a rail that does not exist. So the demonstration and the live gateway are two configurations of the
same system, not one: set `KAIROS_CLOCK_SPEED=1` and stop the traffic generator when pointing a real
gateway at it, which is what a deployment looks like anyway.

Both halves are asserted in `apps/sentry/src/razorpay-webhook.test.ts`, so the passing one cannot
later be read as a promise that the other also holds.

## Consequences

- Anything reading a clock now has to answer which question it is asking. That is a small tax on
  every new timestamp and the reason this file exists.
- The demonstration can show a week of campaign in a few minutes without shortening a single rule,
  and every bound it shows binding is the bound a deployment would enforce.
- A reviewer can tell the two apart from the outside: an accelerated worker says so in its startup
  line, and a scaled clock is refused where it could reach a person.
