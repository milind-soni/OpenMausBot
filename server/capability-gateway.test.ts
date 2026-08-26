import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { createCapabilityProfileManifest } from "./access-profile.ts";
import { CapabilityGateway, credentialBackendSpawnSpec } from "./capability-gateway.ts";
import { FleetCapabilityIndex } from "./fleet-capabilities.ts";
import { loadHostMcpCatalog, type HostMcpCatalog } from "./host-mcp.ts";
import { invalidateProtectedEnvironmentRedactor } from "./redact.ts";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-capability-mcp.ts");
const FAKE_CREDENTIAL_BROKER = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-credential-broker.ts");
const CREDENTIAL_REDACTOR = join(dirname(fileURLToPath(import.meta.url)), "credential-redacting-proxy.ts");
const TOKEN = "turn-token-123456789012345678901234";
const TOKEN_TWO = "turn-token-abcdefghijklmnopqrstuvwxyz12";

function catalog(): HostMcpCatalog {
  return {
    servers: {
      test: {
        type: "stdio",
        command: process.execPath,
        args: [FAKE],
        env: { TEST_GATEWAY_SECRET: "arbitrary-canary-value-987654" },
      },
    },
    manifest: createCapabilityProfileManifest({ toolInventory: ["test"], telemetryMode: "sanitized-content" }),
    sources: { claude: "loaded", codex: "loaded" },
  };
}

