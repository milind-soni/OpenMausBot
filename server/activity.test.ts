// A bot's activity log: what it did, in plain words, with the outcome. Two
// logs already on disk feed it — the per-thread runtime events (what ran,
// did it finish) and the fleet-wide decision log (what was asked, with
// which arguments, and who said yes). These tests pin the merge: one row
// per thing that happened, never one per log that saw it.
import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { describeTool, readBotActivity, type ActivityRow } from "./activity.ts";
import type { DecisionRow } from "./decision-log.ts";
import { removeTempDir } from "./testing/cleanup.ts";

describe("describeTool", () => {
  it("names the built-in agent tools as actions", () => {
    expect(describeTool("Bash")).toEqual({ app: null, label: "Ran a command" });
    expect(describeTool("Read")).toEqual({ app: null, label: "Read a file" });
    expect(describeTool("Edit")).toEqual({ app: null, label: "Edited a file" });
    expect(describeTool("Write")).toEqual({ app: null, label: "Wrote a file" });
    expect(describeTool("WebSearch")).toEqual({ app: null, label: "Searched the web" });
  });

  it("splits an MCP connector tool into the app and the action", () => {
    expect(describeTool("mcp__claude_ai_Gmail__search_threads")).toEqual({ app: "Gmail", label: "Search threads" });
    expect(describeTool("mcp__claude_ai_Linear__save_issue")).toEqual({ app: "Linear", label: "Save issue" });
    expect(describeTool("mcp__claude_ai_Google_Calendar__list_events")).toEqual({ app: "Google Calendar", label: "List events" });
  });

  it("reads Composio's upper-case toolkit names", () => {
    expect(describeTool("GMAIL_SEND_EMAIL")).toEqual({ app: "Gmail", label: "Send email" });
    expect(describeTool("mcp__composio__GITHUB_CREATE_AN_ISSUE")).toEqual({ app: "GitHub", label: "Create an issue" });
    expect(describeTool("GOOGLESHEETS_BATCH_UPDATE")).toEqual({ app: "Google Sheets", label: "Batch update" });
  });

  it("treats the bot's computer and its teammates as apps too", () => {
    expect(describeTool("mcp__computer__click")).toEqual({ app: "Computer", label: "Click" });
    expect(describeTool("mcp__agents__delegate_bot")).toEqual({ app: "Team", label: "Delegate bot" });
  });

  it("falls back to spacing out an unknown name rather than showing it raw", () => {
    expect(describeTool("TaskUpdate")).toEqual({ app: null, label: "Task update" });
    expect(describeTool("replace_file_content")).toEqual({ app: null, label: "Replace file content" });
  });
});

let dataDir: string;
let eventsDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "omb-activity-"));
  eventsDir = join(dataDir, "events");
  mkdirSync(eventsDir);
});

afterEach(async () => {
  await removeTempDir(dataDir);
});

const decision = (row: Partial<DecisionRow> & Pick<DecisionRow, "at">) => {
  const full: DecisionRow = {
    threadId: "t1",
    botId: "b1",
    botName: "Scout",
    tool: "Bash",
    decision: "auto-approved",
    source: "auto-mode",
    ...row,
  };
  appendFileSync(join(dataDir, "decisions.ndjson"), JSON.stringify(full) + "\n");
};

let eventSeq = 0;
const event = (threadId: string, createdAt: string, body: Record<string, unknown>) => {
  const full = {
    eventId: `e${++eventSeq}`,
    provider: "claude",
    threadId,
    createdAt,
    turnId: "turn-1",
    ...body,
  };
  appendFileSync(join(eventsDir, `${threadId}.ndjson`), JSON.stringify(full) + "\n");
};

const toolRun = (threadId: string, itemId: string, tool: string, startedAt: string, ok: boolean | null) => {
  event(threadId, startedAt, { type: "item.started", itemType: "tool", itemId, title: tool });
  if (ok !== null) {
    const done = new Date(new Date(startedAt).getTime() + 1500).toISOString();
    event(threadId, done, { type: "item.completed", itemType: "tool", itemId, ok });
  }
};

