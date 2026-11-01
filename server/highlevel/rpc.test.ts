// Per-bot scoping and the JSON-RPC entry: tools/list shows what the bot may run, a write by a read-only bot is
// refused with the connector scope text, grants narrow the list, and a successful write is recorded.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { HIGHLEVEL_TOOL_GROUPS, HIGHLEVEL_TOOL_NAMES, highlevelGroupsForTools, highlevelToolsForGroups } from "../../shared/highlevel.ts";
import { connectorScopeRefusalText } from "../connector-verdict.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { FAKE_LOCATION_ID, startFakeHighLevel, type FakeHighLevel } from "../testing/fake-highlevel.ts";
import { describeTool } from "../activity.ts";
import { highlevelAccess, highlevelAllowedFor, highlevelSystemPrompt, type HighLevelBot } from "./access.ts";
import { HighLevelClient } from "./client.ts";
import { HIGHLEVEL_INSTRUCTIONS, HIGHLEVEL_PROMPT, HIGHLEVEL_SIGNED_OUT_TEXT } from "./instructions.ts";
import { createHighLevelHost, writeSummary } from "./host.ts";
import { HIGHLEVEL_INTERNAL_MCP_PATH, highlevelRpc, type HighLevelRpcDeps } from "./rpc.ts";
import { HighLevelStore } from "./store.ts";
import { isHighLevelWrite, type HighLevelWriteRecord } from "./tools.ts";
import { createHighLevelService } from "./service.ts";

let hl: FakeHighLevel;
const dirs: string[] = [];
beforeAll(async () => { hl = await startFakeHighLevel(); hl.tokens.add("hl_access_seed"); });
afterAll(async () => { await hl.close(); });
beforeEach(() => { hl.calls.length = 0; });
afterEach(async () => { for (const dir of dirs.splice(0)) await removeTempDir(dir); });

const call = (name: string, args: unknown = {}) => ({ method: "tools/call", params: { name, arguments: args } });
const READ = HIGHLEVEL_TOOL_NAMES.filter((name) => !isHighLevelWrite(name));
const WRITE = HIGHLEVEL_TOOL_NAMES.filter((name) => isHighLevelWrite(name));

