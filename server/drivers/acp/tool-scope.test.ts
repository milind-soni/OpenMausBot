import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { ensureDirs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents } from "../../testing/events.ts";
import { GeminiAgentDriver } from "./gemini.ts";
import { acpNativeIncomingLogMessage } from "./core.ts";
import { GrokAgentDriver, grokInheritedProfile, grokToolScopeProfile } from "./grok.ts";

const cli = join(dirname(fileURLToPath(import.meta.url)), "../../testing/fake-acp-cli.ts");
const directories: string[] = [];
const instances: ProviderInstance[] = [];
afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.dispose();
  for (const directory of directories.splice(0)) await removeTempDir(directory);
});
async function fixture(driver = GrokAgentDriver, environment: Record<string, string> = {}) {
  ensureDirs(); chmodSync(cli, 0o755);
  const home = mkdtempSync(join(tmpdir(), "omb-acp-selection-")); directories.push(home);
  mkdirSync(join(home, ".grok")); writeFileSync(join(home, ".grok/auth.json"), "{}");
  const dump = join(home, "dump.json"); const launches = join(home, "launches.txt");
  const instance = await driver.create({ instanceId: "selection", displayName: "Scope fixture", enabled: true, config: { cli, fullAuto: true }, environment: { HOME: home, USERPROFILE: home, FAKE_ACP_DUMP: dump, FAKE_ACP_LAUNCH_COUNT_FILE: launches, ...environment } });
  instances.push(instance);
  return { instance, recorder: recordEvents(instance.adapter), dump, launches };
}
const init = { _meta: { grokShell: true, agentVersion: "1.0.41" } };

it("omits late MCP catalog replies and native diagnostics that could carry credentials", () => {
  const message = { jsonrpc: "2.0", id: 7, result: { result: { servers: [{ env: { ORDINARY: "private-fixture-value" } }] } } };
  expect(JSON.stringify(acpNativeIncomingLogMessage(message, new Set([7])))).not.toContain("private-fixture-value");
  expect(acpNativeIncomingLogMessage({ id: 7, error: { message: "private-fixture-value" } }, new Set([7]))).toEqual({ id: 7, jsonrpc: undefined, error: "[MCP catalog error omitted]" });
  expect(acpNativeIncomingLogMessage({ id: 8, result: "ordinary" }, new Set([7]))).toEqual({ id: 8, result: "ordinary" });
});

it("builds a curated Grok drafting profile without forwarding unknown names or wildcard selectors", () => {
  const profile = grokToolScopeProfile({ allow: ["native:read_file", "native:search_replace", "native:write", "native:unknown_tool"] }, init);
  expect(profile.toolConfig.tools.map((tool) => tool.name_override)).toEqual(["read_file", "search_replace", "write"]);
  expect(profile.injectDefaultTools).toBe(false);
  expect(profile.tools).toEqual([]);
  expect(grokToolScopeProfile({ allow: [] }, init).disallowedTools).toEqual(["read_file"]);
  expect(grokToolScopeProfile({ allow: ["native:unknown_tool"] }, init).disallowedTools).toEqual(["read_file"]);
  expect(() => grokToolScopeProfile({ allow: [] }, { _meta: { grokShell: true, agentVersion: "1.0.20" } })).toThrow(/update grok/i);
});

it("intersects an inherited Grok profile rather than re-enabling its disabled tools", () => {
  const profile = grokToolScopeProfile({ allow: ["native:read_file", "native:write"] }, init, {
    name: "read-only", description: "Existing profile", injectDefaultTools: false,
    toolConfig: { tools: [{ id: "GrokBuild:read_file", name_override: "read_file" }, { id: "OpenCode:write", name_override: "write" }] },
    disallowedTools: ["write"], permissionMode: "default", tools: [],
  });
  expect(profile.toolConfig.tools.map((tool) => tool.name_override)).toEqual(["read_file"]);
  expect(profile.disallowedTools).toContain("write");
  expect(profile.permissionMode).toBe("default");
});

