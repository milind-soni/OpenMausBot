import { describe, expect, it } from "vitest";

import { isOutboundTool } from "../../shared/outbound.ts";
import { WIDGET_SAMPLES } from "../../shared/widget-samples.ts";
import { AGENTS_ACTION_TOOLS, AGENTS_TOOL_ALIASES, agentsCallIdentities, agentsCallMember, resolveAgentsCall } from "../../shared/agents-tool-names.ts";
import { allowsTool } from "../../shared/tool-scope.ts";
import { isReadOnlyAgentTool } from "../agent-tool-policy.ts";
import { callTool, type ToolCallContext } from "./agents-call.ts";
import { availableTools, catalogProfileFromEnv, fullInputSchema } from "./agents-catalog.ts";
import type { Json } from "./agents-client.ts";
import { agentsMcp } from "./agents-mcp.ts";

const EVERYTHING = {
  OMB_BOT_ID: "bot-alias", OMB_CHIEF_OF_STAFF: "1", OMB_SKILL_AUTHORING_ENABLED: "1", OMB_SHARED_COMPUTERS_ENABLED: "1",
  OMB_VOICE_NOTES: "1", OMB_X_RESEARCH: "1", OMB_RESEARCH: "1", OMB_ESCALATIONS: "1", OMB_TEAM_PEOPLE: "1", OMB_MAUSBOT: "1",
};
const LISTED = new Set(availableTools(catalogProfileFromEnv(EVERYTHING)).map((tool) => tool.name));

/** One call per alias, as an earlier session or a saved skill writes it. */
const CALLS: Record<string, Json> = {
  list_triggers: { trigger_id: "t-1", include_address: true },
  list_trigger_events: { app: "Gmail", search: "new message" },
  create_trigger: { when: "webhook", name: "Leads", instructions: "Draft a reply.", webhook_event_types: ["lead"] },
  manage_trigger: { trigger_id: "t-1", action: "update", changes: { name: "Morning news", continuity: true } },
  create_room: { name: "Launch", member_bot_ids: ["bot-a"], bulletin: "Ship it." },
  session_read: { thread_id: "thread-old", message_id: "message-old" },
  update_widget: { widget_id: "m7", widget: WIDGET_SAMPLES.buildStatus },
  update_html: { app_id: "m9", html: "<p>v2</p>" },
  x_user_posts: { handle: "@openmausbot", limit: 5 },
  x_post: { post: "https://x.com/openmausbot/status/123", replies: true },
  x_profile: { handle: "openmausbot" },
};

/** What a call sends to the harness, and what the model reads back. */
async function run(name: string, args: Json) {
  const sent: Array<{ path: string; body?: unknown }> = [];
  const answer = { ok: true, status: 201, body: { messageId: "m1", resultId: "t-1", now: "2026-10-29T09:00:00Z", timeZone: "UTC", triggers: [], ok: true, file: "memory/log/2026-10-29.md", line: "- 09:00 · Deployed the site.", text: "Saved." } };
  const context: ToolCallContext = {
    botId: "bot-alias", threadId: "thread-alias", depth: 0, externalRuntime: false, sharedComputers: true,
    client: {
      api: async (path, init) => { sent.push({ path, body: init?.body }); return answer.body; },
      apiResponse: async (path, init) => { sent.push({ path, body: init?.body }); return answer; },
    },
  };
  return { result: await callTool(name, args, context), sent };
}