function harness(bot: HighLevelBot, options: { connected?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omb-highlevel-rpc-"));
  dirs.push(dir);
  const store = new HighLevelStore({ dataDir: dir });
  if (options.connected !== false) store.put({ kind: "oauth", accessToken: "hl_access_seed", refreshToken: "r", expiresAt: Date.now() + 3_600_000, locationId: FAKE_LOCATION_ID, scopes: "" });
  const client = new HighLevelClient({ store, refresh: null, apiUrl: hl.url });
  const writes: HighLevelWriteRecord[] = [];
  let checks = 0;
  const deps: HighLevelRpcDeps = {
    client, assertActive: () => { checks++; },
    authorize: (name) => { const verdict = highlevelAccess(bot, name); return verdict.ok ? { ok: true } : { ok: false, text: verdict.text }; },
    onWrite: (record) => { writes.push(record); },
  };
  return { deps, writes, checks: () => checks, store, dir };
}

const legacy: HighLevelBot = { id: "b1", name: "Scout" };
const readOnly: HighLevelBot = { id: "b2", name: "Reader", connectorScopes: { apps: { highlevel: "read", gmail: "write" } } };
const contactsOnly: HighLevelBot = { id: "b3", name: "Sales", connectorTools: { highlevel: { tools: highlevelToolsForGroups(["contacts"]) } }, connectorScopes: { apps: { highlevel: "write" } } };

describe("read and write split", () => {
  it("decides by the verb: SEARCH/GET/LIST/READ read, the rest write", () => {
    expect(READ).toEqual(["HIGHLEVEL_SEARCH_CONTACTS", "HIGHLEVEL_GET_CONTACT", "HIGHLEVEL_LIST_NOTES", "HIGHLEVEL_LIST_TASKS", "HIGHLEVEL_LIST_PIPELINES",
      "HIGHLEVEL_SEARCH_OPPORTUNITIES", "HIGHLEVEL_GET_OPPORTUNITY", "HIGHLEVEL_SEARCH_CONVERSATIONS", "HIGHLEVEL_READ_CONVERSATION", "HIGHLEVEL_LIST_CALENDARS",
      "HIGHLEVEL_LIST_EVENTS", "HIGHLEVEL_GET_LOCATION"]);
    expect(WRITE).toEqual(["HIGHLEVEL_CREATE_CONTACT", "HIGHLEVEL_UPDATE_CONTACT", "HIGHLEVEL_ADD_TAGS", "HIGHLEVEL_REMOVE_TAGS", "HIGHLEVEL_ADD_NOTE", "HIGHLEVEL_ADD_TASK",
      "HIGHLEVEL_CREATE_OPPORTUNITY", "HIGHLEVEL_UPDATE_OPPORTUNITY"]);
  });

  it("maps the settings groups to tool grants and back", () => {
    expect(highlevelToolsForGroups(["contacts", "calendars"])).toContain("HIGHLEVEL_LIST_EVENTS");
    expect(highlevelToolsForGroups(["calendars"])).toEqual(["HIGHLEVEL_LIST_CALENDARS", "HIGHLEVEL_LIST_EVENTS", "HIGHLEVEL_GET_LOCATION"]);
    expect(highlevelGroupsForTools("*")).toEqual(["contacts", "pipelines", "conversations", "calendars"]);
    expect(highlevelGroupsForTools(HIGHLEVEL_TOOL_GROUPS.contacts.tools)).toEqual(["contacts"]);
    expect(new Set(Object.values(HIGHLEVEL_TOOL_GROUPS).flatMap((group) => group.tools))).toEqual(new Set(HIGHLEVEL_TOOL_NAMES));
  });
});

describe("per-bot access", () => {
  it("mounts for a legacy bot, not for one with connected apps off or a scope or grant record without highlevel", () => {
    expect(highlevelAllowedFor(legacy)).toBe(true);
    expect(highlevelAllowedFor(readOnly)).toBe(true);
    expect(highlevelAllowedFor(contactsOnly)).toBe(true);
    expect(highlevelAllowedFor({ ...legacy, composio: false })).toBe(false);
    expect(highlevelAllowedFor({ ...legacy, connectorScopes: { apps: { gmail: "write" } } })).toBe(false);
    expect(highlevelAllowedFor({ ...legacy, connectorTools: { gmail: { tools: "*" } } })).toBe(false);
    expect(highlevelAllowedFor({ ...legacy, connectorTools: {} })).toBe(false);
  });

  it("refuses a write for a read-only bot with the connector scope text and a decision row", () => {
    const verdict = highlevelAccess(readOnly, "HIGHLEVEL_ADD_NOTE");
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.text).toBe(connectorScopeRefusalText({ kind: "tools", invoked: "HIGHLEVEL_ADD_NOTE", names: ["HIGHLEVEL_ADD_NOTE"] }, "write", "Reader", "HighLevel", "Add note"));
    expect(verdict.text).toBe("OpenMausBot did not run this: HighLevel is read-only for Reader, and Add note would write to it. Ask the user before trying again.");
    expect(verdict.rows).toEqual([{ tool: "HIGHLEVEL_ADD_NOTE", decision: "auto-denied", rule: "scope:highlevel:write" }]);
    expect(highlevelAccess(readOnly, "HIGHLEVEL_GET_CONTACT")).toMatchObject({ ok: true, rows: [{ decision: "auto-approved", rule: "scope:highlevel" }] });
  });

  it("refuses a tool outside the bot's grant without naming the others", () => {
    const verdict = highlevelAccess(contactsOnly, "HIGHLEVEL_LIST_PIPELINES");
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.text).toBe('"HIGHLEVEL_LIST_PIPELINES" is not granted to this bot. This call was not performed. Ask the person to grant it in OpenMausBot if they want it run.');
    expect(verdict.text).not.toContain("HIGHLEVEL_GET_CONTACT");
    expect(verdict.rows[0]).toMatchObject({ decision: "auto-denied", rule: "connectorTools.highlevel", summary: "tool is not in this service's grant" });
    expect(highlevelAccess(contactsOnly, "HIGHLEVEL_ADD_NOTE")).toMatchObject({ ok: true, rows: [{ rule: "connectorTools.highlevel" }] });
    const off = highlevelAccess({ ...legacy, composio: false }, "HIGHLEVEL_GET_CONTACT");
    expect(off.ok).toBe(false);
    if (!off.ok) expect(off.text).toContain("Scout has not been given access to HighLevel");
  });

  it("writes the prompt part with the scope and the granted tools", () => {
    expect(highlevelSystemPrompt(legacy)).toBe(HIGHLEVEL_PROMPT);
    expect(highlevelSystemPrompt(readOnly)).toBe(HIGHLEVEL_PROMPT + " This bot may use only these connected apps: highlevel (read only). Do not try others, and do not write to a read-only one.");
    expect(highlevelSystemPrompt(contactsOnly)).toContain("granted only: HIGHLEVEL_SEARCH_CONTACTS, HIGHLEVEL_GET_CONTACT");
    expect(highlevelSystemPrompt(contactsOnly)).not.toContain("HIGHLEVEL_LIST_PIPELINES.");
    expect(HIGHLEVEL_PROMPT).toMatch(/never message anyone through the CRM/u);
    expect(HIGHLEVEL_PROMPT).toMatch(/recorded in your activity/u);
    for (const name of HIGHLEVEL_TOOL_NAMES) expect(HIGHLEVEL_PROMPT).toContain(name);
  });

  it("labels the activity rows HighLevel", () => {
    expect(describeTool("mcp__highlevel__HIGHLEVEL_ADD_NOTE")).toEqual({ app: "HighLevel", label: "Add note" });
    expect(describeTool("HIGHLEVEL_UPDATE_CONTACT")).toEqual({ app: "HighLevel", label: "Update contact" });
    expect(writeSummary({ tool: "HIGHLEVEL_UPDATE_CONTACT", kind: "contact", recordId: "contact_1", fields: ["email", "tags"] })).toBe("contact contact_1: email, tags");
  });
});

