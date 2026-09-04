import { StopSwitch } from "@kairos/terminus";
import { MemoryStore, type Store } from "throttlekit";
import { beforeEach, describe, expect, it } from "vitest";
import { engage, release, status } from "./stop.js";

const TARGET = { merchantId: "acme", campaignId: "recovery" };
const NOW = 1_800_000_000_000;

let store: Store;
beforeEach(() => {
  store = new MemoryStore({ sweepIntervalMs: 0 });
});

const text = (lines: readonly string[]) => lines.join("\n");

describe("status", () => {
  it("says a campaign nobody stopped is running", async () => {
    const report = text(await status(store, TARGET, NOW));
    expect(report).toContain("acme/recovery");
    expect(report).toContain("RUNNING");
    expect(report).not.toContain("STOPPED");
  });

  it("names who stopped it, when, and why", async () => {
    await new StopSwitch(store).engage("acme", "recovery", NOW - 3_600_000, "double sends", "asha");
    const report = text(await status(store, TARGET, NOW));
    expect(report).toContain("STOPPED");
    expect(report).toContain("asha");
    expect(report).toContain("double sends");
    expect(report).toContain("1h ago");
  });

  it("says a field is unrecorded rather than inventing one", async () => {
    await store.apply("kairos:stop:acme:recovery", () => ({
      state: { engagedAt: NOW, reason: null, by: null },
      result: null,
      ttlMs: 60_000,
      persist: true,
    }));
    expect(text(await status(store, TARGET, NOW))).toContain("unrecorded");
  });
});

describe("stop", () => {
  it("reports that it took effect, and how", async () => {
    const report = text(await engage(store, TARGET, NOW, "double sends", "asha"));
    expect(report).toContain("STOPPED");
    expect(report).toContain("next admission");
    expect(report).toContain("Nothing has been un-signed");
  });

  it("says so when it was already stopped, rather than pretending it acted", async () => {
    await engage(store, TARGET, NOW - 1000, "the first reason", "asha");
    const report = text(await engage(store, TARGET, NOW, "the second reason", "raj"));
    expect(report).toContain("already stopped");
    expect(report).toContain("the first reason");
    expect(report).not.toContain("the second reason");
  });

  it("stops only the campaign it names", async () => {
    await engage(store, TARGET, NOW, "double sends", "asha");
    const other = text(await status(store, { merchantId: "acme", campaignId: "steering" }, NOW));
    expect(other).toContain("RUNNING");
  });
});

describe("resume", () => {
  it("repeats what it released, so it is in the operator's scrollback", async () => {
    await engage(store, TARGET, NOW - 60_000, "double sends", "asha");
    const report = text(await release(store, TARGET, NOW));
    expect(report).toContain("RUNNING");
    expect(report).toContain("asha");
    expect(report).toContain("double sends");
    expect(report).toContain("nothing was dropped");
  });

  it("is honest when there was nothing to release", async () => {
    const report = text(await release(store, TARGET, NOW));
    expect(report).toContain("Nothing was stopped");
  });

  it("actually lets it run again", async () => {
    await engage(store, TARGET, NOW, "double sends", "asha");
    await release(store, TARGET, NOW);
    expect(text(await status(store, TARGET, NOW))).toContain("RUNNING");
  });
});
