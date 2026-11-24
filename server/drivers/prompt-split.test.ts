import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  deletePromptSplitReceipt,
  promptHalves,
  promptSplitFingerprints,
  readPromptSplitReceipt,
  splitSessionNote,
  splitSessionPrompt,
  volatileContextNote,
  withContextNote,
  writePromptSplitReceipt,
} from "./prompt-split.ts";
import type { PromptSplitReceipt } from "./prompt-split.ts";

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

  it("round-trips the re-anchor turn counter and drops receipts on demand", () => {
    const scope = "test-driver";
    const key = randomUUID();
    const receipt = { ...promptSplitFingerprints("stable rules", "memory"), turnsSinceFull: 4 };
    writePromptSplitReceipt(scope, key, receipt);
    expect(readPromptSplitReceipt(scope, key)).toEqual(receipt);
    deletePromptSplitReceipt(scope, key);
    expect(readPromptSplitReceipt(scope, key)).toBeNull();
    deletePromptSplitReceipt(scope, key);
    deletePromptSplitReceipt(scope, randomUUID());
  });

  it("round-trips the last reported context size and drops invalid values", () => {
    const scope = "test-driver";
    const key = randomUUID();
    const receipt = { ...promptSplitFingerprints("stable rules", "memory"), lastUsed: 167218 };
    writePromptSplitReceipt(scope, key, receipt);
    expect(readPromptSplitReceipt(scope, key)).toEqual(receipt);
    for (const invalid of [0, -4096, "167218", null, undefined]) {
      writePromptSplitReceipt(scope, key, { ...receipt, lastUsed: invalid } as unknown as PromptSplitReceipt);
      expect(readPromptSplitReceipt(scope, key)?.lastUsed).toBeUndefined();
    }
    deletePromptSplitReceipt(scope, key);
  });

  it("retains the context high-water mark separately from the final report", () => {
    const scope = "test-driver";
    const key = randomUUID();
    const receipt = { ...promptSplitFingerprints("stable rules", "memory"), lastUsed: 75000, peakUsed: 100000 };
    writePromptSplitReceipt(scope, key, receipt);
    expect(readPromptSplitReceipt(scope, key)).toEqual(receipt);
    for (const invalid of [0, -4096, "100000", null, undefined]) {
      writePromptSplitReceipt(scope, key, { ...receipt, peakUsed: invalid } as unknown as PromptSplitReceipt);
      expect(readPromptSplitReceipt(scope, key)?.peakUsed).toBeUndefined();
    }
    deletePromptSplitReceipt(scope, key);
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

  it("re-anchors the full prompt after the requested run of bare turns", () => {
    let state = splitSessionPrompt("stable rules.", "memory", null, fullSystem, "first", false, 3);
    expect(state.text).toBe(fullSystem + "\n\nfirst");
    expect(state.receipt.turnsSinceFull).toBe(0);
    state = splitSessionPrompt("stable rules.", "memory", state.receipt, fullSystem, "second", false, 3);
    expect(state.text).toBe("second");
    state = splitSessionPrompt("stable rules.", "memory", state.receipt, fullSystem, "third", false, 3);
    expect(state.text).toBe("third");
    state = splitSessionPrompt("stable rules.", "memory", state.receipt, fullSystem, "fourth", false, 3);
    expect(state.text).toBe("fourth");
    state = splitSessionPrompt("stable rules.", "memory", state.receipt, fullSystem, "fifth", false, 3);
    expect(state.text).toBe(fullSystem + "\n\nfifth");
    expect(state.receipt.turnsSinceFull).toBe(0);
    state = splitSessionPrompt("stable rules.", "memory", state.receipt, fullSystem, "sixth", false, 3);
    expect(state.text).toBe("sixth");
  });

  it("never re-anchors unless the caller opts in", () => {
    let state = splitSessionPrompt("stable rules.", "memory", null, fullSystem, "first");
    for (let turn = 2; turn <= 20; turn++) {
      state = splitSessionPrompt("stable rules.", "memory", state.receipt, fullSystem, "turn " + turn);
      expect(state.text).toBe("turn " + turn);
    }
  });

  it("counts a legacy receipt without a turn counter from zero", () => {
    const legacy = promptSplitFingerprints("stable rules.", "memory");
    let state = splitSessionPrompt("stable rules.", "memory", legacy, fullSystem, "first", false, 1);
    expect(state.text).toBe("first");
    state = splitSessionPrompt("stable rules.", "memory", state.receipt, fullSystem, "second", false, 1);
    expect(state.text).toBe(fullSystem + "\n\nsecond");
  });
});

describe("splitSessionNote", () => {
  it("sends the whole volatile half where the full prompt would go, then only its changes", () => {
    const first = splitSessionNote("stable rules.", "memory", null);
    expect(first.note).toBe(volatileContextNote("memory", false));
    const same = splitSessionNote("stable rules.", "memory", first.receipt);
    expect(same.note).toBe("");
    const moved = splitSessionNote("stable rules.", "moved to Toronto", same.receipt);
    expect(moved.note).toBe(volatileContextNote("moved to Toronto", true));
    const revised = splitSessionNote("revised rules.", "moved to Toronto", moved.receipt);
    expect(revised.note).toBe(volatileContextNote("moved to Toronto", false));
    expect(revised.receipt.turnsSinceFull).toBe(0);
  });

  it("keeps the receipt splitSessionPrompt would keep, so a session can move between the two", () => {
    const previous = splitSessionPrompt("stable rules.", "memory", null, "stable rules.\n\nmemory", "first").receipt;
    expect(splitSessionNote("stable rules.", "memory", previous, true, 8))
      .toEqual({ note: volatileContextNote("memory", true), receipt: splitSessionPrompt("stable rules.", "memory", previous, "", "", true, 8).receipt });
  });

  it("has no note for a session with no volatile half", () => {
    expect(splitSessionNote("stable rules.", "", null).note).toBe("");
  });
});

it("tells a session that holds the stable half that the volatile half was cleared when a changed stable half resends it empty", () => {
  const previous = promptSplitFingerprints("stable one", "the open task");
  expect(splitSessionNote("stable two", "", previous).note).toContain("have been cleared");
  expect(splitSessionNote("stable two", "", promptSplitFingerprints("stable one", "")).note).toBe("");
});