describe("highlevelRpc", () => {
  it("lists only the tools the bot may run, with the instructions, and touches no API", async () => {
    const all = await highlevelRpc({ method: "tools/list" }, harness(legacy).deps) as { tools: Array<{ name: string; inputSchema: { additionalProperties: boolean } }>; instructions: string };
    expect(all.tools.map((tool) => tool.name)).toEqual([...HIGHLEVEL_TOOL_NAMES]);
    expect(all.tools.every((tool) => tool.inputSchema.additionalProperties === false)).toBe(true);
    expect(all.instructions).toBe(HIGHLEVEL_INSTRUCTIONS);
    const reads = await highlevelRpc({ method: "tools/list" }, harness(readOnly).deps) as { tools: Array<{ name: string }> };
    expect(reads.tools.map((tool) => tool.name)).toEqual(READ);
    const contacts = await highlevelRpc({ method: "tools/list" }, harness(contactsOnly).deps) as { tools: Array<{ name: string }> };
    expect(contacts.tools.map((tool) => tool.name)).toEqual(HIGHLEVEL_TOOL_GROUPS.contacts.tools);
    expect(hl.calls).toEqual([]);
    expect(HIGHLEVEL_INTERNAL_MCP_PATH).toBe("/api/internal/highlevel/mcp");
  });

  it("validates arguments before the capability check or any request", async () => {
    const { deps, checks } = harness(legacy);
    const bad = await highlevelRpc(call("HIGHLEVEL_GET_CONTACT", { contactId: 5 }), deps) as { isError?: boolean; content: Array<{ text: string }> };
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toMatch(/do not match the advertised input schema/u);
    const unknown = await highlevelRpc(call("HIGHLEVEL_SEND_SMS", {}), deps) as { isError?: boolean; content: Array<{ text: string }> };
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0].text).toMatch(/Unknown HighLevel tool/u);
    const extra = await highlevelRpc(call("HIGHLEVEL_LIST_PIPELINES", { locationId: "x" }), deps) as { isError?: boolean };
    expect(extra.isError).toBe(true);
    expect(checks()).toBe(0);
    expect(hl.calls).toEqual([]);
    await expect(highlevelRpc({ method: "resources/list" }, deps)).rejects.toMatchObject({ status: 400 });
  });

  it("runs an allowed call with the capability checked before and after, and records a write", async () => {
    const { deps, writes, checks } = harness(legacy);
    const read = await highlevelRpc(call("HIGHLEVEL_GET_CONTACT", { contactId: "contact_1" }), deps) as { isError?: boolean; structuredContent: Record<string, unknown> };
    expect(read.isError).toBeUndefined();
    expect(read.structuredContent).toMatchObject({ id: "contact_1", email: "ada@fixture.test" });
    expect(checks()).toBeGreaterThanOrEqual(2);
    expect(writes).toEqual([]);
    const write = await highlevelRpc(call("HIGHLEVEL_UPDATE_CONTACT", { contactId: "contact_1", email: "new@fixture.test", tags: ["a"] }), deps) as { isError?: boolean };
    expect(write.isError).toBeUndefined();
    expect(writes).toEqual([{ tool: "HIGHLEVEL_UPDATE_CONTACT", kind: "contact", recordId: "contact_1", fields: ["email", "tags"] }]);
    expect(JSON.stringify(writes)).not.toContain("new@fixture.test");
    await highlevelRpc(call("HIGHLEVEL_ADD_NOTE", { contactId: "contact_1", body: "Private note text" }), deps);
    expect(writes.at(-1)).toEqual({ tool: "HIGHLEVEL_ADD_NOTE", kind: "note", recordId: "note_new", fields: ["body"] });
    expect(JSON.stringify(writes)).not.toContain("Private note");
    await highlevelRpc(call("HIGHLEVEL_CREATE_OPPORTUNITY", { pipelineId: "pipe_1", contactId: "contact_1", name: "Deal", value: 9 }), deps);
    expect(writes.at(-1)).toEqual({ tool: "HIGHLEVEL_CREATE_OPPORTUNITY", kind: "opportunity", recordId: "opp_new", fields: ["contactId", "name", "pipelineId", "value"] });
  });

  it("refuses a read-only bot's write before any request and records nothing", async () => {
    const { deps, writes } = harness(readOnly);
    const refused = await highlevelRpc(call("HIGHLEVEL_ADD_TAGS", { contactId: "contact_1", tags: ["vip"] }), deps) as { isError?: boolean; content: Array<{ text: string }> };
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toBe("OpenMausBot did not run this: HighLevel is read-only for Reader, and Add tags would write to it. Ask the user before trying again.");
    expect(hl.calls).toEqual([]);
    expect(writes).toEqual([]);
    const allowed = await highlevelRpc(call("HIGHLEVEL_LIST_NOTES", { contactId: "contact_1" }), deps) as { isError?: boolean };
    expect(allowed.isError).toBeUndefined();
    expect(hl.calls).toHaveLength(1);
  });

  it("does not record a write that failed", async () => {
    const { deps, writes } = harness(legacy);
    hl.overrides.push({ status: 403, body: { message: "no" } }, { status: 403, body: { message: "no" } });
    const failed = await highlevelRpc(call("HIGHLEVEL_ADD_NOTE", { contactId: "contact_1", body: "x" }), deps) as { isError?: boolean; content: Array<{ text: string }> };
    expect(failed.isError).toBe(true);
    expect(failed.content[0].text).toMatch(/^HighLevel refused this \(403\): the connection lacks the contacts\.write permission\./u);
    expect(writes).toEqual([]);
    hl.overrides.length = 0;
  });

  it("answers the signed-out note so the bot asks the person to reconnect", async () => {
    const { deps, store } = harness(legacy);
    store.markNeedsSignIn("revoked", store.get()!);
    const out = await highlevelRpc(call("HIGHLEVEL_GET_CONTACT", { contactId: "contact_1" }), deps) as { isError?: boolean; content: Array<{ text: string }>; structuredContent: Record<string, unknown> };
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toBe(HIGHLEVEL_SIGNED_OUT_TEXT);
    expect(out.structuredContent.signedOut).toBe(true);
    expect(hl.calls).toEqual([]);
  });
});

