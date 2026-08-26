/**
 * The committed library, checked as an artifact rather than trusted as an output.
 *
 * `data/copy-library.json` is text that reaches customers. It is produced by a model, filtered by a
 * gauntlet, and then edited by hand whenever somebody removes a variant they did not like — and
 * that last step has no validator behind it at all. So the file is a fixture in the test suite, and
 * these are the properties a reviewer would check if they read all 468 variants, written down once
 * so that nobody has to.
 *
 * The checks here are deliberately different in kind from the gauntlet's. The gauntlet runs at
 * generation time on one variant at a time and knows about structure: placeholders, script, length,
 * prohibited phrases. These run over the whole library and know about *coverage* and *class* — that
 * every situation the product claims to serve has something to say, and that the classes forbidden
 * to name a cause do not name one. The second of those caught six variants the gauntlet had passed.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  Copy,
  type CopyVariant,
  parseLibrary,
  promptHash,
  requiredSegments,
  statsFor,
} from "@kairos/reason";
import { describe, expect, it } from "vitest";
import { COVERAGE, LIBRARY_PATH, VARIANTS_PER_SEGMENT } from "./policy.js";

const path = fileURLToPath(new URL(`../../../${LIBRARY_PATH}`, import.meta.url));
const library = parseLibrary(JSON.parse(readFileSync(path, "utf8")));
const copy = new Copy(library);
const required = requiredSegments(COVERAGE);

/** Every class whose instruction is not to name why the payment failed. */
const NO_CAUSE = new Set(["timed", "unknown"]);

/** The invention a model reaches for when it has been told not to explain. */
const INVENTED_CAUSE = /(technical|server|outage|\berror\b|तकनीकी|तांत्रिक|सर्वर|தொழில்நுட்ப|சேவையக)/i;

/** Words for the thing a `timed` message must never mention. */
const BALANCE = /(balance|funds|insufficient|शेष|बैलेंस|रक्कम|இருப்பு|நிதி)/i;

const text = (variant: CopyVariant): string => `${variant.subject ?? ""} ${variant.body}`;

const inClass = (recoverability: string): readonly CopyVariant[] =>
  library.variants.filter((variant) => variant.segment.startsWith(`${recoverability}/`));

describe("the committed copy library", () => {
  it("covers every situation the product claims to serve", () => {
    const stats = statsFor(copy, required);
    expect(stats.missing).toBe(0);
    expect(stats.segments).toBe(required.length);
  });

  it("gives the bandit something to explore almost everywhere", () => {
    // Not everywhere: rejections are not spread evenly, and the tightest budgets reject the most. A
    // segment with one variant is a segment with nothing to test against, which is a real cost of
    // generating under a character budget and is reported rather than hidden.
    const alone = required.filter((segment) => copy.variantsFor(segment).length < 2);
    expect(alone.length / required.length).toBeLessThan(0.2);
    for (const segment of required) {
      expect(copy.variantsFor(segment).length).toBeLessThanOrEqual(VARIANTS_PER_SEGMENT);
    }
  });

  it("was written under the instructions that are in this repository now", () => {
    // The same argument as the scorecard's config hash: copy written under one set of instructions
    // is not evidence about copy written under another. A library whose prompt has since changed
    // should say so rather than look current.
    expect(library.provenance.promptHash).toBe(promptHash());
  });

  it("never mentions a balance to somebody who ran out of money", () => {
    // The hardest instruction in the prompt and the one with the sharpest edge. A message that says
    // "your payment failed because you had insufficient funds" is a true statement nobody should
    // ever send.
    for (const variant of inClass("timed")) {
      expect(`${variant.id}: ${variant.body}`).toSatisfy(() => !BALANCE.test(text(variant)));
    }
  });

  it("never invents a cause where the message must not name one", () => {
    // Six variants in the first complete library did exactly this — a comforting fiction about a
    // technical fault at the bank's end, in the two classes whose instruction is to name no cause.
    // The gauntlet passed all six, because inventing a reason is not a structural defect.
    for (const variant of library.variants) {
      const [recoverability] = variant.segment.split("/");
      if (recoverability === undefined || !NO_CAUSE.has(recoverability)) continue;
      expect(`${variant.id}: ${variant.body}`).toSatisfy(() => !INVENTED_CAUSE.test(text(variant)));
    }
  });

  it("names the bank where naming it is the whole point", () => {
    // The mirror of the check above. `transient` copy exists to say *what went wrong*, because a
    // person who understands the problem acts and a person told only that something broke assumes
    // it will break again. Copy that does not name the institution is copy that has given that up.
    const transient = inClass("transient");
    const naming = transient.filter((variant) => variant.body.includes("{institution}"));
    expect(naming.length / transient.length).toBeGreaterThan(0.5);
  });

  it("carries the two placeholders every message needs", () => {
    for (const variant of library.variants) {
      expect(variant.body).toContain("{link}");
      expect(variant.body).toContain("{amount}");
    }
  });

  it("puts a subject on every email and on nothing else", () => {
    for (const variant of library.variants) {
      const isEmail = variant.segment.endsWith("/contact-email");
      expect(`${variant.id} subject=${variant.subject}`).toSatisfy(
        () => isEmail === (variant.subject !== null),
      );
    }
  });

  it("stays inside what the kernel would reserve, on the channels that reserve in segments", () => {
    // Every variant's worst case, recorded at generation time. A hand-edited library that made one
    // longer would produce a message Terminus refuses to authorise, at send time, for a customer
    // whose only distinguishing feature is their name.
    //
    // Email is exempt, and it took an email at four segments to make the point: email is billed per
    // message. A per-segment ceiling there is a bound on a cost that does not exist, and asserting
    // it would forbid the three-sentence body the prompt asks for.
    for (const variant of library.variants) {
      if (variant.segment.endsWith("/contact-email")) continue;
      expect(`${variant.id} worst=${variant.worstCaseSegments}`).toSatisfy(
        () => variant.worstCaseSegments <= 3,
      );
    }
  });

  it("records what it cost and who wrote it", () => {
    expect(library.provenance.model).toMatch(/^gemini-/);
    expect(library.provenance.calls).toBeGreaterThan(0);
    expect(library.provenance.spentPaise).toBeGreaterThan(0);
  });
});
