import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  promptHalves,
  promptSplitFingerprints,
  readPromptSplitReceipt,
  splitSessionPrompt,
  volatileContextNote,
  withContextNote,
  writePromptSplitReceipt,
} from "./prompt-split.ts";

describe("promptHalves", () => {
  it("reads the split only when a turn carries both halves", () => {
    expect(promptHalves({ system: "all", systemStable: "keep", systemVolatile: "swap" })).toEqual({
      stable: "keep",
      volatile: "swap",
    });
    expect(promptHalves({ system: "all" })).toEqual({ stable: null, volatile: "" });
    expect(promptHalves({ system: "all", systemStable: "keep" })).toEqual({ stable: null, volatile: "" });
    expect(promptHalves({ system: "all", systemVolatile: "swap" })).toEqual({ stable: null, volatile: "" });
  });
});

describe("volatileContextNote", () => {
  it("labels the current copy, announces a clearing, and stays quiet for never-set halves", () => {
    expect(volatileContextNote("Memory: likes quiet hours.", false))
      .toBe("Context from OpenMausBot updated since this conversation started; it replaces any earlier copy:\n\nMemory: likes quiet hours.");
    expect(volatileContextNote("  ", true)).toContain("have been cleared");
    expect(volatileContextNote("", false)).toBe("");
  });
});

describe("withContextNote", () => {
  it("prepends the note, keeps bare text bare, and passes through empty notes", () => {
    expect(withContextNote("note", "text")).toBe("note\n\ntext");
    expect(withContextNote("note", "")).toBe("note");
    expect(withContextNote("", "text")).toBe("text");
  });
});

describe("prompt-split receipts", () => {
  it("round-trips the halves a native session last carried", () => {
    const scope = "test-driver";
    const key = randomUUID();
    expect(readPromptSplitReceipt(scope, key)).toBeNull();
    const receipt = promptSplitFingerprints("stable rules", "memory");
    writePromptSplitReceipt(scope, key, receipt);
    expect(readPromptSplitReceipt(scope, key)).toEqual(receipt);
    expect(readPromptSplitReceipt(scope, randomUUID())).toBeNull();
  });
});

describe("splitSessionPrompt", () => {
  const fullSystem = "stable rules.\n\nmemory";

  it("delivers the full prompt to an untracked session, then sends later turns bare", () => {
    const first = splitSessionPrompt("stable rules.", "memory", null, fullSystem, "first");
    expect(first.text).toBe(fullSystem + "\n\nfirst");
    const second = splitSessionPrompt("stable rules.", "memory", first.receipt, fullSystem, "second");
    expect(second.text).toBe("second");
  });

  it("rides a changed volatile half as a labelled note", () => {
    const first = splitSessionPrompt("stable rules.", "memory", null, fullSystem, "first");
    const second = splitSessionPrompt("stable rules.", "moved to Toronto", first.receipt, fullSystem, "second");
    expect(second.text).toBe(
      "Context from OpenMausBot updated since this conversation started; it replaces any earlier copy:\n\nmoved to Toronto\n\nsecond",
    );
  });

  it("announces a cleared volatile half once", () => {
    const first = splitSessionPrompt("stable rules.", "memory", null, fullSystem, "first");
    const cleared = splitSessionPrompt("stable rules.", "", first.receipt, fullSystem, "cleared");
    expect(cleared.text).toContain("have been cleared");
    const still = splitSessionPrompt("stable rules.", "", cleared.receipt, fullSystem, "still");
    expect(still.text).toBe("still");
  });

  it("redelivers an unchanged volatile half on a turn that carries its own mention context", () => {
    const first = splitSessionPrompt("stable rules.", "Tagged: @Testy", null, fullSystem, "first");
    const untagged = splitSessionPrompt("stable rules.", "Tagged: @Testy", first.receipt, fullSystem, "untagged");
    expect(untagged.text).toBe("untagged");
    const tagged = splitSessionPrompt("stable rules.", "Tagged: @Testy", first.receipt, fullSystem, "tagged", true);
    expect(tagged.text).toContain("replaces any earlier copy");
    expect(tagged.text).toContain("Tagged: @Testy");
    expect(tagged.text.endsWith("tagged")).toBe(true);
  });

  it("re-delivers the full prompt when the stable half changes", () => {
    const first = splitSessionPrompt("old rules.", "memory", null, fullSystem, "first");
    const second = splitSessionPrompt("new rules.", "memory", first.receipt, "new rules.\n\nmemory", "second");
    expect(second.text).toBe("new rules.\n\nmemory\n\nsecond");
  });
});