const read = (overrides: Partial<Parameters<typeof readBotActivity>[0]> = {}): ActivityRow[] =>
  readBotActivity({ dataDir, eventsDir, botId: "b1", threadIds: ["t1"], limit: 50, ...overrides });

describe("readBotActivity", () => {
  it("turns a finished tool item into one row that says it ran", () => {
    toolRun("t1", "i1", "Read", "2026-09-07T09:00:00.000Z", true);
    expect(read()).toEqual([
      expect.objectContaining({ at: "2026-09-07T09:00:00.000Z", threadId: "t1", tool: "Read", label: "Read a file", outcome: "ran" }),
    ]);
  });

  it("marks a tool that finished badly as failed, and one still going as running", () => {
    toolRun("t1", "i1", "Bash", "2026-09-07T09:00:00.000Z", false);
    toolRun("t1", "i2", "WebSearch", "2026-09-07T09:01:00.000Z", null);
    expect(read().map((row) => [row.tool, row.outcome])).toEqual([
      ["WebSearch", "running"],
      ["Bash", "failed"],
    ]);
  });

  it("folds the approval that let a tool run into the tool's own row, with its arguments", () => {
    decision({ at: "2026-09-07T09:00:00.000Z", requestId: "r1", tool: "Bash", summary: "git status" });
    toolRun("t1", "i1", "Bash", "2026-09-07T09:00:00.400Z", true);
    const rows = read();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool: "Bash", summary: "git status", outcome: "ran", requestId: "r1" });
  });

  it("keeps a denied request as its own row, since nothing ran", () => {
    decision({ at: "2026-09-07T09:00:00.000Z", requestId: "r1", tool: "Bash", summary: "rm -rf build", decision: "card-shown", source: "question" });
    decision({ at: "2026-09-07T09:00:05.000Z", requestId: "r1", tool: "Bash", summary: "rm -rf build", decision: "user-denied", source: "user" });
    expect(read()).toEqual([
      expect.objectContaining({ tool: "Bash", summary: "rm -rf build", outcome: "denied", requestId: "r1" }),
    ]);
  });

  it("shows a card nobody has answered as waiting", () => {
    decision({ at: "2026-09-07T09:00:00.000Z", requestId: "r1", tool: "mcp__claude_ai_Gmail__send_email", summary: "to finance@", decision: "card-shown", source: "question" });
    expect(read()).toEqual([
      expect.objectContaining({ app: "Gmail", label: "Send email", outcome: "waiting" }),
    ]);
  });

  it("does not attach an approval to a different tool, or to a run long after it", () => {
    decision({ at: "2026-09-07T09:00:00.000Z", requestId: "r1", tool: "Bash", summary: "git status" });
    toolRun("t1", "i1", "Read", "2026-09-07T09:00:00.400Z", true);
    toolRun("t1", "i2", "Bash", "2026-09-07T09:05:00.000Z", true);
    const rows = read();
    expect(rows.map((row) => [row.tool, row.outcome, row.summary ?? null])).toEqual([
      ["Bash", "ran", null],
      ["Read", "ran", null],
      ["Bash", "allowed", "git status"],
    ]);
  });

  it("ignores other bots' decisions and threads it was not asked about", () => {
    decision({ at: "2026-09-07T09:00:00.000Z", requestId: "r1", botId: "b2", summary: "not mine" });
    toolRun("t2", "i1", "Read", "2026-09-07T09:00:00.000Z", true);
    toolRun("t1", "i2", "Edit", "2026-09-07T09:01:00.000Z", true);
    expect(read().map((row) => row.tool)).toEqual(["Edit"]);
  });

  it("returns newest first and honors the limit", () => {
    for (let i = 0; i < 5; i++) {
      toolRun("t1", `i${i}`, "Read", `2026-09-07T09:0${i}:00.000Z`, true);
    }
    expect(read({ limit: 2 }).map((row) => row.at)).toEqual([
      "2026-09-07T09:04:00.000Z",
      "2026-09-07T09:03:00.000Z",
    ]);
  });

  it("is empty, not an error, when no log exists yet", () => {
    expect(read()).toEqual([]);
  });
});
