// Context rebuilds by bytes, with a compaction record (Phase 0, item 0.7).
// A rebuilt context (rewind, engine switch, external update, resume
// rejection, and EVERY turn on the transcript-replay engines) used to be
// "the last 40 messages". Now it is a byte budget filled newest-first,
// starting after the latest compaction record when there is one, whose
// summary stands in for everything before it, and it says what it dropped.
import { describe, expect, it } from "vitest";

import { selectReplay, type ReplayEntry } from "./context-rebuild.ts";

const entry = (id: string, role: "user" | "assistant", text: string): ReplayEntry => ({ id, role, text });

describe("selectReplay", () => {
  it("keeps a message cap beside the byte budget, so the window can only shrink", () => {
    // server/delta-context.ts routes a teammate's result by whether it fell
    // OUTSIDE this window: inside, the replay carries it; outside, the unseen
    // mechanism hands it over separately, exactly once. That bookkeeping is
    // calibrated to the historical 40-message window, so a bytes-only window —
    // which holds far more than 40 short messages — puts a result back inside
    // the replay while the ledger still says it was never delivered.
    const many = Array.from({ length: 60 }, (_, i) => entry(`s${i}`, "user", "tiny"));
    const selection = selectReplay(many, { budgetBytes: 24_000, maxMessages: 40 });
    expect(selection.transcript).toHaveLength(40);
    expect(selection.transcript[0]!.id).toBe("s20");
    expect(selection.dropped).toBe(20);
  });

  const history = [
    entry("m1", "user", "one ".repeat(100)),
    entry("m2", "assistant", "two ".repeat(100)),
    entry("m3", "user", "three ".repeat(100)),
    entry("m4", "assistant", "four ".repeat(100)),
  ];

  it("keeps everything when it fits and drops nothing", () => {
    const r = selectReplay(history, { budgetBytes: 100_000, maxMessages: 40 });
    expect(r.transcript.map((e) => e.id)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(r.dropped).toBe(0);
  });

  it("fills the budget newest-first and reports how many older messages it dropped", () => {
    const r = selectReplay(history, { budgetBytes: 1_300, maxMessages: 40 });
    expect(r.transcript.map((e) => e.id)).toEqual(["m3", "m4"]);
    expect(r.dropped).toBe(2);
  });

  it("always keeps at least the newest message even when it alone exceeds the budget", () => {
    const r = selectReplay(history, { budgetBytes: 10, maxMessages: 40 });
    expect(r.transcript.map((e) => e.id)).toEqual(["m4"]);
    expect(r.dropped).toBe(3);
  });

  it("starts after a compaction record and leads with its summary", () => {
    const r = selectReplay(history, { budgetBytes: 100_000, maxMessages: 40, compaction: { firstKeptId: "m3", summary: "Earlier: the user asked for one and two." } });
    expect(r.transcript.map((e) => e.id)).toEqual(["m3", "m4"]);
    expect(r.summary).toBe("Earlier: the user asked for one and two.");
    expect(r.dropped).toBe(0);
    expect(r.compacted).toBe(2);
  });

  it("ignores a compaction record whose first kept message is gone (rewound away)", () => {
    const r = selectReplay(history, { budgetBytes: 100_000, maxMessages: 40, compaction: { firstKeptId: "nope", summary: "stale" } });
    expect(r.transcript).toHaveLength(4);
    expect(r.summary).toBeUndefined();
  });

  it("renders the lead lines a driver receives: the summary, then the drop notice", () => {
    const r = selectReplay(history, { budgetBytes: 1_300, maxMessages: 40, compaction: { firstKeptId: "m2", summary: "S." } });
    expect(r.transcript.map((e) => e.id)).toEqual(["m3", "m4"]);
    expect(r.lead).toEqual([
      { role: "assistant", text: "[Summary of the conversation before this point: S.]" },
      { role: "assistant", text: "[1 earlier message is not shown]" },
    ]);
  });
});
