import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { rememberUnbridgeable } from "./drivers/antigravity-bridge-memory.ts";
import { agentsToolBridgeRefusal, bridgedAgents, engineBridgeRefusal, type BridgeEngine, type EngineHost } from "./agents-bridge-switch.ts";
import { BRIDGE_CLI_ENV, TOOL_BRIDGE_ENV } from "./drivers/agents-bridge.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const WINDOWS = process.platform === "win32";
const folders: string[] = [];
const folder = () => { const made = mkdtempSync(join(tmpdir(), "omb-agy-bridge-")); folders.push(made); return made; };
afterAll(async () => { for (const made of folders) await removeTempDir(made); });
const write = (path: string, content: unknown = "") => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
};

const bot: { id: string; toolScope?: unknown } = { id: "bot-1" };
const CLI = "/managed/antigravity/versions/abc/antigravity";

/** A native account in a clean folder with a clean profile, as the driver lays it out. */
function setup(overrides: Partial<BridgeEngine> = {}) {
  const root = folder();
  const cwd = join(root, "repo", "work");
  mkdirSync(cwd, { recursive: true });
  const profile = join(root, "profile");
  write(join(profile, "antigravity-acp", "settings.json"), { auth: { type: "oauth-personal" } });
  write(join(profile, "antigravity-acp", "builtin", "plugins", "swarm", "plugin.json"), {});
  write(join(profile, "config", ".migrated"));
  write(join(profile, "config", "config.json"), { plugins: { swarm: { enabled: true } } });
  write(join(profile, "config", "mcp_config.json"));
  mkdirSync(join(profile, "config", "projects"), { recursive: true });
  const engine: BridgeEngine = {
    driverKind: "antigravityAgent", instanceId: "agy", config: { cli: "antigravity" }, cwd,
    nativeCli: { executablePath: CLI, version: "1.5.16" }, customMcpServers: [], ...overrides,
  };
  const host: EngineHost = { home: join(root, "home"), managedPolicyFiles: [], antigravityProfile: profile, unbridgeableFile: join(root, "antigravity-bridge.json") };
  mkdirSync(host.home, { recursive: true });
  return { root, cwd, profile, engine, host };
}

const decided = (engine: BridgeEngine, host: EngineHost, cfg = {}, env: NodeJS.ProcessEnv = {}) => agentsToolBridgeRefusal(cfg, bot, engine, env, host);

