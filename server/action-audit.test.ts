// The per-bot activity ledger.
//
// decision-log.ts answers "was this allowed, and by which rule". This
// answers "what did this bot actually do", per bot, and it is a projection
// of events the bus already carries — so the tests that matter are: the
// right events become rows, the wrong ones do not, and nothing secret
// survives the trip to disk.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { actionFromEvent, appendAction, flushActionAudit, readActions } from "./action-audit.ts";

const base = {
  eventId: "e1",
  provider: "claude",
  threadId: "t1",
  createdAt: "2026-08-24T00:00:00Z",
  turnId: "turn-1",
};

describe("actionFromEvent", () => {
  it("records a tool call by the title the driver reported", () => {
    const row = actionFromEvent({ ...base, type: "item.started", itemType: "tool", title: "Bash(git status)" }, "bot-1");
    expect(row).toEqual({
      botId: "bot-1",
      threadId: "t1",
      turnId: "turn-1",
      type: "tool_call",
      name: "Bash(git status)",
    });
  });

  it("ignores reasoning items — thinking is not an action", () => {
    expect(actionFromEvent({ ...base, type: "item.started", itemType: "reasoning" }, "bot-1")).toBeNull();
  });

  it("ignores stream deltas", () => {
    expect(
      actionFromEvent({ ...base, type: "content.delta", streamKind: "assistant_text", delta: "hi" }, "bot-1"),
    ).toBeNull();
  });

  it("ignores a tool call with no title — a nameless row helps nobody", () => {
    expect(actionFromEvent({ ...base, type: "item.started", itemType: "tool", title: "  " }, "bot-1")).toBeNull();
  });

  it("omits turnId when the event carries none", () => {
    const { turnId: _turnId, ...noTurn } = base;
    const row = actionFromEvent({ ...noTurn, type: "item.started", itemType: "tool", title: "Read" }, "bot-1");
    expect(row).not.toHaveProperty("turnId");
  });
});

describe("appendAction / readActions", () => {
  it("round-trips rows newest first", async () => {
    const dir = mkdtempSync(join(tmpdir(), "maus-audit-"));
    appendAction(dir, { botId: "bot-1", threadId: "t1", type: "tool_call", name: "Bash(git status)" });
    appendAction(dir, { botId: "bot-1", threadId: "t1", type: "tool_call", name: "Read(README.md)" });
    await flushActionAudit(dir, "bot-1");
    const rows = readActions(dir, "bot-1", 10);
    expect(rows.map((row) => row.name)).toEqual(["Read(README.md)", "Bash(git status)"]);
    expect(rows[0]!.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("keeps one bot's actions out of another's file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "maus-audit-"));
    appendAction(dir, { botId: "bot-1", threadId: "t1", type: "tool_call", name: "mine" });
    appendAction(dir, { botId: "bot-2", threadId: "t2", type: "tool_call", name: "theirs" });
    await flushActionAudit(dir, "bot-1");
    await flushActionAudit(dir, "bot-2");
    expect(readActions(dir, "bot-1", 10).map((row) => row.name)).toEqual(["mine"]);
    expect(readActions(dir, "bot-2", 10).map((row) => row.name)).toEqual(["theirs"]);
  });

  it("returns nothing for a bot that has done nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "maus-audit-"));
    expect(readActions(dir, "never-ran", 10)).toEqual([]);
  });

  it("honours the limit, keeping the newest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "maus-audit-"));
    for (let i = 0; i < 5; i += 1) {
      appendAction(dir, { botId: "bot-1", threadId: "t1", type: "tool_call", name: `step-${i}` });
    }
    await flushActionAudit(dir, "bot-1");
    expect(readActions(dir, "bot-1", 2).map((row) => row.name)).toEqual(["step-4", "step-3"]);
  });

  it("survives a torn final line rather than losing the whole file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "maus-audit-"));
    appendAction(dir, { botId: "bot-1", threadId: "t1", type: "tool_call", name: "intact" });
    await flushActionAudit(dir, "bot-1");
    const { appendFileSync } = await import("node:fs");
    appendFileSync(join(dir, "audit", "bot-1.jsonl"), '{"ts":"2026-01-01T00:00:00Z","bo');
    expect(readActions(dir, "bot-1", 10).map((row) => row.name)).toEqual(["intact"]);
  });
});
