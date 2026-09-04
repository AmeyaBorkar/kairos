import { customerRef, LANGUAGES } from "@kairos/domain";
import { languageOf } from "@kairos/simulator";
import { describe, expect, it } from "vitest";
import { simulatedDirectory } from "./directory.js";

const directory = simulatedDirectory({ mandatedShare: 0.42 });
const someone = (n: number) => customerRef(`cust_${String(n).padStart(20, "0")}`);

describe("the simulated directory", () => {
  it("resolves the same person every time", async () => {
    const first = await directory.lookup(someone(1));
    for (let i = 0; i < 20; i++) expect(await directory.lookup(someone(1))).toEqual(first);
  });

  it("agrees with the simulator about what a customer reads", async () => {
    // Not a second derivation that happens to match today. A worker that disagreed with the
    // benchmark about a customer's language would exercise copy the benchmark never measured.
    for (let i = 0; i < 100; i++) {
      const profile = await directory.lookup(someone(i));
      expect(profile?.language).toBe(languageOf(someone(i)));
    }
  });

  it("gives roughly the mandated share a token, and the rest none", async () => {
    let withToken = 0;
    const n = 2000;
    for (let i = 0; i < n; i++) {
      if ((await directory.lookup(someone(i)))?.token !== null) withToken++;
    }
    expect(withToken / n).toBeGreaterThan(0.38);
    expect(withToken / n).toBeLessThan(0.46);
  });

  it("gives nobody a token at a zero share, and everybody one at full", async () => {
    const none = simulatedDirectory({ mandatedShare: 0 });
    const all = simulatedDirectory({ mandatedShare: 1 });
    for (let i = 0; i < 50; i++) {
      expect((await none.lookup(someone(i)))?.token).toBeNull();
      expect((await all.lookup(someone(i)))?.token).not.toBeNull();
    }
  });

  it("never answers with a language outside the vocabulary", async () => {
    for (let i = 0; i < 200; i++) {
      const profile = await directory.lookup(someone(i));
      expect(LANGUAGES).toContain(profile?.language);
    }
  });

  it("always has a name to address somebody by", async () => {
    for (let i = 0; i < 200; i++) {
      expect((await directory.lookup(someone(i)))?.firstName).toBeTruthy();
    }
  });

  it("carries no contact details at all", async () => {
    // The point of the port is that personal data is resolved in exactly one place. A stand-in that
    // invented phone numbers would be teaching the wrong lesson about where they come from.
    const profile = await directory.lookup(someone(7));
    expect(Object.keys(profile ?? {}).sort()).toEqual(["firstName", "language", "token"]);
  });
});
