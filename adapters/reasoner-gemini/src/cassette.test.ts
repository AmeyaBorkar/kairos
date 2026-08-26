import { describe, expect, it } from "vitest";
import {
  type Cassette,
  parseCassette,
  recording,
  replayable,
  replaying,
  requestDigest,
  serialiseCassette,
} from "./cassette.js";
import type { Transport } from "./transport.js";
import type { GenerateRequest, GenerateResponse } from "./wire.js";

const REQUEST: GenerateRequest = {
  systemInstruction: { parts: [{ text: "you write payment copy" }] },
  contents: [{ role: "user", parts: [{ text: "write three" }] }],
  generationConfig: {
    temperature: 1,
    maxOutputTokens: 400,
    thinkingConfig: { thinkingLevel: "minimal" },
  },
};

const RESPONSE: GenerateResponse = {
  candidates: [{ content: { parts: [{ text: "a message" }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 },
  modelVersion: "gemini-3.1-flash-lite",
};

const ALWAYS: Transport = { call: () => Promise.resolve(RESPONSE) };

describe("digesting a request", () => {
  it("does not change when a field is written in a different order", () => {
    // The reason this is canonicalised rather than stringified. Reordering a key in a request
    // builder is not a change to the request, and it must not invalidate every recording.
    const reordered: GenerateRequest = {
      contents: [{ role: "user", parts: [{ text: "write three" }] }],
      generationConfig: {
        maxOutputTokens: 400,
        thinkingConfig: { thinkingLevel: "minimal" },
        temperature: 1,
      },
      systemInstruction: { parts: [{ text: "you write payment copy" }] },
    };
    expect(requestDigest("m", reordered)).toBe(requestDigest("m", REQUEST));
  });

  it("changes when the request does", () => {
    const different = {
      ...REQUEST,
      contents: [{ role: "user" as const, parts: [{ text: "write four" }] }],
    };
    expect(requestDigest("m", different)).not.toBe(requestDigest("m", REQUEST));
  });

  it("changes when the model does, because two models are two answers", () => {
    expect(requestDigest("a", REQUEST)).not.toBe(requestDigest("b", REQUEST));
  });

  it("keeps array order, because a conversation is not a set", () => {
    const swapped: GenerateRequest = {
      ...REQUEST,
      contents: [
        { role: "user", parts: [{ text: "second" }] },
        { role: "user", parts: [{ text: "first" }] },
      ],
    };
    const original: GenerateRequest = {
      ...REQUEST,
      contents: [
        { role: "user", parts: [{ text: "first" }] },
        { role: "user", parts: [{ text: "second" }] },
      ],
    };
    expect(requestDigest("m", swapped)).not.toBe(requestDigest("m", original));
  });
});

describe("replaying", () => {
  it("answers from the recording and never from the network", async () => {
    const recorder = recording(ALWAYS, () => "a message for a transient failure");
    await recorder.call("gemini-3.1-flash-lite", REQUEST, 1000);

    const cassette = recorder.cassette("2026-08-26", "test");
    const replayed = await replaying(cassette).call("gemini-3.1-flash-lite", REQUEST, 1000);
    expect(replayed).toEqual(RESPONSE);
  });

  it("fails loudly on a miss rather than reaching for a socket", async () => {
    // The property that makes this safe in CI. A test whose prompt changed gets a named failure
    // telling it to re-record, not a live call that costs quota and passes on one machine.
    const cassette: Cassette = { recordedAt: "2026-08-26", note: "", entries: [] };
    await expect(replaying(cassette).call("m", REQUEST, 1000)).rejects.toThrow(
      /no recording for m .*cassette is stale/s,
    );
  });

  it("names what it does have, so a stale test says which recording to look at", async () => {
    const recorder = recording(ALWAYS, () => "a Hindi SMS for a bank outage");
    await recorder.call("m", REQUEST, 1000);
    const cassette = recorder.cassette("2026-08-26", "");

    const missed = {
      ...REQUEST,
      contents: [{ role: "user" as const, parts: [{ text: "other" }] }],
    };
    await expect(replaying(cassette).call("m", missed, 1000)).rejects.toThrow(
      /a Hindi SMS for a bank outage/,
    );
  });

  it("survives the round trip through a file", () => {
    const recorder = recording(ALWAYS, () => "labelled");
    return recorder.call("m", REQUEST, 1000).then(() => {
      const written = serialiseCassette(recorder.cassette("2026-08-26", "note"));
      const read = parseCassette(JSON.parse(written));
      expect(read.entries).toHaveLength(1);
      expect(read.entries[0]?.response).toEqual(replayable(RESPONSE));
      expect(written.endsWith("\n")).toBe(true);
    });
  });

  it("refuses a cassette that is not one", () => {
    expect(() => parseCassette({ entries: [] })).toThrow(/not valid/);
    expect(() => parseCassette({ recordedAt: "yesterday", note: "", entries: [] })).toThrow();
    expect(() =>
      parseCassette({
        recordedAt: "2026-08-26",
        note: "",
        entries: [{ digest: "nothex", label: "x", model: "m", response: {} }],
      }),
    ).toThrow();
  });
});

describe("recording", () => {
  it("keeps one entry per distinct request, not one per call", async () => {
    const recorder = recording(ALWAYS, () => "same every time");
    await recorder.call("m", REQUEST, 1000);
    await recorder.call("m", REQUEST, 1000);
    expect(recorder.cassette("2026-08-26", "").entries).toHaveLength(1);
  });

  it("does not record a call that failed", async () => {
    const failing: Transport = { call: () => Promise.reject(new Error("no")) };
    const recorder = recording(failing, () => "x");
    await expect(recorder.call("m", REQUEST, 1000)).rejects.toThrow();
    expect(recorder.cassette("2026-08-26", "").entries).toHaveLength(0);
  });

  it("sorts on the way out, so a re-recording produces a readable diff", () => {
    const cassette: Cassette = {
      recordedAt: "2026-08-26",
      note: "",
      entries: [
        { digest: "ffffffffffffffff", label: "z", model: "m", response: {} },
        { digest: "0000000000000000", label: "a", model: "m", response: {} },
      ],
    };
    const written = JSON.parse(serialiseCassette(cassette)) as Cassette;
    expect(written.entries.map((entry) => entry.digest)).toEqual([
      "0000000000000000",
      "ffffffffffffffff",
    ]);
  });

  it("carries no credential, because the API key is a header and a cassette holds bodies", () => {
    const recorder = recording(ALWAYS, () => "x");
    return recorder.call("m", REQUEST, 1000).then(() => {
      const written = serialiseCassette(recorder.cassette("2026-08-26", "note"));
      expect(written).not.toContain("x-goog-api-key");
      expect(written).not.toContain("AIza");
    });
  });
});
