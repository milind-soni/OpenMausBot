import { appendFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import englishCatalog from "../src/locales/en.json" with { type: "json" };
import { describedTool, describeTool, readBotActivity, type ActivityRow } from "./activity.ts";
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
    expect(describeTool("mcp__device__PHONE_CREATE_EVENT")).toEqual({ app: "Phone", label: "Create event" });
  });

  it("treats the bot's computer and its teammates as apps too", () => {
    expect(describeTool("mcp__computer__click")).toEqual({ app: "Computer", label: "Click" });
    expect(describeTool("mcp__agents__delegate_bot")).toEqual({ app: "Team", label: "Delegate bot" });
  });

  it("files the X research tools under X, not Team", () => {
    expect(describeTool("mcp__agents__x_search")).toEqual({ app: "X", label: "Searched X" });
    expect(describeTool("mcp__agents__x_user_posts")).toEqual({ app: "X", label: "Read X posts" });
    expect(describeTool("mcp__agents__x_post")).toEqual({ app: "X", label: "Read an X post" });
    expect(describeTool("mcp__agents__x_profile")).toEqual({ app: "X", label: "Looked up an X profile" });
    expect(describeTool("mcp__agents__delegate_bot")).toEqual({ app: "Team", label: "Delegate bot" });
  });

  it("files research under Research, a call by the kind of thing it looked up and never the vendor", () => {
    expect(describeTool("mcp__agents__research_search")).toEqual({ app: "Research", label: "Searched research tools" });
    expect(describeTool("mcp__agents__research_endpoint")).toEqual({ app: "Research", label: "Read a research tool" });
    const call = (input: unknown) => describeTool("mcp__agents__research_call", input);
    expect(call({ id: "apollo.people.search" })).toEqual({ app: "Research", label: "Looked up people" });
    expect(call('{"id":"crunchbase.companies.lookup","params":{}}')).toEqual({ app: "Research", label: "Looked up companies" });
    expect(call({ name: "research_call", arguments: { id: "tikhub.tiktok.user.profile" } })).toEqual({ app: "Research", label: "Looked up social data" });
    expect(call({ id: "anyapi.x.search.posts" })).toEqual({ app: "X", label: "Searched X" });
    expect(call({ id: "newsapi.news.everything" })).toEqual({ app: "Research", label: "Read the news" });
    expect(call({ id: "people.vendor.thing" })).toEqual({ app: "Research", label: "Ran a research call" });
    expect(call(undefined)).toEqual({ app: "Research", label: "Ran a research call" });
  });

  it("falls back to spacing out an unknown name rather than showing it raw", () => {
    expect(describeTool("TaskUpdate")).toEqual({ app: null, label: "Task update" });
    expect(describeTool("replace_file_content")).toEqual({ app: null, label: "Replace file content" });
  });

  it("names this app's own tools by an activity.tool key whose English is exactly the label", () => {
    const en: Record<string, string> = englishCatalog;
    const goldens = ["full", "bridged"].flatMap((name) => [...readFileSync(new URL(`./drivers/agents-catalog-goldens/${name}.tools-list.json`, import.meta.url), "utf8").matchAll(/"name":\s*"([a-z_]+)"/g)].map((match) => match[1]!));
    const named = [
      "Bash", "Read", "Edit", "MultiEdit", "Write", "Glob", "Grep", "LS", "WebSearch", "WebFetch", "Skill", "Task", "Agent", "AskUserQuestion", "TodoWrite",
      ...goldens.map((tool) => `mcp__agents__${tool}`), "mcp__agents__ask_bot", "mcp__agents__delegate_bot", "mcp__agents__send",
      ...["screenshot", "get_screen_size", "click", "move", "drag", "type_text", "key_press", "scroll", "open_url", "exec", "computer_exec", "wait_for"].map((tool) => `mcp__computer__${tool}`),
    ];
    const calls = ["apollo.people.search", "crunchbase.companies.lookup", "x.funding.rounds", "newsapi.news.everything", "tikhub.tiktok.user", "g.trends.daily", "serp.google.search", "moz.seo.backlinks", "fal.images.generate", "anyapi.x.search", "people.vendor.thing"];
    const rows = [...named.map((name) => describedTool(name)), ...calls.map((id) => describedTool("mcp__agents__research_call", { id }))];
    for (const row of rows) {
      expect(row.labelKey, row.label).toMatch(/^activity\.tool\./);
      expect(en[row.labelKey!], row.labelKey).toBe(row.label);
    }
    expect(new Set(rows.map((row) => row.labelKey)).size).toBeGreaterThan(80);
    for (const row of rows.filter((entry) => entry.appKey)) expect(en[row.appKey!], row.appKey).toBe(row.app);
    expect(["mcp__agents__list_bots", "mcp__computer__click", "mcp__agents__research_search", "mcp__agents__x_search", "mcp__claude_ai_Research__find"].map((name) => describedTool(name).appKey))
      .toEqual(["activity.app.team", "activity.app.computer", "activity.app.research", undefined, undefined]);
  });

  it.each([
    ["decide", "Decide", "activity.tool.team.decide"],
    ["extract", "Extract", "activity.tool.team.extract"],
    ["message_person", "Message person", "activity.tool.team.messagePerson"],
    ["report_bug", "Report bug", "activity.tool.team.reportBug"],
    ["delete_trigger", "Delete trigger", "activity.tool.team.deleteTrigger"],
    ["wait_until", "Wait until", "activity.tool.team.waitUntil"],
    ["list_waits", "List waits", "activity.tool.team.listWaits"],
    ["cancel_wait", "Cancel wait", "activity.tool.team.cancelWait"],
    ["start_external_agent", "Start external agent", "activity.tool.team.startExternalAgent"],
  ])("names %s with its own activity key and unchanged English", (tool, label, labelKey) => {
    expect(describedTool(`mcp__agents__${tool}`)).toEqual({ app: "Team", appKey: "activity.app.team", label, labelKey });
    expect(describeTool(`mcp__agents__${tool}`)).toEqual({ app: "Team", label });
  });

  it("keeps an unknown or third-party tool in its own words, with no key", () => {
    for (const name of ["GMAIL_SEND_EMAIL", "mcp__composio__GITHUB_CREATE_AN_ISSUE", "mcp__claude_ai_Gmail__search_threads",
      "mcp__agents__brand_new_tool", "mcp__computer__teleport", "mcp__some_server__do_thing", "TaskUpdate", "constructor"]) {
      expect(describedTool(name).labelKey, name).toBeUndefined();
    }
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
    source: "command-allowlist",
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
      expect.objectContaining({ at: "2026-09-07T09:00:00.000Z", threadId: "t1", tool: "Read", label: "Read a file", labelKey: "activity.tool.readFile", outcome: "ran" }),
    ]);
  });

  it.each([
    ["mcp__email__EMAIL_SEND_EMAIL", "Send email"],
    ["mcp__email__EMAIL_READ_EMAIL", "Read email"],
  ])("keeps %s unchanged and supplies its app's presentation key", (tool, label) => {
    toolRun("t1", "mail", tool, "2026-09-07T09:00:00.000Z", true);
    expect(read()).toEqual([expect.objectContaining({ tool, app: "Email", appKey: "activity.app.email", label, outcome: "ran" })]);
    expect(describeTool(tool)).toEqual({ app: "Email", label });
    expect(englishCatalog["activity.app.email"]).toBe("Email");
  });

  it("marks a tool that finished badly as failed, and one still going as running", () => {
    toolRun("t1", "i1", "Bash", "2026-09-07T09:00:00.000Z", false);
    toolRun("t1", "i2", "WebSearch", "2026-09-07T09:01:00.000Z", null);
    expect(read().map((row) => [row.tool, row.outcome])).toEqual([
      ["WebSearch", "running"],
      ["Bash", "failed"],
    ]);
  });

  it("shows each run's step under it, the words the working line used, with the run's turn to open it at", () => {
    event("t1", "2026-09-07T09:00:00.000Z", { type: "item.started", itemType: "tool", itemId: "i1", title: "Bash",
      step: { activity: "command", target: "scrape.py", detail: "cd ~/acme && python3 scrape.py --pages 40" } });
    event("t1", "2026-09-07T09:01:00.000Z", { type: "item.started", itemType: "tool", itemId: "i2", title: "WebFetch", step: { activity: "fetch", target: "linkedin.com" } });
    expect(read().map((row) => [row.label, row.summary, row.turnId])).toEqual([
      ["Fetched a page", "linkedin.com", "turn-1"],
      ["Ran a command", "cd ~/acme && python3 scrape.py --pages 40", "turn-1"],
    ]);
  });

  it("keeps reused provider item IDs separate across turns, including legacy no-turn events", () => {
    for (const [turnId, tool, ok, minute] of [["turn-one", "Read", true, "00"], ["turn-two", "Bash", false, "01"], [undefined, "Edit", true, "02"]] as const) {
      event("t1", `2026-09-07T09:${minute}:00.000Z`, { type: "item.started", itemType: "tool", itemId: "item_0", turnId, title: tool });
      event("t1", `2026-09-07T09:${minute}:01.000Z`, { type: "item.completed", itemType: "tool", itemId: "item_0", turnId, ok });
    }
    expect(read().map(row => [row.tool, row.turnId, row.outcome])).toEqual([
      ["Edit", undefined, "ran"], ["Bash", "turn-two", "failed"], ["Read", "turn-one", "ran"],
    ]);
  });

  it("folds the approval that let a tool run into the tool's own row, with its arguments", () => {
    decision({ at: "2026-09-07T09:00:00.000Z", requestId: "r1", tool: "Bash", summary: "git status" });
    toolRun("t1", "i1", "Bash", "2026-09-07T09:00:00.400Z", true);
    const rows = read();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool: "Bash", summary: "git status", outcome: "ran", requestId: "r1" });
  });

  it("keeps summary metadata from the same decision as the words when folding and matching a run", () => {
    const summary = { summary: "allowed PHONE_CREATE_EVENT", summaryCode: "chat.notice.phone.allowed", summaryParams: { tool: "PHONE_CREATE_EVENT" } };
    decision({ at: "2026-09-07T09:00:00.000Z", requestId: "phone", tool: "PHONE_CREATE_EVENT", decision: "card-shown", source: "question", ...summary });
    decision({ at: "2026-09-07T09:00:01.000Z", requestId: "phone", tool: "PHONE_CREATE_EVENT", decision: "user-approved", source: "user", summary: "changed", summaryCode: "chat.notice.phone.notOwner" });
    toolRun("t1", "phone", "PHONE_CREATE_EVENT", "2026-09-07T09:00:01.400Z", true);
    expect(read()).toEqual([expect.objectContaining({ ...summary, outcome: "ran" })]);
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
    expect(read()[0]).not.toHaveProperty("labelKey");
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