describe("host", () => {
  it("mounts only with a connection and an allowed bot, records writes as activity rows, and lists itself in health only while a connection is saved", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-highlevel-host-"));
    dirs.push(dir);
    const service = createHighLevelService({ dataDir: dir, env: { OMB_HIGHLEVEL_RELAY_URL: "http://127.0.0.1:9", OMB_HIGHLEVEL_API_URL: hl.url } });
    const bots = new Map<string, HighLevelBot & { color?: string }>([["b1", { ...legacy, color: "#abc" }], ["b4", { id: "b4", name: "Off", composio: false }]]);
    const rows: Array<{ threadId: string; message: Record<string, unknown> }> = [];
    const host = createHighLevelHost({ service, dataDir: dir, bot: (id) => bots.get(id), inRoom: (threadId) => threadId.startsWith("room"), appendMessage: (threadId, message) => { rows.push({ threadId, message }); } });
    expect(host.mounts(legacy)).toBe(false);
    expect(host.integration(legacy, () => "tok", "http://127.0.0.1:1")).toBeNull();
    expect(await host.health(null)).toBeNull();
    expect(await host.health(Promise.resolve({ gmail: { connected: false } }))).toEqual({ gmail: { connected: false } });
    expect(host.toolListing()?.highlevel.map((tool) => tool.name)).toEqual([...HIGHLEVEL_TOOL_NAMES]);
    service.store.put({ kind: "oauth", accessToken: "hl_access_seed", refreshToken: "r", expiresAt: Date.now() + 3_600_000, locationId: FAKE_LOCATION_ID, scopes: "" });
    expect(host.mounts(legacy)).toBe(true);
    expect(host.mounts({ id: "b4", name: "Off", composio: false })).toBe(false);
    const mounted = host.integration(legacy, () => "turn-token", "http://127.0.0.1:1")!;
    expect(mounted.args.at(-1)).toBe("highlevel");
    expect(mounted.env).toMatchObject({ OMB_MCP_TOKEN_HIGHLEVEL: "turn-token", OMB_HARNESS_URL: "http://127.0.0.1:1" });
    expect(await host.health(null)).toEqual({ highlevel: { connected: true } });
    expect(await host.health(Promise.resolve({ gmail: { connected: true } }))).toEqual({ gmail: { connected: true }, highlevel: { connected: true } });
    const result = await host.handle(call("HIGHLEVEL_ADD_NOTE", { contactId: "contact_1", body: "Secret body" }), { botId: "b1", threadId: "room-1" }, () => {}) as { isError?: boolean };
    expect(result.isError).toBeUndefined();
    expect(rows).toEqual([{ threadId: "room-1", message: { role: "bot", kind: "activity", tool: { name: "mcp__highlevel__HIGHLEVEL_ADD_NOTE", ok: true, summary: "note note_new: body" }, from: { botId: "b1", name: "Scout", color: "#abc" } } }]);
    expect(JSON.stringify(rows)).not.toContain("Secret body");
    const off = await host.handle(call("HIGHLEVEL_GET_CONTACT", { contactId: "contact_1" }), { botId: "b4", threadId: "t" }, () => {}) as { isError?: boolean; content: Array<{ text: string }> };
    expect(off.isError).toBe(true);
    expect(off.content[0].text).toContain("Off has not been given access to HighLevel");
    const listed = await host.handle({ method: "tools/list" }, { botId: "b4", threadId: "t" }, () => {}) as { tools: unknown[] };
    expect(listed.tools).toEqual([]);
    service.store.markNeedsSignIn("revoked", service.store.get()!);
    expect(await host.health(Promise.resolve({ gmail: { connected: true } }))).toEqual({ gmail: { connected: true }, highlevel: { connected: false } });
    service.disconnect();
    expect(await host.health(Promise.resolve({ gmail: { connected: true } }))).toEqual({ gmail: { connected: true } });
    expect(await host.health(null)).toBeNull();
    service.close();
  });
});
