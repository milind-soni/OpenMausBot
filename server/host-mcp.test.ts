import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadHostMcpCatalog,
  loadHostMcpCatalogs,
  parseClaudeMcpServers,
  parseCodexMcpList,
  parseHermesMcpServers,
  parseOpenCodeMcpServers,
  writeHostMcpManifest,
} from "./host-mcp.ts";

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

  it("does not project the ambient host catalog or built-in tools through the observer compatibility view", () => {
    const catalog = loadHostMcpCatalog({
      home: "/does/not/exist",
      runCodexList: () =>
        JSON.stringify([
          { name: "sentry", enabled: true, transport: { type: "stdio", command: "/bin/sentry", args: [] } },
          { name: "credvault", enabled: true, transport: { type: "stdio", command: "/bin/credvault-mcp", args: [] } },
        ]),
    });
    expect(catalog.manifest).toMatchObject({
      profile: "observer-router",
      telemetryMode: "metadata",
      toolInventory: [],
    });
    expect(catalog.servers).toEqual({});
    expect(JSON.stringify(catalog.manifest)).not.toContain("/bin/sentry");
    expect(catalog.sources).toEqual({
      claude: "missing",
      codex: "loaded",
      opencode: "missing",
      hermes: "missing",
    });
  });

  it("merges the intentional full-task inventories and exposes lazy fleet discovery", () => {
    const catalog = loadHostMcpCatalogs({
      home: "/does/not/exist",
      runCodexList: () => JSON.stringify([
        { name: "sentry", enabled: true, transport: { type: "stdio", command: "/bin/sentry", args: [] } },
      ]),
    }).fullTask;
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
    expect(catalog.servers["openmaus-host"]).toEqual({ type: "builtin" });
    expect(catalog.servers["openmaus-fleet"]).toEqual({ type: "builtin", family: "fleet" });
  });

  it("merges all four surface catalogs while retaining source-qualified conflicts", () => {
    const catalog = loadHostMcpCatalogs({
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
    }).fullTask;
    expect(Object.keys(catalog.servers)).toEqual(expect.arrayContaining([
      "shared",
      "shared-opencode",
      "shared-hermes",
    ]));
    expect(catalog.sources).toMatchObject({ codex: "loaded", opencode: "loaded", hermes: "loaded" });
  });

  it("keeps full-task tools separate from the external observer catalog", () => {
    const catalogs = loadHostMcpCatalogs({
      home: "/does/not/exist",
      runCodexList: () => JSON.stringify([
        { name: "sentry", enabled: true, transport: { type: "stdio", command: "/bin/sentry", args: [] } },
      ]),
    });

    expect(catalogs.observer).toMatchObject({
      servers: {},
      manifest: { profile: "observer-router", toolInventory: [] },
    });
    expect(catalogs.fullTask.manifest).toMatchObject({ profile: "full-task-scoped" });
    expect(catalogs.fullTask.manifest.toolInventory).toContain("sentry");
    expect(catalogs.fullTask.manifest.toolInventory).toContain("openmaus-host:filesystem_stat");
    expect(catalogs.fullTask.servers).toHaveProperty("sentry");
    expect(catalogs.fullTask.servers).toHaveProperty("openmaus-host", { type: "builtin" });
  });

  it("persists only the value-free manifest and source states", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "omb-profile-"));
    const catalog = loadHostMcpCatalog({
      home: "/does/not/exist",
      runCodexList: () =>
        JSON.stringify([
          { name: "sentry", enabled: true, transport: { type: "stdio", command: "/secret/path", args: [] } },
        ]),
    });
    const path = writeHostMcpManifest(dataDir, catalog);
    const saved = readFileSync(path, "utf8");
    expect(path).toMatch(/observer-router\.json$/);
    expect(saved).toContain('"profile": "observer-router"');
    expect(saved).not.toContain("/secret/path");
  });

  it("persists full-task and observer manifests to distinct paths", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "omb-profile-pair-"));
    const catalogs = loadHostMcpCatalogs({ home: "/does/not/exist", runCodexList: () => "[]" });
    const fullPath = writeHostMcpManifest(dataDir, catalogs.fullTask);
    const observerPath = writeHostMcpManifest(dataDir, catalogs.observer);

    expect(fullPath).toMatch(/full-task-scoped\.json$/);
    expect(observerPath).toMatch(/observer-router\.json$/);
    expect(readFileSync(fullPath, "utf8")).toContain('"profile": "full-task-scoped"');
    expect(readFileSync(observerPath, "utf8")).toContain('"profile": "observer-router"');
  });

  it("registers one identity-pinned fleet bridge for OpenMausBot", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-fleet-bridge-"));
    const bridgeScript = "/runtime/aos_fleet_bridge_mcp.py";
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          "aos-fleet-bridge": {
            command: "/usr/bin/python3",
            args: [bridgeScript, "--surface", "claude"],
          },
          "aos-fleet-bridge-codex": {
            command: "/usr/bin/python3",
            args: ["/runtime/reserved-name-collision.py"],
          },
        },
      }),
    );

    const catalog = loadHostMcpCatalog({
      home,
      runCodexList: () => JSON.stringify([
        {
          name: "aos-fleet-bridge",
          enabled: true,
          transport: {
            type: "stdio",
            command: "/usr/bin/python3",
            args: [bridgeScript, "--surface", "codex"],
          },
        },
      ]),
    });

    expect(catalog.servers["aos-fleet-bridge"]).toEqual({
      type: "stdio",
      command: "/usr/bin/python3",
      args: [bridgeScript, "--surface", "openmausbot"],
      env: {},
    });
    expect(catalog.servers["aos-fleet-bridge-codex"]).toBeUndefined();
    expect(catalog.servers["aos-fleet-bridge-codex-2"]).toBeUndefined();
    expect(Object.keys(catalog.servers)).toEqual(["aos-fleet-bridge"]);
    expect(catalog.manifest.toolInventory).toEqual(["aos-fleet-bridge"]);
    expect(catalog.manifest.profile).toBe("observer-router");
  });

  it("removes every source-qualified fleet bridge duplicate from the full-task catalog", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-fleet-bridge-sources-"));
    const bridgeScript = "/runtime/aos_fleet_bridge_mcp.py";
    writeFileSync(join(home, ".claude.json"), JSON.stringify({
      mcpServers: {
        "aos-fleet-bridge": {
          command: "/usr/bin/python3",
          args: [bridgeScript, "--surface", "claude"],
        },
        "aos-fleet-bridge-opencode": {
          command: "/usr/bin/python3",
          args: ["/runtime/reserved-opencode-collision.py"],
        },
        "aos-fleet-bridge-hermes": {
          command: "/usr/bin/python3",
          args: ["/runtime/reserved-hermes-collision.py"],
        },
      },
    }));
    const catalog = loadHostMcpCatalogs({
      home,
      runCodexList: () => JSON.stringify([{
        name: "aos-fleet-bridge",
        enabled: true,
        transport: {
          type: "stdio",
          command: "/usr/bin/python3",
          args: [bridgeScript, "--surface", "codex"],
        },
      }]),
      readOpenCodeConfig: () => JSON.stringify({
        mcp: {
          "aos-fleet-bridge": {
            type: "local",
            command: ["/usr/bin/python3", bridgeScript, "--surface", "opencode"],
            enabled: true,
          },
        },
      }),
      runHermesList: () => JSON.stringify({
        "aos-fleet-bridge": {
          command: "/usr/bin/python3",
          args: [bridgeScript, "--surface", "hermes"],
          enabled: true,
        },
      }),
    }).fullTask;

    expect(Object.keys(catalog.servers).filter((name) => name.startsWith("aos-fleet-bridge")))
      .toEqual(["aos-fleet-bridge"]);
    expect(catalog.servers["aos-fleet-bridge"]).toEqual({
      type: "stdio",
      command: "/usr/bin/python3",
      args: [bridgeScript, "--surface", "openmausbot"],
      env: {},
    });
  });

  it("drops a named fleet bridge that cannot be identity-pinned", () => {
    const catalog = loadHostMcpCatalog({
      home: "/does/not/exist",
      runCodexList: () => JSON.stringify([
        {
          name: "aos-fleet-bridge",
          enabled: true,
          transport: {
            type: "stdio",
            command: "/usr/bin/python3",
            args: ["/runtime/not-the-fleet-bridge.py"],
          },
        },
      ]),
    });

    expect(catalog.servers["aos-fleet-bridge"]).toBeUndefined();
    expect(catalog.manifest.toolInventory).not.toContain("aos-fleet-bridge");
  });

  it("rejects bridge commands with executable flags or ambiguous source scripts", () => {
    const dangerous = loadHostMcpCatalog({
      home: "/does/not/exist",
      runCodexList: () => JSON.stringify([{
        name: "aos-fleet-bridge",
        enabled: true,
        transport: {
          type: "stdio",
          command: "/usr/bin/python3",
          args: ["-c", "/runtime/aos_fleet_bridge_mcp.py", "--surface", "codex"],
        },
      }]),
    });
    expect(dangerous.servers).toEqual({});

    const home = mkdtempSync(join(tmpdir(), "omb-fleet-bridge-ambiguous-"));
    writeFileSync(join(home, ".claude.json"), JSON.stringify({
      mcpServers: {
        "aos-fleet-bridge": {
          command: "/opt/homebrew/bin/python3",
          args: ["/runtime/one/aos_fleet_bridge_mcp.py", "--surface", "claude"],
        },
      },
    }));
    const ambiguous = loadHostMcpCatalog({
      home,
      runCodexList: () => JSON.stringify([{
        name: "aos-fleet-bridge",
        enabled: true,
        transport: {
          type: "stdio",
          command: "/usr/bin/python3",
          args: ["/runtime/two/aos_fleet_bridge_mcp.py", "--surface", "codex"],
        },
      }]),
    });
    expect(ambiguous.servers).toEqual({});
  });

  it("strips bridge environment values and chooses the smallest equivalent registration", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-fleet-bridge-minimal-"));
    const bridgeScript = "/runtime/aos_fleet_bridge_mcp.py";
    writeFileSync(join(home, ".claude.json"), JSON.stringify({
      mcpServers: {
        "aos-fleet-bridge": {
          command: "/opt/homebrew/bin/python3",
          args: [bridgeScript, "--surface", "claude", "--state-dir", "/state"],
          env: { SECRET_TOKEN: "must-not-cross" },
        },
        sentry: { command: "/bin/sentry", args: [] },
      },
    }));
    const catalog = loadHostMcpCatalog({
      home,
      runCodexList: () => JSON.stringify([{
        name: "aos-fleet-bridge",
        enabled: true,
        transport: {
          type: "stdio",
          command: "/usr/bin/python3",
          args: [bridgeScript, "--surface", "codex"],
        },
      }]),
    });
    expect(catalog.servers).toEqual({
      "aos-fleet-bridge": {
        type: "stdio",
        command: "/usr/bin/python3",
        args: [bridgeScript, "--surface", "openmausbot"],
        env: {},
      },
    });
    expect(JSON.stringify(catalog)).not.toContain("must-not-cross");
    expect(JSON.stringify(catalog)).not.toContain("sentry");
  });
});