describe("the agents tools' aliases", () => {
  it("cover every member of every action tool that is not listed under its own name, and nothing else", () => {
    const members = [...new Set(Object.values(AGENTS_ACTION_TOOLS).flatMap((tool) => tool.members))].filter((member) => !LISTED.has(member));
    expect(Object.keys(AGENTS_TOOL_ALIASES).sort()).toEqual(members.sort());
    expect(Object.keys(CALLS).sort()).toEqual(members.sort());
    for (const [alias, { tools }] of Object.entries(AGENTS_TOOL_ALIASES)) {
      expect(LISTED.has(alias), alias).toBe(false);
      for (const tool of tools) expect(LISTED.has(tool), tool).toBe(true);
    }
  });

  it.each(Object.entries(CALLS))("%s goes by its own name as a call of its action tool", (alias, args) => {
    const { name, arguments: mapped } = resolveAgentsCall(alias, args);
    expect(AGENTS_TOOL_ALIASES[alias]!.tools).toContain(name);
    expect(agentsCallMember(name, mapped)).toBe(alias);
    expect(agentsCallIdentities(name, mapped)).toEqual(agentsCallIdentities(alias, args));
  });

  it.each(Object.entries(CALLS))("%s runs exactly as the same call to its action tool", async (alias, args) => {
    const direct = resolveAgentsCall(alias, args);
    expect(direct.name).not.toBe(alias);
    const viaAlias = await run(alias, args);
    expect(viaAlias.sent.length, alias).toBeGreaterThan(0);
    expect(viaAlias).toEqual(await run(direct.name, direct.arguments));
  });

  it("keep refusing what the name refused, rather than doing something else", async () => {
    expect((await run("update_widget", { widget: WIDGET_SAMPLES.buildStatus })).result).toEqual({ text: "widget_id: is required, the id show_widget returned.", isError: true });
    expect((await run("update_html", { html: "<p>x</p>" })).result).toEqual({ text: "app_id: is required, the id show_html returned.", isError: true });
    expect((await run("session_read", { thread_id: "thread-old" })).result.text).toContain("needs both thread_id and message_id");
    const created = await run("manage_trigger", { trigger_id: "t-1", action: "create", changes: { name: "A", instructions: "B", when: "webhook" } });
    expect(created.result.isError).toBe(true);
    expect(created.sent).toEqual([]);
    const deleted = { trigger_id: "t-1", action: "delete" };
    expect(resolveAgentsCall("manage_trigger", deleted)).toEqual({ name: "delete_trigger", arguments: { trigger_id: "t-1" } });
    expect(await run("manage_trigger", deleted)).toEqual(await run("delete_trigger", { trigger_id: "t-1" }));
    expect((await run("manage_trigger", { ...deleted, changes: { name: "A" } })).result).toEqual({ text: "delete_trigger takes only trigger_id and for_bot_id.", isError: true });
  });

  it("run only where the action tool is listed, as the proxy's unknown-tool check sees them", async () => {
    const call = (env: Record<string, string>, name: string) => agentsMcp({ ...EVERYTHING, OMB_HARNESS_URL: "http://127.0.0.1:9", ...env })(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: CALLS[name] } } as Json,
    );
    expect(await call({ OMB_CHIEF_OF_STAFF: "0" }, "create_room")).toMatchObject({ error: { code: -32602, message: "Unknown tool: create_room" } });
    expect(await call({ OMB_X_RESEARCH: "0" }, "x_profile")).toMatchObject({ error: { message: "Unknown tool: x_profile" } });
    const reached = await call({}, "create_room") as { result?: { isError: boolean } };
    expect(reached.result?.isError).toBe(true);
  });
});

describe("the agents action tools", () => {
  // How far a remembered "always allow" for a tool reaches: an engine may remember one by the tool's name alone.
  const READ = 0, CHANGE = 1, DELETE = 2;
  /** Each member as a tool of its own: its most far-reaching call. Moving members between rooms deletes nothing. */
  const MEMBER_REACH: Record<string, number> = {
    list_triggers: READ, list_trigger_events: READ, create_trigger: CHANGE, manage_trigger: DELETE,
    manage_room: CHANGE, create_room: CHANGE, session_search: READ, session_read: READ,
    show_widget: CHANGE, update_widget: CHANGE, show_html: CHANGE, update_html: CHANGE,
    x_search: READ, x_user_posts: READ, x_post: READ, x_profile: READ,
  };
  /** Every call each action tool makes, by its action or by the id that picks it. */
  const CALLS_OF: Record<string, Record<string, number>> = {
    trigger_info: { list: READ, events: READ },
    trigger: { create: CHANGE, update: CHANGE, pause: CHANGE, resume: CHANGE, run_now: CHANGE },
    delete_trigger: { delete: DELETE },
    manage_room: { create: CHANGE, add_members: CHANGE, remove_members: CHANGE, set_members: CHANGE, rename: CHANGE, set_bulletin: CHANGE },
    session_search: { search: READ, read: READ },
    show_widget: { show: CHANGE, update: CHANGE },
    show_html: { show: CHANGE, update: CHANGE },
    x_search: { search: READ, user_posts: READ, post: READ, profile: READ },
  };

  it("are each listed, with every call they make accounted for", () => {
    expect(Object.keys(CALLS_OF).sort()).toEqual(Object.keys(AGENTS_ACTION_TOOLS).sort());
    for (const tool of Object.keys(CALLS_OF)) {
      expect(LISTED.has(tool), tool).toBe(true);
      const actions = ((fullInputSchema(tool) as { properties: Record<string, { enum?: string[] }> }).properties.action?.enum);
      if (actions) expect(actions, tool).toEqual(Object.keys(CALLS_OF[tool]!));
    }
    for (const member of Object.values(AGENTS_ACTION_TOOLS).flatMap((tool) => tool.members)) expect(MEMBER_REACH, member).toHaveProperty(member);
  });

  it.each(Object.entries(AGENTS_ACTION_TOOLS))("%s reaches no further than any one of its members did alone, and nothing it does is outbound", (tool, { members }) => {
    const reach = Math.max(...Object.values(CALLS_OF[tool]!));
    for (const member of members) expect(reach, `${tool} against ${member}`).toBeLessThanOrEqual(MEMBER_REACH[member]!);
    if (isReadOnlyAgentTool(tool)) expect(reach, tool).toBe(READ);
    for (const name of [tool, ...members]) {
      for (const prefix of ["", "mcp__agents__", "agents__", "agents_"]) expect(isOutboundTool(`${prefix}${name}`), `${prefix}${name}`).toBe(false);
    }
  });

  it("refuses a delete through trigger before anything is sent, and points at delete_trigger", async () => {
    const refused = await run("trigger", { action: "delete", trigger_id: "t-1" });
    expect(refused).toEqual({ result: { text: "trigger does not delete: call delete_trigger with the trigger_id.", isError: true }, sent: [] });
    // delete_trigger only ever deletes, whatever action a call names
    expect(await run("delete_trigger", { action: "create", when: "webhook", name: "A", instructions: "B" })).toEqual({ result: { text: "delete_trigger needs the trigger_id from trigger_info.", isError: true }, sent: [] });
  });
});

