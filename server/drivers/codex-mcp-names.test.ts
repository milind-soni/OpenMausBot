import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codexConfigMcp, codexConfigMcpServerNames, codexConfigRunsServer, mcpServerNamesInToml, mountedMcpServerName } from "./codex-mcp-names.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true }); });

describe("mcpServerNamesInToml", () => {
  it("collects bare, quoted and sub-table headers and ignores everything else", () => {
    const toml = `
model = "gpt-5"
[mcp_servers.fibery]
url = "https://mcp-eu-svc.fibery.io/mcp"
  [ mcp_servers.google_ads-http ]
url = "https://example.test/mcp"
[mcp_servers."with space"]
command = "npx"
[mcp_servers.'single']
command = "npx"
[mcp_servers.nested.env]
TOKEN = "x"
[projects."/tmp/mcp_servers.decoy"]
trust_level = "trusted"
# [mcp_servers.commented]
`;
    expect([...mcpServerNamesInToml(toml)].sort()).toEqual(["fibery", "google_ads-http", "nested", "single", "with space"]);
  });

  it("returns nothing for a config without servers", () => {
    expect(mcpServerNamesInToml('model = "gpt-5"\n').size).toBe(0);
  });
});

describe("codexConfigMcpServerNames", () => {
  it("reads config.toml from CODEX_HOME, falling back to ~/.codex, and tolerates a missing file", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-codex-names-"));
    dirs.push(home);
    mkdirSync(join(home, ".codex"));
    writeFileSync(join(home, ".codex", "config.toml"), '[mcp_servers.home_one]\nurl = "https://a.test"\n');
    const codexHome = join(home, "elsewhere");
    mkdirSync(codexHome);
    writeFileSync(join(codexHome, "config.toml"), '[mcp_servers.explicit]\nurl = "https://b.test"\n');
    expect([...codexConfigMcpServerNames({ HOME: home })]).toEqual(["home_one"]);
    expect([...codexConfigMcpServerNames({ HOME: home, CODEX_HOME: codexHome })]).toEqual(["explicit"]);
    expect(codexConfigMcpServerNames({ HOME: home, CODEX_HOME: join(home, "missing") }).size).toBe(0);
  });
});

describe("mountedMcpServerName", () => {
  it("keeps a free name and moves a taken one aside deterministically", () => {
    expect(mountedMcpServerName("notes", new Set())).toBe("notes");
    expect(mountedMcpServerName("fibery", new Set(["fibery"]))).toBe("fibery_openmausbot");
    expect(mountedMcpServerName("fibery", new Set(["fibery", "fibery_openmausbot"]))).toBe("fibery_openmausbot2");
  });
});

describe("codexConfigRunsServer", () => {
  const configFor = (toml: string) => {
    const home = mkdtempSync(join(tmpdir(), "omb-codex-runs-"));
    dirs.push(home);
    writeFileSync(join(home, "config.toml"), toml);
    return codexConfigMcp({ CODEX_HOME: home });
  };

  it.each([
    'mcp_servers = { notes = { url = "https://notes.example/mcp" } }',
    'mcp_servers.notes.url = "https://notes.example/mcp"',
    '[mcp_servers."not\\u0065s"]\nurl = "https://notes.example/mcp"',
  ])("reserves the parsed server name in %s", (toml) => {
    const config = configFor(toml);
    expect([...config.names]).toEqual(["notes"]);
    expect(mountedMcpServerName("notes", config.names)).toBe("notes_openmausbot");
    expect(codexConfigRunsServer(config, "notes", { type: "http", url: "https://notes.example/mcp", headers: {} })).toBe(true);
  });

  it("ignores table-looking text inside strings when the file parses", () => {
    const config = configFor('instructions = """\n[mcp_servers.decoy]\n"""\n');
    expect([...config.names]).toEqual([]);
  });

  it("still reserves header names if an unrelated setting cannot be parsed", () => {
    const config = configFor('[mcp_servers.notes]\nurl = "https://notes.example/mcp"\nunfinished = [');
    expect([...config.names]).toEqual(["notes"]);
    expect(config.tables).toEqual({});
  });

  it("knows a server config.toml already starts, as one brought in from there, and nothing else", () => {
    const config = configFor([
      "[mcp_servers.sentry]", 'command = "npx"', 'args = ["-y", "@sentry/mcp-server", 8080]', "[mcp_servers.sentry.env]", 'SENTRY_TOKEN = "t"',
      "[mcp_servers.figma]", 'url = "https://MCP.figma.com/mcp"', "[mcp_servers.figma.http_headers]", 'X-Team = "a"',
      "[mcp_servers.off]", 'command = "off-tool"', "enabled = false",
    ].join("\n"));
    const sentry = { command: "npx", args: ["-y", "@sentry/mcp-server", "8080"], env: { SENTRY_TOKEN: "t" } };
    expect(codexConfigRunsServer(config, "sentry", sentry)).toBe(true);
    expect(codexConfigRunsServer(config, "sentry", { ...sentry, args: ["-y", "@sentry/mcp-server"] })).toBe(false);
    expect(codexConfigRunsServer(config, "sentry", { ...sentry, env: { SENTRY_TOKEN: "other" } })).toBe(false);
    expect(codexConfigRunsServer(config, "other-name", sentry)).toBe(false);
    expect(codexConfigRunsServer(config, "figma", { type: "http", url: "https://mcp.figma.com/mcp", headers: { "X-Team": "a" } })).toBe(true);
    expect(codexConfigRunsServer(config, "figma", { type: "http", url: "https://mcp.figma.com/mcp", headers: {} })).toBe(false);
    expect(codexConfigRunsServer(config, "off", { command: "off-tool", args: [], env: {} })).toBe(false);
    expect(codexConfigRunsServer(configFor("[mcp_servers.sentry\ncommand = 1"), "sentry", sentry)).toBe(false);
  });
});

