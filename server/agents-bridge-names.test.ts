// The name a call made through the agents tool bridge is read as, from what
// the call itself carries, and the bot's Activity log, which is built from
// the event log after the fact and so can know nothing else about it.
import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readBotActivity } from "./activity.ts";
import { CATALOG_TOOL_NAMES, bridgedCallName } from "./agents-bridge-names.ts";
import { FIND_TOOL, USE_TOOL } from "./drivers/agents-bridge.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { toolDetailPreview } from "./tool-summary.ts";

describe("the catalog's names", () => {
  it("are every tool a turn could be given, whoever may call it, and neither of the bridge's own", () => {
    for (const tool of ["coordinate_bots", "list_triggers", "vm_exec", "create_bot", "shared_computer", "skill_manage", "send_voice_note", "create_options_card", "memory_log"]) {
      expect(CATALOG_TOOL_NAMES.has(tool), tool).toBe(true);
    }
    expect(CATALOG_TOOL_NAMES.has(FIND_TOOL)).toBe(false);
    expect(CATALOG_TOOL_NAMES.has(USE_TOOL)).toBe(false);
    expect(CATALOG_TOOL_NAMES.size).toBeGreaterThan(30);
  });
});

describe("bridgedCallName", () => {
  const call = { name: "list_triggers", arguments: {} };

  it("reads a use_tool call as the catalog tool it names, in the engine's own spelling", () => {
    expect(bridgedCallName("mcp__agents__use_tool", call)).toBe("mcp__agents__list_triggers");
    expect(bridgedCallName("agents_use_tool", toolDetailPreview(call))).toBe("agents_list_triggers");
    expect(bridgedCallName("use_tool", call)).toBe("list_triggers");
    expect(bridgedCallName("mcp__agents__use_tool", { name: "made_up" })).toBe("mcp__agents__use_tool");
    expect(bridgedCallName("mcp__agents__find_tool", { query: "list_triggers" })).toBe("mcp__agents__find_tool");
  });

  it("asked for a title that says the agents server, leaves a plain use_tool alone", () => {
    expect(bridgedCallName("use_tool", call, { serverNamed: true })).toBe("use_tool");
    expect(bridgedCallName("mcp__agents__use_tool", call, { serverNamed: true })).toBe("mcp__agents__list_triggers");
    expect(bridgedCallName("agents_use_tool", call, { serverNamed: true })).toBe("agents_list_triggers");
    expect(bridgedCallName("mcp__notes__use_tool", call, { serverNamed: true })).toBe("mcp__notes__use_tool");
  });
});

describe("the bot's Activity log", () => {
  let dataDir: string;
  let eventsDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "omb-bridge-activity-"));
    eventsDir = join(dataDir, "events");
    mkdirSync(eventsDir);
  });
  afterEach(async () => { await removeTempDir(dataDir); });

  let sequence = 0;
  /** One tool call as the event log keeps it: its title and the preview of its arguments. */
  const ran = (title: string, args: unknown, ok = true) => {
    const itemId = `item-${++sequence}`;
    const at = new Date(Date.UTC(2026, 9, 13, 12, 0, sequence)).toISOString();
    const row = (body: Record<string, unknown>) => appendFileSync(join(eventsDir, "t1.ndjson"), `${JSON.stringify({ eventId: `e-${itemId}-${String(body.type)}`, provider: "claude", threadId: "t1", createdAt: at, turnId: "turn-1", itemType: "tool", itemId, ...body })}\n`);
    row({ type: "item.started", title, input: toolDetailPreview(args) });
    row({ type: "item.completed", ok });
  };
  const log = () => readBotActivity({ dataDir, eventsDir, botId: "b1", threadIds: ["t1"], limit: 50 })
    .map(({ tool, app, label, outcome }) => ({ tool, app, label, outcome })).reverse();

  it("names a bridged call by the tool it ran, from the event alone", () => {
    ran("mcp__agents__use_tool", { name: "list_triggers", arguments: {} });
    ran("mcp__agents__use_tool", { name: "vm_exec", arguments: { command: "ls" } }, false);
    ran("agents_use_tool", { name: "session_search", arguments: { query: "pricing" } });
    expect(log()).toEqual([
      { tool: "mcp__agents__list_triggers", app: "Team", label: "List triggers", outcome: "ran" },
      { tool: "mcp__agents__vm_exec", app: "Team", label: "Vm exec", outcome: "failed" },
      { tool: "agents_session_search", app: null, label: "Agents session search", outcome: "ran" },
    ]);
  });

  it("leaves a call it cannot place as it was logged", () => {
    // named no tool of the catalog, or none at all
    ran("mcp__agents__use_tool", { name: "schedule_task" }, false);
    ran("mcp__agents__use_tool", { arguments: { name: "vm_exec" } }, false);
    // a plain use_tool is not known to be this server's: Codex logs any server's tool by its name alone
    ran("use_tool", { name: "list_triggers" });
    // another server's, and the bridge's other tool
    ran("mcp__notes__use_tool", { name: "list_triggers" });
    ran("mcp__agents__find_tool", { query: "routines" });
    ran("mcp__agents__list_bots", {});
    expect(log()).toEqual([
      { tool: "mcp__agents__use_tool", app: "Team", label: "Use tool", outcome: "failed" },
      { tool: "mcp__agents__use_tool", app: "Team", label: "Use tool", outcome: "failed" },
      { tool: "use_tool", app: null, label: "Use tool", outcome: "ran" },
      { tool: "mcp__notes__use_tool", app: "Notes", label: "Use tool", outcome: "ran" },
      { tool: "mcp__agents__find_tool", app: "Team", label: "Find tool", outcome: "ran" },
      { tool: "mcp__agents__list_bots", app: "Team", label: "List bots", outcome: "ran" },
    ]);
  });
});
