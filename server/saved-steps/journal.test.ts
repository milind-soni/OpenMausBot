import { describe, expect, it } from "vitest";
import type { JournalEntry } from "./driver-wire.ts";
import { ComputerJournal, ENTRY_BYTES, hostScope, parseJournalEntry, TOTAL_BYTES } from "./journal.ts";
import { createSavedSteps } from "./saved-steps.ts";

const scope = { botId: "b1", threadId: "t1", generation: "g1" };
const CLICK: JournalEntry = { tool: "click", arguments: { element: "Save" }, result: { isError: false } };
const TYPE: JournalEntry = { tool: "type_text", arguments: { text: "hi" }, result: { isError: false } };

describe("computer journal", () => {
  it("returns the request's calls in order with the generation they ran in", () => {
    const j = new ComputerJournal();
    j.gateChecked(scope); j.gateChecked(scope);
    j.record(scope, CLICK); j.record(scope, TYPE);
    const taken = j.take("t1", new Set(["g1"]))!;
    expect(taken.calls.map((c) => [c.tool, c.generation])).toEqual([["click", "g1"], ["type_text", "g1"]]);
    expect(taken.complete).toBe(true);
    expect(taken.tainted).toBe(false);
  });

  it("is incomplete when a gated call never journals", () => {
    const j = new ComputerJournal(); j.gateChecked(scope); j.gateChecked(scope); j.record(scope, CLICK);
    expect(j.take("t1", new Set(["g1"]))!.complete).toBe(false);
  });

  it("is incomplete when an entry arrives with no gate check behind it", () => {
    const j = new ComputerJournal(); j.record(scope, CLICK);
    const taken = j.take("t1", new Set(["g1"]))!;
    expect(taken.complete).toBe(false);
    expect(taken.calls).toHaveLength(1);
  });

  it("is incomplete past the per-thread cap", () => {
    const j = new ComputerJournal({ callsPerThread: 2 });
    for (let i = 0; i < 3; i++) { j.gateChecked(scope); j.record(scope, CLICK); }
    const taken = j.take("t1", new Set(["g1"]))!;
    expect(taken.complete).toBe(false);
    expect(taken.calls).toHaveLength(2);
  });

  it("is incomplete when an entry is larger than the per-entry budget, and keeps none of it", () => {
    const j = new ComputerJournal({ entryBytes: 200 });
    j.gateChecked(scope); j.record(scope, CLICK);
    j.gateChecked(scope); j.record(scope, { ...CLICK, arguments: { element: "x".repeat(300) } });
    const taken = j.take("t1", new Set(["g1"]))!;
    expect(taken.complete).toBe(false);
    expect(taken.calls).toHaveLength(1);
  });

  it("is incomplete once the journal holds its total budget, and frees what a taken request held", () => {
    const size = Buffer.byteLength(JSON.stringify(CLICK));
    const j = new ComputerJournal({ totalBytes: size * 2 });
    const other = { ...scope, threadId: "t2" };
    j.gateChecked(other); j.record(other, CLICK);
    j.gateChecked(scope); j.record(scope, CLICK);
    j.gateChecked(scope); j.record(scope, CLICK);
    expect(j.heldBytes()).toBe(size * 2);
    expect(j.take("t1", new Set(["g1"]))).toMatchObject({ complete: false });
    expect(j.heldBytes()).toBe(size);
    j.gateChecked(scope); j.record(scope, CLICK);
    expect(j.take("t1", new Set(["g1"]))).toMatchObject({ complete: true, calls: [{ tool: "click" }] });
    expect(j.take("t2", new Set(["g1"]))).toMatchObject({ complete: true });
    expect(j.heldBytes()).toBe(0);
  });

  it("frees an evicted thread's bytes", () => {
    const j = new ComputerJournal({ threads: 1 });
    j.record(scope, CLICK);
    j.record({ ...scope, threadId: "t2" }, CLICK);
    expect(j.heldBytes()).toBe(Buffer.byteLength(JSON.stringify(CLICK)));
  });

  it("budgets 256 KB an entry and 32 MB in all", () => {
    expect([ENTRY_BYTES, TOTAL_BYTES]).toEqual([256 * 1024, 32 * 1024 * 1024]);
  });

  it("keeps two turns of one request together and drops other requests' leftovers", () => {
    const j = new ComputerJournal();
    for (const [generation, entry] of [["g0", TYPE], ["g1", CLICK], ["g2", TYPE]] as const) {
      j.gateChecked({ ...scope, generation }); j.record({ ...scope, generation }, entry);
    }
    const taken = j.take("t1", new Set(["g1", "g2"]))!;
    expect(taken.calls.map((c) => c.generation)).toEqual(["g1", "g2"]);
    expect(taken.complete).toBe(true);
    expect(j.take("t1", new Set(["g1", "g2"]))).toBeNull();
  });

  it("returns null when nothing was seen for the asked generations", () => {
    const j = new ComputerJournal(); j.gateChecked(scope); j.record(scope, CLICK);
    expect(j.take("t1", new Set(["g9"]))).toBeNull();
    expect(j.take("other", new Set(["g1"]))).toBeNull();
  });

  it("taints only the named generation", () => {
    const j = new ComputerJournal();
    j.taint(scope);
    expect(j.take("t1", new Set(["g1"]))!.tainted).toBe(true);
    j.taint(scope);
    const g2 = { ...scope, generation: "g2" };
    j.gateChecked(g2); j.record(g2, CLICK);
    expect(j.take("t1", new Set(["g2"]))!.tainted).toBe(false);
  });

  it("is tainted when any turn of the request was, even one that made no calls", () => {
    const j = new ComputerJournal();
    j.taint(scope);
    const g2 = { ...scope, generation: "g2" };
    j.gateChecked(g2); j.record(g2, CLICK);
    const taken = j.take("t1", new Set(["g1", "g2"]))!;
    expect(taken.tainted).toBe(true);
    expect(taken.complete).toBe(true);
    expect(taken.calls.map((c) => [c.tool, c.generation])).toEqual([["click", "g2"]]);
  });

  it("keeps a gate-refused entry in the journal", () => {
    const j = new ComputerJournal(); j.gateChecked(scope); j.record(scope, { ...CLICK, result: { isError: true } });
    const taken = j.take("t1", new Set(["g1"]))!;
    expect(taken.calls[0].result.isError).toBe(true);
    expect(taken.complete).toBe(true);
  });

  it("evicts the oldest thread past the thread cap and taints what it lost", () => {
    const j = new ComputerJournal({ threads: 2 });
    for (const threadId of ["t1", "t2", "t3"]) j.record({ ...scope, threadId }, CLICK);
    expect(j.take("t1", new Set(["g1"]))).toEqual({ calls: [], complete: false, tainted: true });
    expect(j.take("t3", new Set(["g1"]))).toMatchObject({ calls: [{ tool: "click" }], tainted: false });
  });

  it("taints a request whose thread was evicted mid-request, so its later calls never look complete", () => {
    const j = new ComputerJournal();
    j.gateChecked(scope); j.record(scope, CLICK);
    for (let i = 0; i < 64; i++) {
      const other = { botId: "b2", threadId: `other-${i}`, generation: `o${i}` };
      j.gateChecked(other); j.record(other, TYPE);
    }
    j.gateChecked(scope); j.record(scope, TYPE);
    const taken = j.take("t1", new Set(["g1"]))!;
    expect(taken.calls.map((c) => c.tool)).toEqual(["type_text"]);
    expect(taken.complete).toBe(false);
    expect(taken.tainted).toBe(true);
  });

  it("taints only the generations an eviction lost, and forgets the eviction once taken", () => {
    const j = new ComputerJournal({ threads: 1 });
    j.taint({ threadId: "t1", generation: "g0" });
    j.record({ ...scope, threadId: "t2" }, CLICK);
    const g1 = { ...scope, generation: "g1" };
    j.gateChecked(g1); j.record(g1, CLICK);
    expect(j.take("t1", new Set(["g1"]))).toMatchObject({ complete: true, tainted: false });
    expect(j.take("t1", new Set(["g0"]))).toBeNull();
  });

  it("evicts the thread used least recently", () => {
    const j = new ComputerJournal({ threads: 2 });
    j.gateChecked(scope); j.record(scope, CLICK);
    j.record({ ...scope, threadId: "t2" }, CLICK);
    j.gateChecked(scope); j.record(scope, TYPE);
    j.record({ ...scope, threadId: "t3" }, CLICK);
    expect(j.take("t1", new Set(["g1"]))).toMatchObject({ complete: true, tainted: false, calls: [{ tool: "click" }, { tool: "type_text" }] });
    expect(j.take("t2", new Set(["g1"]))).toMatchObject({ calls: [], tainted: true });
  });

  it("remembers up to 64 lost generations of a thread, then treats every generation it is asked about as lost", () => {
    const evictWith = (count: number) => {
      const j = new ComputerJournal({ threads: 1 });
      for (let i = 0; i < count; i++) j.taint({ threadId: "t1", generation: `old-${i}` });
      j.record({ ...scope, threadId: "t2" }, CLICK);
      const g9 = { ...scope, generation: "g9" };
      j.gateChecked(g9); j.record(g9, CLICK);
      return j.take("t1", new Set(["g9"]));
    };
    expect(evictWith(64)).toMatchObject({ complete: true, tainted: false });
    expect(evictWith(65)).toMatchObject({ complete: false, tainted: true });
  });

  it("remembers a bounded number of evicted threads", () => {
    const j = new ComputerJournal({ threads: 1, evictedThreads: 1 });
    for (const threadId of ["t1", "t2", "t3"]) j.record({ ...scope, threadId }, CLICK);
    expect(j.take("t1", new Set(["g1"]))).toBeNull();
    expect(j.take("t2", new Set(["g1"]))).toMatchObject({ calls: [], tainted: true });
  });

  it("journals only this computer's turns", () => {
    expect(hostScope({ ...scope, kind: "computer" })).toEqual(scope);
    expect(hostScope({ ...scope, kind: "computer", boxId: null })).toBeNull();
    expect(hostScope({ ...scope, kind: "computer", localVmTarget: {} })).toBeNull();
    expect(hostScope({ ...scope, kind: "computer", teamComputerId: "tc" })).toBeNull();
    expect(hostScope({ ...scope, kind: "browser" })).toBeNull();
  });

  it("counts gate checks only for host computer turns, and taints a turn that gates another computer", () => {
    const saved = createSavedSteps({ enabled: () => true, bot: () => ({}), publish: () => {}, engines: { get: () => undefined, set: () => {} }, stopped: () => false, generation: () => "g1", patchMessage: () => {}, withholdHandoff: () => () => {}, contextChanged: () => {} });
    saved.gateChecked({ ...scope, kind: "browser" });
    expect(saved.journal.take("t1", new Set(["g1"]))).toBeNull();
    saved.gateChecked({ ...scope, kind: "computer", boxId: null });
    expect(saved.journal.take("t1", new Set(["g1"]))).toEqual({ calls: [], complete: true, tainted: true });
    saved.gateChecked({ ...scope, kind: "computer" });
    saved.journal.record(scope, CLICK);
    expect(saved.journal.take("t1", new Set(["g1"]))!.complete).toBe(true);
  });

  it("rejects malformed entries", () => {
    expect(parseJournalEntry(CLICK)).toEqual(CLICK);
    expect(parseJournalEntry({ tool: "../x", arguments: {}, result: { isError: false } })).toBeNull();
    expect(parseJournalEntry({ tool: "click", arguments: [], result: { isError: false } })).toBeNull();
    expect(parseJournalEntry({ tool: "click", arguments: {}, result: {} })).toBeNull();
    expect(parseJournalEntry(null)).toBeNull();
  });
});