it("reads the actual configured Grok profile and refuses unknown profile sources", () => {
  const home = mkdtempSync(join(tmpdir(), "omb-grok-profile-")); directories.push(home);
  const directory = join(home, ".grok"); mkdirSync(directory);
  const path = join(home, "profile.md");
  writeFileSync(path, '---\nname: reader\ndescription: Existing profile\ninjectDefaultTools: false\ntools: [read_file]\ndisallowedTools: [write]\n---\nKeep the owner instructions.\n');
  writeFileSync(join(directory, "config.toml"), `[agent]\nname="grok-build"\ndefinition=${JSON.stringify(path)}\n[cli]\nauto_update=false\n`);
  const base = grokInheritedProfile("grok", { HOME: home }, home);
  const scoped = grokToolScopeProfile({ allow: ["native:read_file", "native:write"] }, init, base);
  expect(scoped.toolConfig.tools.map((tool) => tool.name_override)).toEqual(["read_file"]);
  expect(scoped.promptBody).toContain("Keep the owner instructions.");
  expect(scoped.disallowedTools).toContain("write");
  expect(() => grokInheritedProfile("grok", { HOME: home, GROK_AGENT: "unverified" }, home)).toThrow(/existing agent profile/);
});

it("requires explicit Grok MCP helper permissions for a selected remote tool", () => {
  expect(() => grokToolScopeProfile({ allow: ["mcp:mail:read_notes"] }, init, undefined, true)).toThrow(/native:search_tool.*native:use_tool/);
  const profile = grokToolScopeProfile({ allow: ["native:search_tool", "native:use_tool", "mcp:mail:read_notes"] }, init, undefined, true);
  expect(profile.toolConfig.tools.map((tool) => tool.name_override)).toEqual(["search_tool", "use_tool"]);
});

it.each([
  '[agent] # owner restriction\nname="grok-build"\ndefinition=PROFILE # profile path',
  '["agent"]\nname="grok-build"\ndefinition=PROFILE',
  'agent.definition = PROFILE',
  'agent = { definition = PROFILE }',
  '[agent]\n"definition" = PROFILE',
])("preserves or refuses inherited restrictions in alternate TOML syntax: %s", text => {
  const home = mkdtempSync(join(tmpdir(), "omb-grok-syntax-")); directories.push(home); mkdirSync(join(home, ".grok"));
  const path = join(home, "reader.md");
  writeFileSync(path, '---\nname: reader\ndescription: Existing restriction\ntools: [read_file]\ndisallowedTools: [write]\n---\n');
  writeFileSync(join(home, ".grok/config.toml"), text.replace("PROFILE", JSON.stringify(path)) + "\n");
  let inherited: ReturnType<typeof grokInheritedProfile>;
  try { inherited = grokInheritedProfile("grok", { HOME: home }, home); }
  catch (error) { expect(String(error)).toMatch(/cannot be safely intersected/); return; }
  const selected = grokToolScopeProfile({ allow: ["native:read_file", "native:write"] }, init, inherited);
  expect(selected.toolConfig.tools.map(tool => tool.name_override)).toEqual(["read_file"]);
});

it.each(["--tools=write", "--disallowed-tools read_file", "--agent-profile", "--agent-profile=reader.md --agent-profile=other.md"])("refuses ambiguous Grok CLI restrictions before overriding a profile: %s", flags => {
  const home = mkdtempSync(join(tmpdir(), "omb-grok-cli-")); directories.push(home);
  expect(() => grokInheritedProfile(`grok ${flags}`, { HOME: home }, home)).toThrow(/cannot be safely intersected/);
});

it("establishes the restricted Grok profile on the selected model without inheriting its default harness", async () => {
  const rpc = join(mkdtempSync(join(tmpdir(), "omb-grok-rpc-")), "requests.json"); directories.push(dirname(rpc));
  const f = await fixture(GrokAgentDriver, { FAKE_ACP_GROK_VERSION: "1.0.41", FAKE_ACP_SESSION_MODELS: "fake-acp-model", FAKE_ACP_RPC_DUMP: rpc });
  await f.instance.adapter.sendTurn({ threadId: "pinned", text: "Must stay restricted", model: "fake-acp-model", toolScope: { allow: [] } });
  await f.recorder.until(event => event.type === "turn.completed");
  const launch = JSON.parse(readFileSync(f.dump, "utf8"));
  expect(launch.env.GROK_AGENT).toBe("grok-build");
  const profile = JSON.parse(readFileSync(`${f.dump}.session.json`, "utf8"))._meta.agentProfile;
  expect(profile.model).toBe("fake-acp-model");
  expect(profile.disallowedTools).toContain("read_file");
  expect(f.recorder.events.filter(event => event.type === "runtime.error")).toEqual([]);
  expect(JSON.parse(readFileSync(rpc, "utf8"))).not.toContain("session/set_model");
});

