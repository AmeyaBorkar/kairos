# 7. An Indic recovery SMS buys a second segment

- **Status** — accepted
- **Date** — 2026-08-26
- **Constrains** — `apps/scribe`'s copy policy, the gauntlet options every generated variant is
  validated against, and the cost side of the multilingual claim in
  [MEASUREMENT.md](../MEASUREMENT.md)

## Context

An SMS uses the seven-bit GSM alphabet when every character fits it, and sixteen-bit UCS-2 when one
does not. There is no partial encoding. So a segment carries 160 characters in Latin script and 70
in Devanagari or Tamil, and the Hindi version of a sentence costs two or three times what the
English version costs, every time it is sent.

Kairos had always priced this correctly. What it had never done was ask what is left.

The copy generator's first full dry run answered that. Once the prompt was fixed to state the
characters available for the model's own text — rather than the segment capacity, which is a
different number — the arithmetic became impossible to miss:

| language | capacity | greeting | `{amount}` + `{link}` | left for copy | of which placeholders | real text |
|----------|---------:|---------:|----------------------:|--------------:|----------------------:|----------:|
| English  | 160 | 10 | 20 | 130 | 14 | **116** |
| Hindi    | 70  | 14 | 17 | 39  | 14 | **25** |
| Marathi  | 70  | 15 | 17 | 38  | 14 | **24** |
| Tamil    | 70  | 15 | 17 | 38  | 14 | **24** |

Twenty-five characters of Hindi is two words. It is not a demanding target that a better prompt
could hit; it is not a target. Every Indic variant in the first recorded batch was rejected for
length, and copy written by a person would have been rejected too.

The failure was silent before, which is the part worth noting. The prompt stated `70` and asked the
model to subtract a greeting and three substitutions it had never seen the length of, so the model
guessed high, the gauntlet rejected the result, and the rejection looked like a model that writes
long. It was not. There was nothing to write.

## Decision

**A recovery SMS gets one segment in a GSM-7 language and two in a UCS-2 one.**

At two segments the budget is 103 characters of Hindi, 102 of Marathi and Tamil — enough for a
sentence that names the bank and says what to do, which is what the uplift is made of.

The cost is stated plainly rather than absorbed: **a recovery SMS in an Indic language costs twice
what the English one costs, before anybody writes a word.** Not because of anything about the copy
— because of the encoding, and the greeting, and the length of a link.

### The worst case does not vary with the language

`maxWorstCaseSegments` is what Terminus must reserve, and it is three in every language. That is not
slack: a customer is free to be called प्रियदर्शिनी, and one Devanagari character in a *name* moves
an otherwise Latin English message to UCS-2 and cuts its capacity from 160 to 70. So the ceiling is
dominated by the substituted values rather than by the copy, and it is the same for English.

Setting it to two — which looks conservative — forbids all copy in every language. That is how the
number was found.

### A channel not billed in segments does not get an SMS's ceiling

WhatsApp is priced per conversation. Applying the SMS reservation ceiling to it rejected every
English WhatsApp message in the first full run, not because they were expensive but because two
segments of Latin script become five of UCS-2 and none of that is a price. WhatsApp's ceiling is
derived from the room its copy was given, so it still catches copy that ran away and no longer
enforces an SMS's economics on a channel that does not share them.

## Why this is the right trade, and how to find out that it is not

The claim is that a message somebody can read is worth more than twice a message they cannot. It is
not asserted here. `scoreMessage` already prices both sides of it and was written before any
generated copy existed:

- a two-segment message loses the `concise` term — 0.2 of 1.0;
- a message in a script the reader does not use is multiplied by `ILLEGIBLE_PENALTY`, which is 0.5.

So English copy sent to a Hindi reader scores at most `(0.4 + 0.4 + 0.2) x 0.5 = 0.5`, and Hindi
copy that names the rail and the action scores `(0.4 + 0.4 + 0) x 1 = 0.8` at twice the postage.
That is the trade, in the harness's own arithmetic, and the fourth benchmark arm is what settles
whether the difference survives contact with the recovery model.

`ILLEGIBLE_PENALTY = 0.5` is a guess, and it is deliberately the conservative one: scoring an
unreadable message at zero would make the multilingual case trivially winnable. If the true penalty
is milder than a half, this decision loses money and the arm will say so.

## Consequences

**The multilingual arm has a cost line, not just a benefit line.** Any claim about multilingual
recovery has to net the doubled postage against the improved response, and the scorecard is where
that happens.

**Merchants with a majority-Indic customer base see a higher per-message cost.** That is a real
commercial fact about serving India in Indian languages over SMS, and it argues for WhatsApp, which
is billed per conversation and where the second segment is free.

**The budget is derived, not typed in.** `bodyBudget` computes it from the language spec, the
greeting, and a typical customer's substituted values, so adding a language or shortening the
greeting moves the number without anybody editing a constant.