describe("CapabilityGateway", () => {
  const open: CapabilityGateway[] = [];
  const temporary: string[] = [];

  afterEach(() => {
    for (const gateway of open.splice(0)) gateway.shutdown();
    for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  it("requires a live turn token and rejects it immediately after settlement", () => {
    const gateway = new CapabilityGateway(catalog());
    open.push(gateway);
    gateway.beginTurn(TOKEN, { botId: "bot", threadId: "thread" });
    expect(gateway.inventory(TOKEN).manifest.profile).toBe("full-task-scoped");
    gateway.endTurn(TOKEN);
    expect(() => gateway.inventory(TOKEN)).toThrow(/no longer active/);
  });

  it("rejects malformed or conflicting turn servers before replacing stored state", () => {
    const gateway = new CapabilityGateway(catalog());
    open.push(gateway);
    gateway.beginTurn(TOKEN, { botId: "original", threadId: "original-thread" });

    expect(() => gateway.beginTurn(TOKEN, {
      botId: "replacement",
      threadId: "replacement-thread",
      servers: { broken: { type: "stdio", command: "", args: [], env: {} } },
    })).toThrow(/invalid capability server definition/);
    expect(gateway.ownsTurn(TOKEN)).toBe(true);

    expect(() => gateway.extendTurn(TOKEN, {
      valid: { type: "stdio", command: process.execPath, args: [FAKE], env: {} },
      test: { type: "stdio", command: process.execPath, args: [FAKE], env: {} },
    })).toThrow(/cannot replace a host capability/);
    expect(gateway.inventory(TOKEN).servers.map((server) => server.name)).not.toContain("valid");
  });

  it("starts a backend lazily, reuses it, and redacts arbitrary protected values", async () => {
    const gateway = new CapabilityGateway(catalog(), { idleTimeoutMs: 2_000 });
    open.push(gateway);
    gateway.beginTurn(TOKEN, { botId: "bot", threadId: "thread" });
    expect(gateway.stats().activeBackends).toEqual([]);

    const first = await gateway.callTool(TOKEN, "test", "echo", { value: "first" });
    const second = await gateway.callTool(TOKEN, "test", "echo", { value: "second" });
    const rendered = JSON.stringify([first, second]);
    expect(rendered).not.toContain("arbitrary-canary-value-987654");
    expect(rendered).toContain("redacted");
    const marker = (value: any) => JSON.parse(value.content[0].text).marker;
    expect(marker(first)).toBe(marker(second));
    expect(gateway.stats().activeBackends).toEqual(["test"]);
  });

  it("turns an early backend exit into a rejected request instead of an unhandled stdin error", async () => {
    const gateway = new CapabilityGateway({
      servers: {
        exiting: {
          type: "stdio",
          command: process.execPath,
          args: ["-e", "process.exit(0)"],
          env: {},
        },
      },
      manifest: createCapabilityProfileManifest({ toolInventory: ["exiting"], telemetryMode: "sanitized-content" }),
      sources: { claude: "missing", codex: "missing" },
    });
    open.push(gateway);
    gateway.beginTurn(TOKEN, { botId: "bot", threadId: "thread" });

    await expect(gateway.callTool(TOKEN, "exiting", "echo", {})).rejects.toThrow(
      /capability backend/,
    );
  });

  it("adds task-owned integrations to the effective manifest and closes them at turn end", async () => {
    const gateway = new CapabilityGateway({
      servers: { "openmaus-host": { type: "builtin" } },
      manifest: createCapabilityProfileManifest({ toolInventory: ["openmaus-host:shell_execute"], telemetryMode: "sanitized-content" }),
      sources: { claude: "missing", codex: "missing" },
    }, { idleTimeoutMs: 60_000 });
    open.push(gateway);
    gateway.beginTurn(TOKEN, { botId: "bot", threadId: "thread" });
    gateway.extendTurn(TOKEN, {
      "openmaus-computer": { type: "stdio", command: process.execPath, args: [FAKE], env: {} },
    });

    const inventory = gateway.inventory(TOKEN);
    expect(inventory.manifest.toolInventory).toContain("openmaus-computer");
    expect(inventory.manifest.sha256).not.toBe(gateway.catalog.manifest.sha256);
    await gateway.callTool(TOKEN, "openmaus-computer", "echo", { value: "screen" });
    expect(gateway.stats().activeBackends).toEqual(["openmaus-computer"]);

    gateway.endTurn(TOKEN);
    expect(gateway.stats()).toEqual({ activeTurns: 0, activeBackends: [] });
  });

  it("enforces denials across split computer input and withholds credential-store screens", async () => {
    const gateway = new CapabilityGateway({
      servers: {},
      manifest: createCapabilityProfileManifest({ telemetryMode: "sanitized-content" }),
      sources: { claude: "missing", codex: "missing" },
    });
    open.push(gateway);
    gateway.beginTurn(TOKEN, {
      botId: "bot",
      threadId: "thread",
      servers: {
        "openmaus-computer": { type: "stdio", command: process.execPath, args: [FAKE], env: {} },
      },
    });

    const prefix = await gateway.callTool(TOKEN, "openmaus-computer", "type_text", { text: "rm -" });
    expect(prefix?.isError).not.toBe(true);
    const splitDenied = await gateway.callTool(TOKEN, "openmaus-computer", "type_text", { text: "rf /" });
    expect(splitDenied).toMatchObject({ isError: true });
    expect(JSON.stringify(splitDenied)).toContain("catastrophic-destruction");

    const credentialDenied = await gateway.callTool(TOKEN, "openmaus-computer", "credential-screen", {});
    expect(credentialDenied).toMatchObject({ isError: true });
    expect(JSON.stringify(credentialDenied)).toContain("credential-value-disclosure");
    expect(JSON.stringify(credentialDenied)).not.toContain("arbitrary-unclassified-secret");
  });

  it("blocks catastrophic MCP calls before a backend starts", async () => {
    const gateway = new CapabilityGateway(catalog());
    open.push(gateway);
    gateway.beginTurn(TOKEN, { botId: "bot", threadId: "thread" });
    const result = await gateway.callTool(TOKEN, "test", "delete_project", { project: "production" });
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain("catastrophic-destruction");
    expect(gateway.stats().activeBackends).toEqual([]);
  });

  it("blocks a structured Pi credential-store read before touching the host file", async () => {
    const gateway = new CapabilityGateway({
      servers: { "openmaus-host": { type: "builtin" } },
      manifest: createCapabilityProfileManifest({ toolInventory: ["openmaus-host:filesystem_read"], telemetryMode: "sanitized-content" }),
      sources: { claude: "missing", codex: "missing" },
    });
    open.push(gateway);
    gateway.beginTurn(TOKEN, { botId: "bot", threadId: "thread" });
    const result = await gateway.callTool(TOKEN, "openmaus-host", "filesystem_read", {
      path: join(homedir(), ".pi", "agent", "auth.json"),
    });
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain("credential-value-disclosure");
  });

  it("removes binary payloads and closes idle backends", async () => {
    const gateway = new CapabilityGateway(catalog(), { idleTimeoutMs: 25 });
    open.push(gateway);
    gateway.beginTurn(TOKEN, { botId: "bot", threadId: "thread" });
    const result = await gateway.callTool(TOKEN, "test", "binary", {});
    expect(JSON.stringify(result)).not.toContain("A".repeat(100));
    expect(JSON.stringify(result)).toContain("binary capability output omitted");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(gateway.stats().activeBackends).toEqual([]);
  });

  it("preserves bounded computer screenshots while still blocking credential screens", async () => {
    const gateway = new CapabilityGateway({
      servers: {
        "openmaus-computer": { type: "stdio", command: process.execPath, args: [FAKE], env: {} },
      },
      manifest: createCapabilityProfileManifest({ toolInventory: ["openmaus-computer"], telemetryMode: "sanitized-content" }),
      sources: { claude: "missing", codex: "missing" },
    });
    open.push(gateway);
    gateway.beginTurn(TOKEN, { botId: "bot", threadId: "thread" });

    const screenshot = await gateway.callTool(TOKEN, "openmaus-computer", "binary", {});
    expect(JSON.stringify(screenshot)).toContain("A".repeat(100));
    expect(JSON.stringify(screenshot)).not.toContain("binary capability output omitted");
  });

  it("lists and selects logical aliases without resolving values", async () => {
    const gateway = new CapabilityGateway(catalog(), {
      listAliases: async () => ["sentry-readonly", "langfuse_secret", "bad alias"],
    });
    open.push(gateway);
    gateway.beginTurn(TOKEN, { botId: "bot", threadId: "thread" });
    expect(await gateway.aliases(TOKEN)).toEqual(["langfuse_secret", "sentry-readonly"]);
    await expect(
      gateway.selectCredentialAlias(TOKEN, "test", "sentry-readonly", "SENTRY_ACCESS_TOKEN"),
    ).resolves.toBeUndefined();
    await expect(
      gateway.selectCredentialAlias(TOKEN, "test", "not-present", "TOKEN"),
    ).rejects.toThrow(/unknown credential alias/);
  });

  it("uses cv stdio-exec without putting values in argv", () => {
    const spec = credentialBackendSpawnSpec(
      { alias: "logical-alias", envVar: "PROVIDER_ACCESS_TOKEN" },
      {
        command: "/safe/cv",
        platform: "darwin",
        executable: "/app/OpenMausBot Helper",
        proxyPath: "/app/server/credential-redacting-proxy.js",
      },
    );
    expect(spec.command).toBe("/safe/cv");
    expect(spec.args.slice(0, 6)).toEqual([
      "--source",
      "main",
      "stdio-exec",
      "--env",
      "PROVIDER_ACCESS_TOKEN=logical-alias",
      "--",
    ]);
    expect(spec.args).toContain("ELECTRON_RUN_AS_NODE=1");
    expect(spec.args.slice(-2)).toEqual([
      "/app/OpenMausBot Helper",
      "/app/server/credential-redacting-proxy.js",
    ]);
    expect(spec.args).not.toContain("exec");
  });

  it("passes one layered cmd command string for spaced Windows paths", () => {
    const spec = credentialBackendSpawnSpec(
      { alias: "logical-alias", envVar: "PROVIDER_ACCESS_TOKEN" },
      {
        command: "C:\\Safe Tools\\cv.exe",
        platform: "win32",
        executable: "C:\\Program Files\\OpenMausBot\\OpenMausBot Helper.exe",
        proxyPath: "C:\\Program Files\\OpenMausBot\\server\\credential-redacting-proxy.js",
      },
    );
    const commandIndex = spec.args.lastIndexOf("/c");
    expect(commandIndex).toBeGreaterThan(0);
    expect(spec.args.slice(commandIndex + 1)).toEqual([
      '""C:\\Program Files\\OpenMausBot\\server\\credential-redacting-node-launcher.cmd" "C:\\Program Files\\OpenMausBot\\OpenMausBot Helper.exe" "C:\\Program Files\\OpenMausBot\\server\\credential-redacting-proxy.js""',
    ]);
  });

  it("launches the Windows Node runtime directly without the Electron cmd wrapper", () => {
    const spec = credentialBackendSpawnSpec(
      { alias: "logical-alias", envVar: "PROVIDER_ACCESS_TOKEN" },
      {
        command: "C:\\Safe Tools\\cv.exe",
        platform: "win32",
        executable: "C:\\hostedtoolcache\\windows\\node\\24\\node.exe",
        proxyPath: "C:\\workspace\\server\\credential-redacting-proxy.ts",
      },
    );
    const separatorIndex = spec.args.indexOf("--");
    expect(spec.args.slice(separatorIndex + 1)).toEqual([
      "C:\\hostedtoolcache\\windows\\node\\24\\node.exe",
      "C:\\workspace\\server\\credential-redacting-proxy.ts",
    ]);
  });

  it("scopes selections to a turn, isolates concurrent aliases, and redacts split credential output", async () => {
    const directory = mkdtempSync(join(tmpdir(), "omb-credential-gateway-"));
    temporary.push(directory);
    const argvReceipt = join(directory, "broker-argv.ndjson");
    const gateway = new CapabilityGateway(catalog(), {
      idleTimeoutMs: 60_000,
      listAliases: async () => ["alias-one", "alias-two", "alias-three"],
      credentialBroker: {
        command: process.execPath,
        prefixArgs: [FAKE_CREDENTIAL_BROKER, argvReceipt],
        executable: process.execPath,
        proxyPath: CREDENTIAL_REDACTOR,
      },
    });
    open.push(gateway);
    gateway.beginTurn(TOKEN, { botId: "one", threadId: "thread-one" });
    gateway.beginTurn(TOKEN_TWO, { botId: "two", threadId: "thread-two" });
    await gateway.selectCredentialAlias(TOKEN, "test", "alias-one", "TEST_SELECTED_SECRET");
    await gateway.selectCredentialAlias(TOKEN_TWO, "test", "alias-two", "TEST_SELECTED_SECRET");

    const [one, two] = await Promise.all([
      gateway.callTool(TOKEN, "test", "credential-split", {}),
      gateway.callTool(TOKEN_TWO, "test", "credential-echo", {}),
    ]);
    expect(one.structuredContent).toMatchObject({ tag: "alias-one" });
    expect(two.structuredContent).toMatchObject({ tag: "alias-two" });
    expect(JSON.stringify([one, two])).not.toMatch(/credential-(?:one|two)-canary/);
    expect(JSON.stringify([one, two])).toContain("[REDACTED]");
    expect(gateway.stats().activeBackends).toEqual(["test", "test"]);

    const markerOne = one.structuredContent.marker;
    await gateway.selectCredentialAlias(TOKEN_TWO, "test", "alias-three", "TEST_SELECTED_SECRET");
    const [oneAgain, three] = await Promise.all([
      gateway.callTool(TOKEN, "test", "credential-echo", {}),
      gateway.callTool(TOKEN_TWO, "test", "credential-echo", {}),
    ]);
    expect(oneAgain.structuredContent).toMatchObject({ tag: "alias-one", marker: markerOne });
    expect(three.structuredContent.tag).toBe("alias-three");

    gateway.endTurn(TOKEN);
    gateway.beginTurn(TOKEN, { botId: "one", threadId: "thread-one-next" });
    const cleared = await gateway.callTool(TOKEN, "test", "credential-echo", {});
    expect(cleared.structuredContent.tag).toBe("none");

    const brokerArgv = readFileSync(argvReceipt, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(brokerArgv).toHaveLength(3);
    for (const argv of brokerArgv) {
      expect(argv.slice(0, 3)).toEqual(["--source", "main", "stdio-exec"]);
      expect(argv).not.toContain("exec");
      expect(argv.join(" ")).not.toMatch(/credential-(?:one|two|three)-canary/);
    }
    expect(brokerArgv.map((argv) => argv[4]).sort()).toEqual([
      "TEST_SELECTED_SECRET=alias-one",
      "TEST_SELECTED_SECRET=alias-three",
      "TEST_SELECTED_SECRET=alias-two",
    ]);
  });

  it("rejects credential selection for HTTP capabilities before alias lookup", async () => {
    let listed = false;
    const gateway = new CapabilityGateway({
      servers: { remote: { type: "http", url: "https://example.invalid/mcp", headers: {} } },
      manifest: createCapabilityProfileManifest({ toolInventory: ["remote"], telemetryMode: "sanitized-content" }),
      sources: { claude: "missing", codex: "missing" },
    }, {
      listAliases: async () => {
        listed = true;
        return ["alias-one"];
      },
    });
    open.push(gateway);
    gateway.beginTurn(TOKEN, { botId: "bot", threadId: "thread" });
    await expect(
      gateway.selectCredentialAlias(TOKEN, "remote", "alias-one", "REMOTE_ACCESS_TOKEN"),
    ).rejects.toThrow(/requires a stdio capability server/);
    expect(listed).toBe(false);
  });

  it("protects only secret-shaped HTTP header values", () => {
    const gateway = new CapabilityGateway({
      servers: {
        remote: {
          type: "http",
          url: "https://example.invalid/mcp",
          headers: {
            "content-type": "application/json",
            accept: "*/*",
            Authorization: "Bearer header-token-canary",
            "x-api-key": "header-key-canary",
            "x-empty-token": "  ",
          },
        },
      },
      manifest: createCapabilityProfileManifest({ toolInventory: ["remote"], telemetryMode: "sanitized-content" }),
      sources: { claude: "missing", codex: "missing" },
    });
    open.push(gateway);

    const values = (gateway as any).protectedValues as Set<string>;
    expect(values.has("header-token-canary")).toBe(true);
    expect(values.has("header-key-canary")).toBe(true);
    expect(values.has("application/json")).toBe(false);
    expect(values.has("*/*")).toBe(false);
    expect(values.has("")).toBe(false);
  });

  it("provides the same task-scoped host baseline to non-provider clients", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omb-host-core-"));
    temporary.push(cwd);
    const hostCatalog: HostMcpCatalog = {
      servers: { "openmaus-host": { type: "builtin" } },
      manifest: createCapabilityProfileManifest({ toolInventory: ["openmaus-host:shell_execute"], telemetryMode: "sanitized-content" }),
      sources: { claude: "missing", codex: "missing" },
    };
    const gateway = new CapabilityGateway(hostCatalog);
    open.push(gateway);
    gateway.beginTurn(TOKEN, { botId: "manus", threadId: "task", cwd });

    const tools = await gateway.listTools(TOKEN, "openmaus-host");
    expect(tools.tools.map((tool: { name: string }) => tool.name)).toContain("shell_execute");
    await gateway.callTool(TOKEN, "openmaus-host", "filesystem_write", { path: "fixture.txt", content: "hello" });
    const read = await gateway.callTool(TOKEN, "openmaus-host", "filesystem_read", { path: "fixture.txt" });
    expect(read).toMatchObject({ content: "hello" });
    const shell = await gateway.callTool(TOKEN, "openmaus-host", "shell_execute", { command: "pwd" });
    expect(shell).toMatchObject({ exitCode: 0 });
    await gateway.callTool(TOKEN, "openmaus-host", "filesystem_delete", { path: "fixture.txt" });
    expect(() => readFileSync(join(cwd, "fixture.txt"))).toThrow();
  });

  it("discovers fleet metadata and selects one route without eager backend startup", async () => {
    const root = mkdtempSync(join(tmpdir(), "omb-fleet-gateway-"));
    temporary.push(root);
    const indexPath = join(root, "capabilities.v1.json");
    writeFileSync(indexPath, JSON.stringify({
      schema: "capabilities.v1",
      records: [
        { id: "mcp:test", kind: "mcp", configured: true, compatible_surfaces: ["codex"] },
        { id: "skill:shared:ios-ui-debug", kind: "skill", configured: true, compatible_surfaces: ["codex"] },
      ],
    }));
    const gateway = new CapabilityGateway({
      servers: {
        test: { type: "stdio", command: process.execPath, args: [FAKE], env: {} },
        "openmaus-fleet": { type: "builtin", family: "fleet" },
      },
      manifest: createCapabilityProfileManifest({
        toolInventory: ["test", "openmaus-fleet:search_capabilities"],
        telemetryMode: "sanitized-content",
      }),
      sources: { claude: "loaded", codex: "loaded" },
    }, { fleetIndex: new FleetCapabilityIndex(indexPath) });
    open.push(gateway);
    gateway.beginTurn(TOKEN, { botId: "bot", threadId: "thread" });

    const tools = await gateway.listTools(TOKEN, "openmaus-fleet");
    expect(tools.tools.map((tool: { name: string }) => tool.name)).toContain("select_capability");
    const search = await gateway.callTool(TOKEN, "openmaus-fleet", "search_capabilities", { query: "test" });
    expect(search).toMatchObject([{ id: "mcp:test", kind: "mcp" }]);
    const selected = await gateway.callTool(TOKEN, "openmaus-fleet", "select_capability", { id: "mcp:test" });
    expect(selected).toMatchObject({ status: "ready", route: { serverNames: ["test"] } });
    expect(gateway.stats().activeBackends).toEqual([]);
  });

  it("keeps host catalog and gateway built-in inventories identical and defined", async () => {
    const hostCatalog = loadHostMcpCatalog({
      telemetryMode: "sanitized-content",
      home: "/does/not/exist",
      runCodexList: () => "[]",
      readOpenCodeConfig: () => '{"mcp":{}}',
      runHermesList: () => "{}",
    });
    const gateway = new CapabilityGateway(hostCatalog);
    open.push(gateway);
    gateway.beginTurn(TOKEN, { botId: "bot", threadId: "thread" });

    const manifest = gateway.inventory(TOKEN).manifest;
    const fleetTools = await gateway.listTools(TOKEN, "openmaus-fleet");
    const listedInventory = fleetTools.tools.map((tool: { name: string }) => `openmaus-fleet:${tool.name}`).sort();

    expect(manifest).toEqual(hostCatalog.manifest);
    expect(manifest.toolInventory.filter((entry) => entry.startsWith("openmaus-fleet:"))).toEqual(listedInventory);
    expect(manifest.toolInventory.some((entry) => entry.includes("undefined"))).toBe(false);
    expect(fleetTools.tools.every((tool: { name?: unknown }) => typeof tool.name === "string" && tool.name.length > 0)).toBe(true);
  });

  it("rejects whole-repository deletion and scrubs exact canaries before host execution", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omb-host-core-"));
    temporary.push(cwd);
    mkdirSync(join(cwd, ".git"));
    const canary = "gateway-canary-exact-927364";
    process.env.GATEWAY_TEST_SECRET = canary;
    invalidateProtectedEnvironmentRedactor();
    try {
      const hostCatalog: HostMcpCatalog = {
        servers: { "openmaus-host": { type: "builtin" } },
        manifest: createCapabilityProfileManifest({ toolInventory: ["openmaus-host:shell_execute"], telemetryMode: "sanitized-content" }),
        sources: { claude: "missing", codex: "missing" },
      };
      const gateway = new CapabilityGateway(hostCatalog);
      open.push(gateway);
      gateway.beginTurn(TOKEN, { botId: "hermes", threadId: "task", cwd });
      const denied = await gateway.callTool(TOKEN, "openmaus-host", "filesystem_delete", { path: cwd, recursive: true });
      expect(denied).toMatchObject({ isError: true });
      const echoed = await gateway.callTool(TOKEN, "openmaus-host", "shell_execute", { command: `printf '%s' '${canary}'` });
      expect(JSON.stringify(echoed)).not.toContain(canary);
      expect(JSON.stringify(echoed)).toContain("redacted");
    } finally {
      delete process.env.GATEWAY_TEST_SECRET;
      invalidateProtectedEnvironmentRedactor();
    }
  });
});
