import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadHostMcpCatalog,
  parseClaudeMcpServers,
  parseCodexMcpList,
  parseHermesMcpServers,
  parseOpenCodeMcpServers,
  writeHostMcpManifest,
} from "./host-mcp.ts";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("host MCP catalog", () => {
  it("loads stdio and HTTP Claude servers while excluding CredVault", () => {
    expect(
      parseClaudeMcpServers({
        mcpServers: {
          sentry: { command: "/bin/sentry-wrapper", args: ["mcp"] },
          memory: { type: "http", url: "http://127.0.0.1:8767/mcp" },
          credvault: { command: "/bin/credvault-mcp", args: [] },
        },
      }),
    ).toEqual({
      sentry: { type: "stdio", command: "/bin/sentry-wrapper", args: ["mcp"], env: {} },
      memory: { type: "http", url: "http://127.0.0.1:8767/mcp", headers: {} },
    });
  });

  it("keeps authenticated HTTP values inside the host catalog", () => {
    expect(
      parseCodexMcpList(
        [{
          name: "fleet",
          enabled: true,
          transport: {
            type: "streamable_http",
            url: "http://127.0.0.1:8768/mcp",
            bearer_token_env_var: "FLEET_TOKEN",
            env_http_headers: { "x-extra": "EXTRA_TOKEN" },
          },
        }],
        { FLEET_TOKEN: "host-only", EXTRA_TOKEN: "also-host-only" },
      ),
    ).toEqual({
      fleet: {
        type: "http",
        url: "http://127.0.0.1:8768/mcp",
        headers: { Authorization: "Bearer host-only", "x-extra": "also-host-only" },
      },
    });
  });

  it("loads enabled Codex transports using environment names, not manifest values", () => {
    expect(
      parseCodexMcpList(
        [
          {
            name: "langfuse",
            enabled: true,
            transport: { type: "stdio", command: "/bin/langfuse", args: [], env_vars: ["LANGFUSE_HOST"] },
          },
          { name: "off", enabled: false, transport: { type: "stdio", command: "/bin/off", args: [] } },
        ],
        { LANGFUSE_HOST: "http://127.0.0.1:3000" },
      ),
    ).toEqual({
      langfuse: {
        type: "stdio",
        command: "/bin/langfuse",
        args: [],
        env: { LANGFUSE_HOST: "http://127.0.0.1:3000" },
      },
    });
  });

  it("loads enabled OpenCode and Hermes definitions without credential servers", () => {
    expect(parseOpenCodeMcpServers({
      mcp: {
        playwright: { type: "local", command: ["npx", "-y", "playwright-mcp"], enabled: true },
        remote: { type: "remote", url: "http://127.0.0.1:9000/mcp", enabled: true },
        credvault: { type: "local", command: ["credvault", "mcp"], enabled: true },
        off: { type: "local", command: ["off"], enabled: false },
      },
    })).toEqual({
      playwright: { type: "stdio", command: "npx", args: ["-y", "playwright-mcp"], env: {} },
      remote: { type: "http", url: "http://127.0.0.1:9000/mcp", headers: {} },
    });
    expect(parseHermesMcpServers({
      cupertino: { command: "/opt/homebrew/bin/cupertino", args: ["serve"], enabled: true, lazy: true },
      memory: { url: "http://127.0.0.1:8767/mcp", enabled: true },
      off: { command: "/bin/off", enabled: false },
    })).toEqual({
      cupertino: { type: "stdio", command: "/opt/homebrew/bin/cupertino", args: ["serve"], env: {} },
      memory: { type: "http", url: "http://127.0.0.1:8767/mcp", headers: {} },
    });
  });

  it("merges the two intentional inventories and hashes names only", () => {
    const catalog = loadHostMcpCatalog({
      telemetryMode: "metadata",
      home: "/does/not/exist",
      runCodexList: () =>
        JSON.stringify([
          { name: "sentry", enabled: true, transport: { type: "stdio", command: "/bin/sentry", args: [] } },
          { name: "credvault", enabled: true, transport: { type: "stdio", command: "/bin/credvault-mcp", args: [] } },
        ]),
    });
    expect(catalog.manifest.toolInventory).toEqual([
      "openmaus-fleet:search_capabilities",
      "openmaus-fleet:select_capability",
      "openmaus-fleet:suggest_capabilities",
      "openmaus-fleet:suggest_role_overlays",
      "openmaus-host:filesystem_delete",
      "openmaus-host:filesystem_read",
      "openmaus-host:filesystem_stat",
      "openmaus-host:filesystem_write",
      "openmaus-host:shell_execute",
      "sentry",
    ]);
    expect(catalog.manifest.telemetryMode).toBe("metadata");
    expect(catalog.servers["openmaus-host"]).toEqual({ type: "builtin" });
    expect(catalog.servers["openmaus-fleet"]).toEqual({ type: "builtin", family: "fleet" });
    expect(JSON.stringify(catalog.manifest)).not.toContain("/bin/sentry");
    expect(catalog.sources).toEqual({
      claude: "missing",
      codex: "loaded",
      opencode: "missing",
      hermes: "missing",
    });
  });

  it("merges all four surface catalogs while retaining source-qualified conflicts", () => {
    const catalog = loadHostMcpCatalog({
      telemetryMode: "sanitized-content",
      home: "/does/not/exist",
      runCodexList: () => JSON.stringify([
        { name: "shared", enabled: true, transport: { type: "stdio", command: "/bin/codex-shared", args: [] } },
      ]),
      readOpenCodeConfig: () => JSON.stringify({
        mcp: { shared: { type: "local", command: ["/bin/opencode-shared"], enabled: true } },
      }),
      runHermesList: () => JSON.stringify({
        shared: { command: "/bin/hermes-shared", args: [], enabled: true },
      }),
    });
    expect(Object.keys(catalog.servers)).toEqual(expect.arrayContaining([
      "shared",
      "shared-opencode",
      "shared-hermes",
    ]));
    expect(catalog.sources).toMatchObject({ codex: "loaded", opencode: "loaded", hermes: "loaded" });
  });

  it("marks malformed source documents invalid without discarding the built-in catalog", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-host-invalid-"));
    temporary.push(home);
    writeFileSync(join(home, ".claude.json"), "{not-json");
    const catalog = loadHostMcpCatalog({
      telemetryMode: "off",
      home,
      runCodexList: () => "{not-json",
      readOpenCodeConfig: () => "{not-json",
      runHermesList: () => "{not-json",
    });

    expect(catalog.sources).toEqual({
      claude: "invalid",
      codex: "invalid",
      opencode: "invalid",
      hermes: "invalid",
    });
    expect(catalog.servers).toMatchObject({
      "openmaus-host": { type: "builtin" },
      "openmaus-fleet": { type: "builtin", family: "fleet" },
    });
  });

  it("persists only the value-free manifest and source states", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "omb-profile-"));
    temporary.push(dataDir);
    const catalog = loadHostMcpCatalog({
      telemetryMode: "off",
      home: "/does/not/exist",
      runCodexList: () =>
        JSON.stringify([
          { name: "sentry", enabled: true, transport: { type: "stdio", command: "/secret/path", args: [] } },
        ]),
    });
    const path = writeHostMcpManifest(dataDir, catalog);
    const saved = readFileSync(path, "utf8");
    expect(saved).toContain('"schema": "openmaus.capability-profile.v1"');
    expect(saved).not.toContain("/secret/path");
  });
});