describe("a tool selection over the agents action tools", () => {
  const tool = (name: string) => ({ kind: "mcp" as const, server: "agents", name });

  it("keeps a selector written with an action's own name meaning just those calls", () => {
    const noCreate = { deny: ["mcp:agents:create_trigger"] };
    expect(allowsTool(noCreate, tool("trigger"))).toBe(true);
    expect(allowsTool(noCreate, tool("trigger"), { action: "create" })).toBe(false);
    expect(allowsTool(noCreate, tool("trigger"), { action: "pause", trigger_id: "t-1" })).toBe(true);
    expect(allowsTool(noCreate, tool("create_trigger"), {})).toBe(false);
    const onlyCreate = { allow: ["mcp:agents:create_trigger"] };
    expect(allowsTool(onlyCreate, tool("trigger"))).toBe(true);
    expect(allowsTool(onlyCreate, tool("trigger"), { action: "create" })).toBe(true);
    expect(allowsTool(onlyCreate, tool("trigger"), { action: "delete" })).toBe(false);
    expect(allowsTool(onlyCreate, tool("trigger_info"))).toBe(false);
    const noRoomChanges = { deny: ["mcp:agents:manage_room"] };
    expect(allowsTool(noRoomChanges, tool("manage_room"), { action: "create", name: "A" })).toBe(true);
    expect(allowsTool(noRoomChanges, tool("manage_room"), { action: "rename", room_id: "r1" })).toBe(false);
    expect(allowsTool({ allow: ["mcp:agents:manage_room"] }, tool("manage_room"), { action: "create" })).toBe(false);
    expect(allowsTool({ allow: ["mcp:agents:update_widget"] }, tool("show_widget"), { widget: {} })).toBe(false);
    expect(allowsTool({ allow: ["mcp:agents:update_widget"] }, tool("show_widget"), { widget_id: "m1", widget: {} })).toBe(true);
  });

  it("reads a delete by the name that deleted before, and by delete_trigger, never by trigger", () => {
    const noManaging = { deny: ["mcp:agents:manage_trigger"] };
    expect(allowsTool(noManaging, tool("delete_trigger"))).toBe(false);
    expect(allowsTool(noManaging, tool("delete_trigger"), { trigger_id: "t-1" })).toBe(false);
    expect(allowsTool(noManaging, tool("trigger"), { action: "create" })).toBe(true);
    const noDeleting = { deny: ["mcp:agents:delete_trigger"] };
    expect(allowsTool(noDeleting, tool("delete_trigger"), { trigger_id: "t-1" })).toBe(false);
    expect(allowsTool(noDeleting, tool("manage_trigger"), { trigger_id: "t-1", action: "delete" })).toBe(false);
    expect(allowsTool(noDeleting, tool("manage_trigger"), { trigger_id: "t-1", action: "pause" })).toBe(true);
    expect(allowsTool(noDeleting, tool("trigger"), { action: "pause", trigger_id: "t-1" })).toBe(true);
    expect(allowsTool({ deny: ["mcp:agents:trigger"] }, tool("delete_trigger"), { trigger_id: "t-1" })).toBe(true);
  });

  it("lets the action tool's own name cover all it does, and a deny of it refuse every alias", () => {
    const noTriggers = { deny: ["mcp:agents:trigger"] };
    expect(allowsTool(noTriggers, tool("trigger"))).toBe(false);
    for (const name of ["create_trigger", "manage_trigger"]) expect(allowsTool(noTriggers, tool(name), {}), name).toBe(false);
    expect(allowsTool({ allow: ["mcp:agents:trigger_info"] }, tool("list_trigger_events"), {})).toBe(true);
    expect(allowsTool({ allow: ["mcp:agents:*"] }, tool("trigger"), { action: "create" })).toBe(true);
    expect(allowsTool({ allow: ["mcp:agents:trigger"] }, tool("trigger_info"))).toBe(false);
  });
});