it("refuses a restricted Grok prompt when its selected model cannot be confirmed", async () => {
  const f = await fixture(GrokAgentDriver, { FAKE_ACP_GROK_VERSION: "1.0.41" });
  await f.instance.adapter.sendTurn({ threadId: "missing-model", text: "Must not run", model: "fake-acp-model", toolScope: { allow: [] } });
  await f.recorder.until(event => event.type === "turn.completed");
  expect(f.recorder.events.some(event => event.type === "runtime.error" && /confirm.*selected model/.test(event.message))).toBe(true);
});

it("refreshes a pooled Grok session when its inherited profile narrows without a bot selection change", async () => {
  const f = await fixture(GrokAgentDriver, { FAKE_ACP_GROK_VERSION: "1.0.41" });
  const home = dirname(f.dump), path = join(home, "profile.md");
  writeFileSync(join(home, ".grok/config.toml"), `[agent]\ndefinition=${JSON.stringify(path)}\n`);
  const profile = (tools: string) => `---\nname: reader\ndescription: Inherited restriction\ntools: [${tools}]\n---\n`;
  writeFileSync(path, profile("read_file, write"));
  const turn = { threadId: "pooled-profile", cwd: home, text: "Fixture", toolScope: { allow: ["native:read_file", "native:write"] } };
  await f.instance.adapter.sendTurn(turn); await f.recorder.until(event => event.type === "turn.completed");
  expect(JSON.parse(readFileSync(`${f.dump}.session.json`, "utf8"))._meta.agentProfile.toolConfig.tools.map((tool: { name_override: string }) => tool.name_override)).toContain("write");
  f.recorder.events.length = 0; writeFileSync(path, profile("read_file"));
  await f.instance.adapter.sendTurn(turn); await f.recorder.until(event => event.type === "turn.completed");
  expect(JSON.parse(readFileSync(`${f.dump}.session.json`, "utf8"))._meta.agentProfile.toolConfig.tools.map((tool: { name_override: string }) => tool.name_override)).toEqual(["read_file"]);
});

it("refuses an unsupported inherited Grok harness before spawning instead of overwriting it", async () => {
  const f = await fixture(GrokAgentDriver, { GROK_AGENT: "unverified" });
  await expect(f.instance.adapter.sendTurn({ threadId: "unverified", text: "Must not run", toolScope: { allow: [] } })).rejects.toThrow(/existing agent profile/);
  expect(existsSync(f.dump)).toBe(false);
});

it("gates eligible ACP servers and retires a pooled process when selection changes", async () => {
  const f = await fixture(GeminiAgentDriver);
  const turn = { threadId: "scoped", text: "Fixture", approvalMode: "full" as const, toolScope: { allow: ["native:*", "mcp:notes:read"] }, integrations: {
    agents: { command: "node", args: ["agents"], env: {} },
    custom: { notes: { type: "http" as const, url: "https://example.test/mcp", headers: { authorization: "Bearer synthetic" } } },
  } };
  await f.instance.adapter.sendTurn(turn);
  await f.recorder.until((event) => event.type === "turn.completed");
  const servers = JSON.parse(readFileSync(`${f.dump}.mcp.json`, "utf8"));
  expect(servers.map((server: { name: string }) => server.name)).toEqual(["notes"]);
  const env = Object.fromEntries(servers[0].env.map((entry: { name: string; value: string }) => [entry.name, entry.value]));
  expect(JSON.parse(env.OMB_GATE_TOOL_SCOPE)).toEqual({ allow: ["native:*", "mcp:notes:read"] });
  expect(servers[0].args).not.toContain("Bearer synthetic");
  const before = Number(readFileSync(f.launches, "utf8"));
  f.recorder.events.length = 0;
  await f.instance.adapter.sendTurn({ ...turn, toolScope: { allow: ["native:*", "mcp:notes:write"] } });
  await f.recorder.until((event) => event.type === "turn.completed");
  expect(Number(readFileSync(f.launches, "utf8"))).toBe(before + 1);
});

it("refuses unsupported ACP native restrictions before a prompt even in Full access", async () => {
  const f = await fixture(GeminiAgentDriver);
  await expect(f.instance.adapter.sendTurn({ threadId: "unsupported", text: "Must not run", approvalMode: "full", toolScope: { allow: [] } })).rejects.toThrow(/native tool selection.*not supported/i);
  expect(existsSync(`${f.dump}.mcp.json`)).toBe(false);
});
