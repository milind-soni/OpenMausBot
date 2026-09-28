import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codexConfigMcpServerNames, mcpServerNamesInToml, mountedMcpServerName } from "./codex-mcp-names.ts";

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
