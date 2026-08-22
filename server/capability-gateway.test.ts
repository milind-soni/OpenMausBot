import { createHash } from "node:crypto";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { createCapabilityProfileManifest, createObserverRouterProfileManifest } from "./access-profile.ts";
import { CapabilityGateway, credentialBackendSpawnSpec } from "./capability-gateway.ts";
import { FleetCapabilityIndex } from "./fleet-capabilities.ts";
import type { HostMcpCatalog } from "./host-mcp.ts";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-capability-mcp.ts");
const FAKE_OBSERVER = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-observer-bridge-mcp.ts");
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
    manifest: createCapabilityProfileManifest({ toolInventory: ["test"] }),
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

  it("starts a backend lazily, reuses it, and redacts arbitrary protected values", async () => {
    chmodSync(FAKE, 0o755);
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
      manifest: createCapabilityProfileManifest({ toolInventory: ["exiting"] }),
      sources: { claude: "missing", codex: "missing" },
    });
    open.push(gateway);
    gateway.beginTurn(TOKEN, { botId: "bot", threadId: "thread" });

    await expect(gateway.callTool(TOKEN, "exiting", "echo", {})).rejects.toThrow(
      /capability backend/,
    );
  });

  it("adds task-owned integrations to the effective manifest and closes them at turn end", async () => {
    chmodSync(FAKE, 0o755);
    const gateway = new CapabilityGateway({
      servers: { "openmaus-host": { type: "builtin" } },
      manifest: createCapabilityProfileManifest({ toolInventory: ["openmaus-host:shell_execute"] }),
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
    chmodSync(FAKE, 0o755);
    const gateway = new CapabilityGateway({
      servers: {},
      manifest: createCapabilityProfileManifest(),
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
      manifest: createCapabilityProfileManifest({ toolInventory: ["openmaus-host:filesystem_read"] }),
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
    chmodSync(FAKE, 0o755);
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
    chmodSync(FAKE, 0o755);
    const gateway = new CapabilityGateway({
      servers: {
        "openmaus-computer": { type: "stdio", command: process.execPath, args: [FAKE], env: {} },
      },
      manifest: createCapabilityProfileManifest({ toolInventory: ["openmaus-computer"] }),
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
    chmodSync(FAKE, 0o755);
    chmodSync(FAKE_CREDENTIAL_BROKER, 0o755);
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
      manifest: createCapabilityProfileManifest({ toolInventory: ["remote"] }),
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
      manifest: createCapabilityProfileManifest({ toolInventory: ["remote"] }),
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
      manifest: createCapabilityProfileManifest({ toolInventory: ["openmaus-host:shell_execute"] }),
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

  it("hard-enforces an agent graph permission class and symlink-safe workspace boundary", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "omb-graph-gateway-")));
    temporary.push(root);
    const cwd = join(root, "workspace");
    const outside = join(root, "outside");
    mkdirSync(cwd);
    mkdirSync(outside);
    writeFileSync(join(cwd, "inside.txt"), "inside");
    mkdirSync(join(cwd, ".git"));
    writeFileSync(join(cwd, ".git", "config"), "[core]\n");
    writeFileSync(join(outside, "outside.txt"), "outside");
    symlinkSync(outside, join(cwd, "escape"));
    symlinkSync(join(outside, "missing"), join(cwd, "dangling"));
    const hostCatalog: HostMcpCatalog = {
      servers: { "openmaus-host": { type: "builtin" } },
      manifest: createCapabilityProfileManifest({ toolInventory: ["openmaus-host:shell_execute"] }),
      sources: { claude: "missing", codex: "missing" },
    };
    const gateway = new CapabilityGateway(hostCatalog);
    open.push(gateway);
    gateway.beginTurn(TOKEN, { botId: "graph", threadId: "read", cwd, graphPermissionClass: "read" });

    const graphTools = await gateway.listTools(TOKEN, "openmaus-host");
    expect(graphTools.tools.map((tool: { name: string }) => tool.name)).toEqual(["filesystem_read", "filesystem_stat"]);
    await expect(gateway.callTool(TOKEN, "openmaus-host", "filesystem_read", { path: "inside.txt" }))
      .resolves.toMatchObject({ content: "inside" });
    await expect(gateway.callTool(TOKEN, "openmaus-host", "shell_execute", { command: "pwd" }))
      .rejects.toThrow(/separate OS sandbox/);
    await expect(gateway.callTool(TOKEN, "openmaus-host", "filesystem_read", { path: "escape/outside.txt" }))
      .rejects.toThrow(/outside the approved workspace/);
    await expect(gateway.callTool(TOKEN, "openmaus-host", "filesystem_write", { path: "dangling/new.txt", content: "no" }))
      .rejects.toThrow(/outside the approved workspace/);
    await expect(gateway.callTool(TOKEN, "openmaus-host", "filesystem_write", { path: "new.txt", content: "no" }))
      .rejects.toThrow(/outside the approved permission class/);
    await expect(gateway.callTool(TOKEN, "openmaus-host", "filesystem_delete", { path: "inside.txt" }))
      .rejects.toThrow(/cannot delete/);
    await expect(gateway.callTool(TOKEN, "openmaus-host", "shell_execute", { command: "cat ../outside/outside.txt" }))
      .rejects.toThrow(/separate OS sandbox/);

    gateway.beginTurn(TOKEN_TWO, { botId: "graph", threadId: "write", cwd, graphPermissionClass: "workspace-write" });
    await expect(gateway.callTool(TOKEN_TWO, "openmaus-host", "filesystem_write", { path: "new.txt", content: "yes" }))
      .rejects.toThrow(/exact preimage/);
    const preimage = await gateway.callTool(TOKEN_TWO, "openmaus-host", "filesystem_read", { path: "inside.txt" });
    writeFileSync(join(cwd, "inside.txt"), "owner changed");
    await expect(gateway.callTool(TOKEN_TWO, "openmaus-host", "filesystem_write", {
      path: "inside.txt", content: "graph", expectedSha256: preimage.sha256,
    })).rejects.toThrow(/owner drift/);
    const refreshed = await gateway.callTool(TOKEN_TWO, "openmaus-host", "filesystem_read", { path: "inside.txt" });
    await expect(gateway.callTool(TOKEN_TWO, "openmaus-host", "filesystem_write", {
      path: "inside.txt", content: "graph", expectedSha256: refreshed.sha256,
    })).resolves.toMatchObject({ bytes: 5 });
    const missing = await gateway.callTool(TOKEN_TWO, "openmaus-host", "filesystem_stat", { path: "new.txt" });
    expect(missing).toMatchObject({ exists: false, sha256: "absent" });
    await expect(gateway.callTool(TOKEN_TWO, "openmaus-host", "filesystem_write", {
      path: "new.txt", content: "yes", expectedSha256: missing.sha256,
    }))
      .resolves.toMatchObject({ bytes: 3 });
    expect(readFileSync(join(cwd, "new.txt"), "utf8")).toBe("yes");
    await expect(gateway.callTool(TOKEN_TWO, "openmaus-host", "filesystem_write", {
      path: ".git/config", content: "[core]\nhooksPath=/tmp/hooks\n", expectedSha256: `sha256:${"a".repeat(64)}`,
    })).rejects.toThrow(/repository control metadata/);

    const worktree = join(root, "linked-worktree");
    mkdirSync(worktree);
    writeFileSync(join(worktree, ".git"), "gitdir: ../admin\n");
    gateway.beginTurn(TOKEN, { botId: "graph", threadId: "worktree", cwd: worktree, graphPermissionClass: "workspace-write" });
    await expect(gateway.callTool(TOKEN, "openmaus-host", "filesystem_write", {
      path: ".git", content: "gitdir: /tmp/outside\n", expectedSha256: `sha256:${"a".repeat(64)}`,
    })).rejects.toThrow(/repository control metadata/);
  });

  it("binds graph writes to single-link preimages and rejects link or parent replacement", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "omb-graph-identity-")));
    temporary.push(root);
    const cwd = join(root, "workspace");
    const outside = join(root, "outside");
    mkdirSync(cwd);
    mkdirSync(outside);
    const hostCatalog: HostMcpCatalog = {
      servers: { "openmaus-host": { type: "builtin" } },
      manifest: createCapabilityProfileManifest(),
      sources: { claude: "missing", codex: "missing" },
    };
    const gateway = new CapabilityGateway(hostCatalog);
    open.push(gateway);
    gateway.beginTurn(TOKEN, {
      botId: "graph",
      threadId: "identity",
      cwd,
      graphPermissionClass: "workspace-write",
    });

    writeFileSync(join(cwd, "single.txt"), "before");
    const single = await gateway.callTool(TOKEN, "openmaus-host", "filesystem_read", { path: "single.txt" });
    await expect(gateway.callTool(TOKEN, "openmaus-host", "filesystem_write", {
      path: "single.txt",
      content: "after",
      expectedSha256: single.sha256,
    })).resolves.toMatchObject({ bytes: 5 });
    expect(readFileSync(join(cwd, "single.txt"), "utf8")).toBe("after");
    expect(statSync(join(cwd, "single.txt")).nlink).toBe(1);

    const outsideHardLink = join(outside, "hard-link-source.txt");
    writeFileSync(outsideHardLink, "outside-hard-link");
    linkSync(outsideHardLink, join(cwd, "hard-link.txt"));
    await expect(gateway.callTool(TOKEN, "openmaus-host", "filesystem_read", { path: "hard-link.txt" }))
      .rejects.toThrow(/outside the approved workspace|single-link/);
    expect(readFileSync(outsideHardLink, "utf8")).toBe("outside-hard-link");

    const outsideSwap = join(outside, "swap-target.txt");
    writeFileSync(outsideSwap, "outside-swap");
    writeFileSync(join(cwd, "swap.txt"), "inside-swap");
    const swap = await gateway.callTool(TOKEN, "openmaus-host", "filesystem_read", { path: "swap.txt" });
    rmSync(join(cwd, "swap.txt"));
    symlinkSync(outsideSwap, join(cwd, "swap.txt"));
    await expect(gateway.callTool(TOKEN, "openmaus-host", "filesystem_write", {
      path: "swap.txt",
      content: "must-not-land",
      expectedSha256: swap.sha256,
    })).rejects.toThrow(/outside the approved workspace|unsafe path|final-path|ELOOP/);
    expect(readFileSync(outsideSwap, "utf8")).toBe("outside-swap");

    const parent = join(cwd, "parent");
    const displacedParent = join(cwd, "parent-before-swap");
    mkdirSync(parent);
    const absent = await gateway.callTool(TOKEN, "openmaus-host", "filesystem_stat", { path: "parent/new.txt" });
    expect(absent).toMatchObject({ exists: false, sha256: "absent" });
    renameSync(parent, displacedParent);
    mkdirSync(parent);
    await expect(gateway.callTool(TOKEN, "openmaus-host", "filesystem_write", {
      path: "parent/new.txt",
      content: "must-not-land",
      expectedSha256: absent.sha256,
    })).rejects.toThrow(/parent drift/);
    expect(() => statSync(join(parent, "new.txt"))).toThrow();
    expect(() => statSync(join(displacedParent, "new.txt"))).toThrow();
  });

  it("revokes every graph capability when the approved workspace root identity changes", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "omb-graph-root-identity-")));
    temporary.push(root);
    const outside = join(root, "outside");
    const symlinkWorkspace = join(root, "symlink-workspace");
    const displacedSymlinkWorkspace = join(root, "symlink-workspace-before-swap");
    mkdirSync(outside);
    mkdirSync(symlinkWorkspace);
    writeFileSync(join(symlinkWorkspace, "sentinel.txt"), "inside-original");
    writeFileSync(join(outside, "sentinel.txt"), "outside-untouched");
    const hostCatalog: HostMcpCatalog = {
      servers: { "openmaus-host": { type: "builtin" } },
      manifest: createCapabilityProfileManifest(),
      sources: { claude: "missing", codex: "missing" },
    };
    const gateway = new CapabilityGateway(hostCatalog, { listAliases: async () => ["graph-must-not-see"] });
    open.push(gateway);
    gateway.beginTurn(TOKEN, {
      botId: "graph",
      threadId: "root-symlink-swap",
      cwd: symlinkWorkspace,
      graphPermissionClass: "workspace-write",
    });

    await expect(gateway.aliases(TOKEN)).rejects.toThrow(/graph profile does not expose credential aliases/);
    await expect(
      gateway.selectCredentialAlias(TOKEN, "openmaus-host", "graph-must-not-see", "GRAPH_SECRET"),
    ).rejects.toThrow(/graph profile does not allow credential selection/);

    renameSync(symlinkWorkspace, displacedSymlinkWorkspace);
    symlinkSync(outside, symlinkWorkspace);
    expect(() => gateway.inventory(TOKEN)).toThrow(/workspace root identity changed/);
    await expect(gateway.listTools(TOKEN, "openmaus-host")).rejects.toThrow(/workspace root identity changed/);
    await expect(gateway.callTool(TOKEN, "openmaus-host", "filesystem_read", { path: "sentinel.txt" }))
      .rejects.toThrow(/workspace root identity changed/);
    await expect(gateway.callTool(TOKEN, "openmaus-host", "filesystem_write", {
      path: "sentinel.txt",
      content: "must-not-land",
      expectedSha256: `sha256:${"a".repeat(64)}`,
    })).rejects.toThrow(/workspace root identity changed/);
    expect(readFileSync(join(outside, "sentinel.txt"), "utf8")).toBe("outside-untouched");
    expect(readFileSync(join(displacedSymlinkWorkspace, "sentinel.txt"), "utf8")).toBe("inside-original");

    const inodeWorkspace = join(root, "inode-workspace");
    const displacedInodeWorkspace = join(root, "inode-workspace-before-swap");
    mkdirSync(inodeWorkspace);
    writeFileSync(join(inodeWorkspace, "sentinel.txt"), "inode-original");
    gateway.beginTurn(TOKEN_TWO, {
      botId: "graph",
      threadId: "root-inode-swap",
      cwd: inodeWorkspace,
      graphPermissionClass: "workspace-write",
    });
    renameSync(inodeWorkspace, displacedInodeWorkspace);
    mkdirSync(inodeWorkspace);
    writeFileSync(join(inodeWorkspace, "sentinel.txt"), "replacement-untouched");

    expect(() => gateway.inventory(TOKEN_TWO)).toThrow(/workspace root identity changed/);
    await expect(gateway.listTools(TOKEN_TWO, "openmaus-host")).rejects.toThrow(/workspace root identity changed/);
    await expect(gateway.callTool(TOKEN_TWO, "openmaus-host", "filesystem_read", { path: "sentinel.txt" }))
      .rejects.toThrow(/workspace root identity changed/);
    await expect(gateway.callTool(TOKEN_TWO, "openmaus-host", "filesystem_write", {
      path: "sentinel.txt",
      content: "must-not-land",
      expectedSha256: `sha256:${"b".repeat(64)}`,
    })).rejects.toThrow(/workspace root identity changed/);
    expect(readFileSync(join(inodeWorkspace, "sentinel.txt"), "utf8")).toBe("replacement-untouched");
    expect(readFileSync(join(displacedInodeWorkspace, "sentinel.txt"), "utf8")).toBe("inode-original");
  });

  it("creates no file when an approved parent is replaced at the anchored-write boundary", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "omb-graph-parent-race-")));
    temporary.push(root);
    const cwd = join(root, "workspace");
    const parent = join(cwd, "parent");
    const displacedParent = join(cwd, "parent-before-race");
    mkdirSync(parent, { recursive: true });
    const hostCatalog: HostMcpCatalog = {
      servers: { "openmaus-host": { type: "builtin" } },
      manifest: createCapabilityProfileManifest(),
      sources: { claude: "missing", codex: "missing" },
    };
    let swap = false;
    const gateway = new CapabilityGateway(hostCatalog, {
      beforeGraphAnchoredWrite: () => {
        if (!swap) return;
        swap = false;
        renameSync(parent, displacedParent);
        mkdirSync(parent);
      },
    });
    open.push(gateway);
    gateway.beginTurn(TOKEN, {
      botId: "graph",
      threadId: "parent-race",
      cwd,
      graphPermissionClass: "workspace-write",
    });

    const absent = await gateway.callTool(TOKEN, "openmaus-host", "filesystem_stat", { path: "parent/new.txt" });
    swap = true;
    await expect(gateway.callTool(TOKEN, "openmaus-host", "filesystem_write", {
      path: "parent/new.txt",
      content: "must-not-land",
      expectedSha256: absent.sha256,
    })).rejects.toThrow(/parent identity changed/);
    expect(() => readFileSync(join(parent, "new.txt"))).toThrow();
    expect(() => readFileSync(join(displacedParent, "new.txt"))).toThrow();
  });

  it("rejects a sparse oversized graph file before allocating a read preimage", async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "omb-graph-size-")));
    temporary.push(cwd);
    const path = join(cwd, "sparse.bin");
    const size = 1024 * 1024 + 1;
    writeFileSync(path, "");
    truncateSync(path, size);
    const hostCatalog: HostMcpCatalog = {
      servers: { "openmaus-host": { type: "builtin" } },
      manifest: createCapabilityProfileManifest(),
      sources: { claude: "missing", codex: "missing" },
    };
    const gateway = new CapabilityGateway(hostCatalog);
    open.push(gateway);
    gateway.beginTurn(TOKEN, {
      botId: "graph",
      threadId: "bounded-read",
      cwd,
      graphPermissionClass: "workspace-write",
    });

    await expect(gateway.callTool(TOKEN, "openmaus-host", "filesystem_read", { path: "sparse.bin" }))
      .rejects.toThrow(/bounded file size/);
    const sparseSha256 = `sha256:${createHash("sha256").update(Buffer.alloc(size)).digest("hex")}`;
    await expect(gateway.callTool(TOKEN, "openmaus-host", "filesystem_write", {
      path: "sparse.bin",
      content: "small",
      expectedSha256: sparseSha256,
    })).rejects.toThrow(/exact preimage/);
    expect(statSync(path).size).toBe(size);
  });

  it("does not authorize graph writes from truncated or binary read preimages", async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "omb-graph-complete-read-")));
    temporary.push(cwd);
    const truncatedPath = join(cwd, "truncated.txt");
    const binaryPath = join(cwd, "binary.txt");
    const truncatedBody = Buffer.alloc(256 * 1024 + 1, "a");
    const binaryBody = Buffer.from([0x61, 0x00, 0x62]);
    writeFileSync(truncatedPath, truncatedBody);
    writeFileSync(binaryPath, binaryBody);
    const hostCatalog: HostMcpCatalog = {
      servers: { "openmaus-host": { type: "builtin" } },
      manifest: createCapabilityProfileManifest(),
      sources: { claude: "missing", codex: "missing" },
    };
    const gateway = new CapabilityGateway(hostCatalog);
    open.push(gateway);
    gateway.beginTurn(TOKEN, {
      botId: "graph",
      threadId: "complete-read",
      cwd,
      graphPermissionClass: "workspace-write",
    });

    const truncated = await gateway.callTool(TOKEN, "openmaus-host", "filesystem_read", { path: "truncated.txt" });
    expect(JSON.stringify(truncated)).toContain("oversized capability output truncated");
    const truncatedSha256 = `sha256:${createHash("sha256").update(truncatedBody).digest("hex")}`;
    await expect(gateway.callTool(TOKEN, "openmaus-host", "filesystem_write", {
      path: "truncated.txt",
      content: "replacement",
      expectedSha256: truncatedSha256,
    })).rejects.toThrow(/complete UTF-8 preimage/);

    const binary = await gateway.callTool(TOKEN, "openmaus-host", "filesystem_read", { path: "binary.txt" });
    expect(binary).toMatchObject({ content: "[binary capability output omitted]", bytes: binaryBody.byteLength });
    await expect(gateway.callTool(TOKEN, "openmaus-host", "filesystem_write", {
      path: "binary.txt",
      content: "replacement",
      expectedSha256: binary.sha256,
    })).rejects.toThrow(/complete UTF-8 preimage/);

    expect(readFileSync(truncatedPath)).toEqual(truncatedBody);
    expect(readFileSync(binaryPath)).toEqual(binaryBody);
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
      manifest: createCapabilityProfileManifest({ toolInventory: ["test", "openmaus-fleet:search_capabilities"] }),
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

  it("rejects whole-repository deletion and scrubs exact canaries before host execution", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omb-host-core-"));
    temporary.push(cwd);
    mkdirSync(join(cwd, ".git"));
    const canary = "gateway-canary-exact-927364";
    process.env.GATEWAY_TEST_SECRET = canary;
    try {
      const hostCatalog: HostMcpCatalog = {
        servers: { "openmaus-host": { type: "builtin" } },
        manifest: createCapabilityProfileManifest({ toolInventory: ["openmaus-host:shell_execute"] }),
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
    }
  });

  it("projects one lazy observer bridge and denies every non-observer capability before startup", async () => {
    chmodSync(FAKE_OBSERVER, 0o755);
    const directory = mkdtempSync(join(tmpdir(), "omb-observer-gateway-"));
    temporary.push(directory);
    const receipt = join(directory, "calls.ndjson");
    const observerCatalog: HostMcpCatalog = {
      servers: {
        "aos-fleet-bridge": {
          type: "stdio",
          command: process.execPath,
          args: [FAKE_OBSERVER],
          env: { OBSERVER_CALL_RECEIPT: receipt },
        },
      },
      manifest: createObserverRouterProfileManifest({ serverInventory: ["aos-fleet-bridge"] }),
      sources: { claude: "loaded", codex: "loaded" },
    };
    const gateway = new CapabilityGateway(observerCatalog, {
      observerPresence: {
        presenceDir: join(directory, "presence"),
        proposalFeedPath: join(directory, "proposals.json"),
      },
    });
    open.push(gateway);
    gateway.beginTurn(TOKEN, {
      botId: "ada",
      threadId: "observer-task",
      ttlMs: 60 * 60_000,
      servers: { "openmaus-host": { type: "builtin" } },
    });
    gateway.extendTurn(TOKEN, {
      "openmaus-computer": { type: "stdio", command: process.execPath, args: [FAKE], env: {} },
    });

    expect(gateway.inventory(TOKEN)).toMatchObject({
      manifest: {
        profile: "observer-router",
        telemetryMode: "metadata",
        toolInventory: ["aos-fleet-bridge"],
      },
      servers: [{ name: "aos-fleet-bridge", type: "stdio" }],
    });
    const listed = await gateway.listTools(TOKEN, "aos-fleet-bridge");
    const names = listed.tools.map((tool: { name: string }) => tool.name);
    expect(names).toEqual([
      "protocol_capabilities",
      "surface_status",
      "inbox_pull",
      "message_ack",
      "task_status",
      "presence_list",
      "presence_status",
      "improvement_proposals",
    ]);
    expect(names).not.toEqual(expect.arrayContaining([
      "task_submit",
      "task_result",
      "task_cancel",
      "wake",
      "shell_execute",
      "filesystem_write",
      "filesystem_delete",
      "deploy",
      "send_message",
      "permission_grant",
      "publish",
      "transcript_read",
      "session_control",
      "hindsight_retain",
      "obsidian_write",
    ]));
    expect(gateway.stats().activeBackends).toEqual([]);
    await expect(gateway.aliases(TOKEN)).rejects.toThrow(/does not expose credential aliases/);
    await expect(
      gateway.selectCredentialAlias(TOKEN, "aos-fleet-bridge", "alias", "TOKEN"),
    ).rejects.toThrow(/does not allow credential selection/);

    for (const tool of [
      "task_submit",
      "task_result",
      "task_cancel",
      "wake",
      "shell_execute",
      "filesystem_write",
      "filesystem_delete",
      "deploy_production",
      "send_message",
      "permission_escalate",
      "external_publish",
      "transcript_read",
      "session_control",
      "hindsight_retain",
      "obsidian_write",
    ]) {
      const denied = await gateway.callTool(TOKEN, "aos-fleet-bridge", tool, {});
      expect(denied).toMatchObject({ isError: true });
    }
    expect(gateway.stats().activeBackends).toEqual([]);

    const pulled = await gateway.callTool(TOKEN, "aos-fleet-bridge", "inbox_pull", { limit: 3 });
    expect(pulled.structuredContent).toEqual({
      name: "inbox_list",
      arguments: { surface: "openmausbot", limit: 3 },
    });
    expect(pulled._meta["openmaus.observer"]).toMatchObject({
      instructionAuthority: false,
      mutationAuthority: "none",
    });
  });

  it("suppresses duplicate acknowledgements and rejects calls after the five-minute lease", async () => {
    chmodSync(FAKE_OBSERVER, 0o755);
    const directory = mkdtempSync(join(tmpdir(), "omb-observer-lease-"));
    temporary.push(directory);
    const receipt = join(directory, "calls.ndjson");
    let now = 1_000_000;
    const gateway = new CapabilityGateway({
      servers: {
        "aos-fleet-bridge": {
          type: "stdio",
          command: process.execPath,
          args: [FAKE_OBSERVER],
          env: { OBSERVER_CALL_RECEIPT: receipt },
        },
      },
      manifest: createObserverRouterProfileManifest({ serverInventory: ["aos-fleet-bridge"] }),
      sources: { claude: "missing", codex: "loaded" },
    }, { now: () => now, idleTimeoutMs: 60_000 });
    open.push(gateway);
    gateway.beginTurn(TOKEN, { botId: "ada", threadId: "observer", ttlMs: 60 * 60_000 });

    const first = await gateway.callTool(TOKEN, "aos-fleet-bridge", "message_ack", {
      entry_id: "abcdef1234567890",
      note: "read",
    });
    const duplicate = await gateway.callTool(TOKEN, "aos-fleet-bridge", "message_ack", {
      entry_id: "abcdef1234567890",
      note: "different note is still the same acknowledgement",
    });
    expect(first._meta["openmaus.observer"].duplicateSuppressed).toBe(false);
    expect(duplicate._meta["openmaus.observer"].duplicateSuppressed).toBe(true);
    const calls = readFileSync(receipt, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(calls).toEqual([{
      name: "message_ack",
      arguments: { entry_id: "abcdef1234567890", note: "read", surface: "openmausbot" },
    }]);

    now += 300_001;
    await expect(
      gateway.callTool(TOKEN, "aos-fleet-bridge", "surface_status", {}),
    ).rejects.toThrow(/turn is no longer active/);
    expect(readFileSync(receipt, "utf8").trim().split("\n")).toHaveLength(1);
  });
});
