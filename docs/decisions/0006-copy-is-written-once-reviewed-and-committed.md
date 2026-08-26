# 6. Copy is written once, reviewed, and committed

- **Status** — accepted
- **Date** — 2026-08-26
- **Constrains** — every use of a language model in Kairos: `@kairos/reason`,
  `adapters/reasoner-gemini`, `apps/scribe`, and the `reason` entry in the action vocabulary

## Context

A recovery arm sends thousands of messages. The obvious way to put a model in it is to compose each
message as it goes out: the model sees the failure, the customer, the amount, and writes something
apt. Every demo of an LLM-powered product works this way, and it is the version that sounds best in
a pitch.

It is also the version where every property this project has spent five phases establishing stops
holding.

**The money path acquires a dependency nobody bounds.** A message is sent inside a held Terminus
reservation. Put a network call to somebody else's inference endpoint inside that window and the
reservation's TTL now has to cover a provider's p99, which nobody controls and which is not the same
number this week as last.

**The benchmark stops reproducing.** Phase 4 measures recovery uplift against a seeded simulation
and the same seed returns the same rupees for ever. Sampled text is not seeded. The arm would return
a different number every run and there would be no way to say whether a change made it better.

**Nobody reads what customers receive.** Generated copy that exists only as a stream is copy no
human saw. The first time anybody reads a message is when a customer complains about one.

**Every prompt carries a person.** Composing for a customer means assembling their name, their
amount, their bank and their order into a string and posting it to a third party. Free tiers
generally reserve the right to train on what they are sent.

**And it costs about forty times more.** 5,719 messages in a four-hour window, one call each.

## Decision

**The model writes copy for a *situation*, never for a customer, at build time, into a file that is
reviewed and committed.**

A situation — a `CopySegment` — is a failure class, a rail, a language and a channel:
`transient/upi/hi/contact-sms`. There are 180 of them for the whole product. The model is asked once
per situation for three alternatives; each answer goes through a validating gauntlet; what survives
is written to `data/copy-library.json`. At send time, rendering is a pure function that fills
`{amount}`, `{link}` and `{institution}`.

Five things follow, and each is one of the properties above, recovered.

**No inference on the money path.** The recovery worker holds a `Copy` index and does a map lookup.
There is no path on which an inference endpoint being slow, down, or expensive affects whether a
message is sent.

**The benchmark stays seeded while using real model output.** The library is committed, so the
harness replays genuine generated text deterministically. CI never makes a call.

**Copy that reaches customers is text in a pull request.** `git diff data/copy-library.json` is the
review. A model that starts writing something strange is caught by a person before a customer sees
it.

**No PII, structurally.** The prompt contains a class, a rail, a language, a channel and a character
budget. It cannot contain a customer's name because a customer's name is never assembled — the same
argument `ResidualInput` is built on. This is what makes a free tier's data-training terms
acceptable: there is nothing in these prompts to learn.

**180 calls, not 5,719.** Measured: ₹0.32 for eight calls at list rate, so a whole library costs
about ₹7 and fits inside a free tier's daily quota. On a metered account this is the difference
between a few rupees and a few hundred, every four hours.

### A model call is an action

`reason` is in the closed action vocabulary, so an inference call is admitted against
`allowedActions`, reserved before the call at a ceiling derived from the prompt, and reconciled
against the tokens the provider reports. The copy generator runs under a real signed mandate whose
only permitted action is `reason` — it could not send a message if its code asked it to.

Priced at the model's published rate even on a free tier, because an accounting of ₹0 would be a
true statement about this month and a false one about the first month anybody deployed.

### A missing segment is an ordinary condition

`Copy.variantsFor` returns nothing for a situation nobody wrote, and the caller falls back to the
hand-written template. So a run stopped by a budget or a daily quota leaves a *working* partial
library, and the generator is resumable rather than atomic. On a free tier that is not a nicety:
fifteen requests a minute means a full library is a run that can plausibly be interrupted.

## What this costs

**Copy cannot react to anything the segment does not carry.** No merchant-specific tone, no
seasonal variation, no reference to what the customer was buying. That is a real loss and it is the
price of the five properties above.

**The library goes stale silently unless something says so.** `promptHash` is recorded in the
library's provenance for the same reason the scorecard carries a config hash: copy written under one
set of instructions is not evidence about copy written under another.

**The gauntlet is not the last line of defence and must not be treated as one.** A variant that
passes still faces the expected-value gate, the contact cap, quiet hours and the campaign budget.
The gauntlet keeps a prompt injection a copy-quality problem; the kernel is what keeps it from
being a solvency one.

## What building it found

**A prompt-cache claim that was never measured.** `prompt.ts` said the constant-first ordering "is
what makes about a hundred and eighty calls cost roughly one prompt's worth of input". Sixteen
consecutive live calls sharing an identical 829-token prefix reported cached tokens on none of them.
The ordering stays; the claim is gone. What makes a library affordable is 180 calls instead of
5,719, which needs no cache and which anybody can check.

**Thinking tokens are billed as output, and the default is not free.** With no thinking
configuration, a request for three SMS variants on `gemini-3.6-flash` spent 751 thinking tokens
against 33 of answer, and hit `MAX_TOKENS` mid-JSON. At `thinkingLevel: "minimal"` it spent none.
Pricing `candidatesTokenCount` alone would have under-reported the call by 23×.

**The free tier's daily quota selects the model, and neither the rate nor the price would have.**
`gemini-3.6-flash` permits twenty requests *per day* — a nine-day copy library. The default is
`gemini-3.1-flash-lite`, which also costs a third as much and answers five times faster.

**The prompt was asking the model to do arithmetic it had no inputs for.** It stated the segment
*capacity* and added "including the greeting that will be added before your text and the values that
replace the placeholders" — while never saying how long a greeting or a link is. Eleven per cent of
the first recorded batch survived the gauntlet. Telling the model the characters left for its own
text took that to eighty-eight per cent. See
[ADR 0007](0007-an-indic-recovery-sms-buys-a-second-segment.md) for what stating the real number
exposed.