describe("bridging a native Antigravity account's turn", () => {
  it("is on with no switch, and writes the CLI it was decided for", () => {
    const { engine, host } = setup();
    expect(decided(engine, host)).toBeNull();
    const agents = bridgedAgents("thread-1", { env: { [BRIDGE_CLI_ENV]: "/stale" } }, {}, bot, engine, {}, host);
    expect(agents?.env).toEqual({ [TOOL_BRIDGE_ENV]: "1", [BRIDGE_CLI_ENV]: CLI });
  });

  it("is off when the switch is set off outright, by the operator or in config.json", () => {
    const { engine, host } = setup();
    expect(decided(engine, host, {}, { [TOOL_BRIDGE_ENV]: "0" })).toBe("the switch is off");
    expect(decided(engine, host, { features: { agentsToolBridge: false } })).toBe("the switch is off");
    expect(bridgedAgents("thread-2", { env: { [BRIDGE_CLI_ENV]: "/stale" } }, { features: { agentsToolBridge: false } }, bot, engine, {}, host)?.env)
      .toEqual({ [TOOL_BRIDGE_ENV]: "0" });
  });

  it("is off for a bot with a tool selection", () => {
    const { engine, host } = setup();
    expect(agentsToolBridgeRefusal({}, { toolScope: { mode: "only", tools: ["agents:list_bots"] } }, engine, {}, host)).toBe("the bot has a tool selection");
  });

  it.each([
    ["the default path", { config: { cli: "agy" } }],
    ["no path", { config: {} }],
    ["an absolute path", { config: { cli: "/usr/local/bin/antigravity" } }],
  ])("is off for an account set to %s", (_label, overrides) => {
    const { engine, host } = setup(overrides as Partial<BridgeEngine>);
    expect(decided(engine, host)).toBe("the switch is off");
    expect(engineBridgeRefusal({}, engine, {}, host)).toBe("the account does not name the native Antigravity CLI");
  });

  it("is on from 1.5.14, whose permission requests were recorded, to before 1.6.0", () => {
    for (const version of ["1.5.14", "1.5.15", "1.5.16", "1.5.17", "1.5.40"]) {
      const { engine, host } = setup({ nativeCli: { executablePath: CLI, version } });
      expect(decided(engine, host), version).toBeNull();
    }
    for (const version of ["1.5.6", "1.5.13", "1.6.0", "2.0.0", "unknown"]) {
      const { engine, host } = setup({ nativeCli: { executablePath: CLI, version } });
      expect(decided(engine, host), version).toMatch(/outside the releases the bridge is used with/u);
    }
    const { engine, host } = setup({ nativeCli: undefined });
    expect(decided(engine, host)).toBe("the native Antigravity CLI is not installed");
  });

  it("is off for a release recorded as asking in a spelling this version does not know, and only for that release", () => {
    const { engine, host } = setup({ nativeCli: { executablePath: CLI, version: "1.5.17" } });
    rememberUnbridgeable("1.5.17", host.unbridgeableFile);
    rememberUnbridgeable("1.5.17", host.unbridgeableFile);
    expect(decided(engine, host)).toMatch(/asked for a bridged tool in a form this version does not know/u);
    expect(decided({ ...engine, nativeCli: { executablePath: CLI, version: "1.5.16" } }, host)).toBeNull();
  });

  it("matches a recorded release by its major.minor.patch, however the install record spells it", () => {
    const { engine, host } = setup({ nativeCli: { executablePath: CLI, version: "1.5.17 " } });
    rememberUnbridgeable("1.5.17", host.unbridgeableFile);
    expect(decided(engine, host)).toMatch(/form this version does not know/u);
    expect(decided({ ...engine, nativeCli: { executablePath: CLI, version: "agy_acp_server_1.5.17" } }, host)).toMatch(/form this version does not know/u);
  });

  it("takes a damaged record for none", () => {
    const { engine, host } = setup();
    write(host.unbridgeableFile!, "{not json");
    expect(decided(engine, host)).toBeNull();
  });

  it("is off when another of the turn's servers is named like the agents server, and on beside other names", () => {
    for (const name of ["agents", "Agents", "agents_x", "AGENTS_tools", "agents-2026", "agents.x"]) {
      const { engine, host } = setup({ customMcpServers: ["notes", name] });
      expect(decided(engine, host), name).toBe("another MCP server's name starts like the agents server's");
    }
    const { engine, host } = setup({ customMcpServers: ["team_agents", "agentsx", "notes"] });
    expect(decided(engine, host)).toBeNull();
    expect(decided({ ...engine, customMcpServers: undefined }, host)).toBe("the turn's MCP servers are not known");
  });

  describe("the folders the CLI reads", () => {
    it("is on with a skills-only .agents in the folder and above, and beside a .gemini that holds only config/", () => {
      const { root, cwd, engine, host } = setup();
      write(join(cwd, ".agents", "skills", "one", "SKILL.md"), "# one");
      write(join(root, ".agents", "skills.json"), {});
      write(join(root, ".agents", ".skill-lock.json"), {});
      write(join(root, "repo", ".gemini", "config", "mcp_config.json"), {});
      expect(decided(engine, host)).toBeNull();
    });

    it.each([
      [".agents/hooks.json in the folder", (cwd: string) => write(join(cwd, ".agents", "hooks.json"), {})],
      [".agents/hooks.json two levels up", (cwd: string) => write(join(cwd, "..", "..", ".agents", "hooks.json"), {})],
      [".agents/mcp_config.json above", (cwd: string) => write(join(cwd, "..", ".agents", "mcp_config.json"), {})],
      [".agents/settings.json", (cwd: string) => write(join(cwd, ".agents", "settings.json"), {})],
      ["any other entry in .agents", (cwd: string) => write(join(cwd, ".agents", "rules", "a.md"), "x")],
      [".agents as a file", (cwd: string) => write(join(cwd, ".agents"), "x")],
      [".agents as a link", (cwd: string) => { const target = join(cwd, "..", "elsewhere"); mkdirSync(target); symlinkSync(target, join(cwd, ".agents"), "junction"); }],
      ["a legacy .agent", (cwd: string) => mkdirSync(join(cwd, "..", ".agent"))],
      ["a legacy _agents", (cwd: string) => mkdirSync(join(cwd, "_agents"))],
      ["a legacy _agent", (cwd: string) => mkdirSync(join(cwd, "_agent"))],
      ["an .antigravity", (cwd: string) => mkdirSync(join(cwd, ".antigravity"))],
      ["a workspace .gemini/config.json", (cwd: string) => write(join(cwd, "..", ".gemini", "config.json"), { personal_customization_dir: "people/{user}" })],
    ])("is off with %s", (_label, plant) => {
      const { cwd, engine, host } = setup();
      plant(cwd);
      expect(decided(engine, host)).toEqual(expect.any(String));
      expect(decided(engine, host)).not.toBeNull();
    });

    it("reads the real folder's parents of a linked folder, as the CLI does", () => {
      const { root, cwd, engine, host } = setup();
      write(join(root, "repo", ".agents", "hooks.json"), {});
      const outside = folder();
      symlinkSync(cwd, join(outside, "link"), "junction");
      expect(decided({ ...engine, cwd: join(outside, "link") }, host)).toBe("an .agents folder the CLI reads holds more than skills");
    });

    it("is off when the folder cannot be resolved", () => {
      const { root, engine, host } = setup();
      expect(decided({ ...engine, cwd: join(root, "gone") }, host)).toBe("the launch folder cannot be resolved");
    });

    it("reads the account's workspace for a turn with no folder of its own, then the home folder", () => {
      const { root, engine, host } = setup();
      const workspace = join(root, "ws");
      write(join(workspace, ".agents", "hooks.json"), {});
      expect(decided({ ...engine, cwd: undefined, config: { cli: "antigravity", workspace } }, host)).not.toBeNull();
      write(join(host.home, ".agents", "hooks.json"), {});
      expect(decided({ ...engine, cwd: undefined }, host)).not.toBeNull();
    });
  });

  describe("the account's profile", () => {
    it.each([
      ["settings beyond the sign-in", (profile: string) => write(join(profile, "antigravity-acp", "settings.json"), { auth: {}, permissions: { allow: ["mcp(*)"] } })],
      ["hooks in config/", (profile: string) => write(join(profile, "config", "hooks.json"), {})],
      ["any other entry in config/", (profile: string) => mkdirSync(join(profile, "config", "plugins"))],
      ["a plugin that is not built in", (profile: string) => write(join(profile, "config", "config.json"), { plugins: { mine: { enabled: true } } })],
      ["config.json beyond plugins", (profile: string) => write(join(profile, "config", "config.json"), { plugins: {}, hooks: {} })],
      ["a built-in plugin with hooks", (profile: string) => write(join(profile, "antigravity-acp", "builtin", "plugins", "swarm", "hooks.json"), {})],
      ["an MCP server", (profile: string) => write(join(profile, "config", "mcp_config.json"), { mcpServers: { extra: { command: "x" } } })],
      ["project settings", (profile: string) => write(join(profile, "config", "projects", "p.json"), {})],
      ["a file that is not JSON", (profile: string) => write(join(profile, "config", "config.json"), "{plugins")],
      ...(WINDOWS ? [] : [["a FIFO for a file", (profile: string) => { rmSync(join(profile, "config", "config.json")); execFileSync("mkfifo", [join(profile, "config", "config.json")]); }]]),
    ] as Array<[string, (profile: string) => void]>)("is off with %s", (_label, plant) => {
      const { profile, engine, host } = setup();
      plant(profile);
      expect(decided(engine, host)).not.toBeNull();
    });

    it("is on with an empty server list, and with no config/ yet", () => {
      const { profile, engine, host } = setup();
      write(join(profile, "config", "mcp_config.json"), { mcpServers: {} });
      expect(decided(engine, host)).toBeNull();
      const bare = setup();
      rmSync(join(bare.profile, "config"), { recursive: true });
      expect(decided(bare.engine, bare.host)).toBeNull();
    });
  });
});
