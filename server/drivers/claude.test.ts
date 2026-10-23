import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";

import { createServer as createHttpServer, type IncomingHttpHeaders } from "node:http";
import { connect, createServer as createNetServer, type AddressInfo, type Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR, ensureDirs, instanceConfigs, NATIVE_DIR, type AppConfig } from "../config.ts";
import { TurnAuthenticationRefusedError, type ProviderInstance } from "../contracts.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { BACKGROUND_CALL_TIMEOUT_MS, backgroundCallArgs } from "./claude-background.ts";
import {
  autoCompactWindow,
  brokerSocketCandidates,
  claudeCliSupports,
  claudeCliUpdate,
  claudeHookSettings,
  ClaudeDriver,
  createPermissionBroker,
  hookTokenFile,
  parseClaudeCliVersion,
  PERMISSION_BROKER_TIMEOUT_MS,
  permissionSocketPath,
  readClaudeAuthSettings,
  claudeCostSnapshot,
  restoredCostBase,
  STEERED_CONTINUATION_GRACE_MS,
  sumNativeTurnResults,
  turnCostFromRunningTotal,
  type ClaudeConfig,
} from "./claude.ts";
import { TEAM_TOOLS_FAILED } from "./team-tools.ts";
import { claudeLimitMessage } from "./claude-limits.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { reviewApproval } from "../approval-review.ts";
import { rebuiltSessionNotice } from "../resume-recovery.ts";
import { BASH_MAX_TIMEOUT_MS } from "../system-prompt.ts";
import { ephemeralWorkspaceTokenPath } from "../workspace-backup-policy.ts";
import * as procs from "../procs.ts";
import * as localInject from "./local-inject.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-claude-cli.ts");
 const dumpedPid = (dump: string): number => JSON.parse(readFileSync(dump, "utf8")).pid;

 const COLLISION_THREAD_IDS = ["t-dup-1", "t-dup-2", "t-dup-3", "t-dup-4"];

 function connectSocket(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    let retriesLeft = 20;
    const tryConnect = () => {
      const conn = connect(path);
      const onConnect = () => {
        conn.removeListener("error", onError);
        resolve(conn);
      };
      const onError = (error: NodeJS.ErrnoException) => {
        conn.removeListener("connect", onConnect);
        conn.destroy();
        if (process.platform === "win32" && error.code === "ENOENT" && retriesLeft-- > 0) {
          setTimeout(tryConnect, 25);
          return;
        }
        reject(error);
      };
      conn.once("connect", onConnect);
      conn.once("error", onError);
    };
    tryConnect();
  });
}

 function answerQueue(conn: ReturnType<typeof connect>) {
  const waiters: Array<(msg: any) => void> = [];
  let buf = "";
  conn.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      waiters.shift()?.(JSON.parse(line));
    }
  });
  return () => new Promise<any>((resolve) => waiters.push(resolve));
}

const CONTROL_PLANE_FIXTURE = {
  OMB_CLOUD_READY_TOKEN: "ready-should-not-leak", OMB_CLOUD_BOOTSTRAP: "bootstrap-should-not-leak",
  OMB_LICENSE_KEY: "license-should-not-leak", OMB_INSTALLATION_CREDENTIAL: "fleet-should-not-leak",
};

describe("ClaudeDriver.decodeConfig", () => {
  it("quotes hook paths as shell data rather than JSON strings", () => {
    const settings = claudeHookSettings("/tmp/it's $OMB_HOOK_TEST `literal`/helper.ts") as { PostToolUse: Array<{ hooks: Array<{ command: string }> }> };
    const command = settings.PostToolUse[0]!.hooks[0]!.command;
    if (process.platform === "win32") {
      expect(command).toBe('"%OMB_HOOK_NODE%" "%OMB_HOOK_HELPER%"');
    } else {
      expect(command).toContain("'/tmp/it'\\''s $OMB_HOOK_TEST `literal`/helper.ts'");
    }
  });

  it("hooks failed tool calls too, so a timed-out command can be given a hint", () => {
    expect(Object.keys(claudeHookSettings("/tmp/helper.ts"))).toContain("PostToolUseFailure");
  });

  it("keeps the per-turn hook token where workspace backups never look", () => {
    const path = relative(DATA_DIR, hookTokenFile("thread", "bot")).replaceAll("\\", "/");
    expect(ephemeralWorkspaceTokenPath(path)).toBe(true);
    expect(ephemeralWorkspaceTokenPath(path.split("/")[0]!)).toBe(true);
  });

  it("defaults to the claude binary with acceptEdits", () => {
    expect(ClaudeDriver.decodeConfig({})).toEqual({ cli: "claude", permissionMode: "acceptEdits" });
    expect(ClaudeDriver.decodeConfig(undefined)).toEqual({ cli: "claude", permissionMode: "acceptEdits" });
  });

  it("bills a steered continuation's native results as one turn", () => {
    const first = { ok: true, stopReason: "end_turn", cost: 0.01, usage: { input: 12, output: 5, cachedInput: 2 } };
    expect(sumNativeTurnResults(null, first)).toEqual(first);
    expect(sumNativeTurnResults(first, { ok: true, stopReason: "end_turn", cost: 0.03, usage: { input: 3, output: 4 } }))
      .toEqual({ ok: true, stopReason: "end_turn", cost: 0.03, usage: { input: 15, output: 9, cachedInput: 2 } });
    expect(sumNativeTurnResults(first, { ok: false, stopReason: null, cost: null }))
      .toEqual({ ok: false, stopReason: "end_turn", cost: 0.01, usage: first.usage });
    expect(sumNativeTurnResults({ ok: true, stopReason: null, cost: null }, { ok: true, stopReason: null, cost: null }))
      .toEqual({ ok: true, stopReason: null, cost: null });
  });

  it("accepts the three known permission modes", () => {
    for (const permissionMode of ["acceptEdits", "auto", "bypassPermissions"] as const) {
      expect(ClaudeDriver.decodeConfig({ permissionMode }).permissionMode).toBe(permissionMode);
    }
  });

  it("books a turn's share of the CLI's running cost total", () => {
    expect(turnCostFromRunningTotal(1.5822674, null)).toBe(1.5822674);
    expect(turnCostFromRunningTotal(1.7255570000000002, 1.5822674)).toBe(0.1432896);
    expect(turnCostFromRunningTotal(0.03, 0.02)).toBe(0.01);
    expect(turnCostFromRunningTotal(0.02, 0.02)).toBe(0);
    expect(turnCostFromRunningTotal(null, 0.02)).toBeNull();
    expect(turnCostFromRunningTotal(0.004, 0.02)).toBe(0.004);
  });

  it("finds the running cost the CLI restored for a resumed session", () => {
    const opus = (total: number, tokens: [number, number, number, number]) => claudeCostSnapshot(total, {
      "claude-opus-5-5": { inputTokens: tokens[0], cacheReadInputTokens: tokens[1], cacheCreationInputTokens: tokens[2], outputTokens: tokens[3], costUSD: total },
    })!;
    const earlier = [
      opus(1.5822674, [18, 776097, 103347, 30010]),
      opus(1.7255570000000002, [24, 1167845, 107739, 31499]),
      opus(3.2557024000000006, [34, 1682172, 227804, 54835]),
      opus(4.3538464, [36, 1682172, 353781, 59351]),
    ];
    const resumed = opus(4.212299000000001, [60, 3542515, 254587, 73343]);
    expect(restoredCostBase(earlier, resumed, { input: 26, cacheRead: 1860343, cacheWrite: 26783, output: 18508 })).toBe(3.2557024000000006);
    const fresh = claudeCostSnapshot(0.20990999999999999, {
      "claude-haiku-4-5-20251001": { inputTokens: 978, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 10, costUSD: 0.001028 },
      "claude-sonnet-5": { inputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 52057, outputTokens: 65, costUSD: 0.208882 },
    })!;
    expect(restoredCostBase([], fresh, { input: 2, cacheRead: 0, cacheWrite: 52057, output: 65 })).toBe(0);
    const beforeInterrupt = opus(0.8265352, [20, 559016, 79339, 3997]);
    const afterInterrupt = opus(3.0735268, [86, 4211334, 254837, 9611]);
    expect(restoredCostBase([beforeInterrupt], afterInterrupt, { input: 48, cacheRead: 2873716, cacheWrite: 142479, output: 3805 })).toBe(0.8265352);
    expect(restoredCostBase([], resumed, { input: 26, cacheRead: 1860343, cacheWrite: 26783, output: 18508 })).toBe(0);
    expect(claudeCostSnapshot(null, {})).toBeNull();
  });

  it("matches a resumed turn split over two models by the sum of its growth", () => {
    const state = (total: number, models: Record<string, number>) => claudeCostSnapshot(total, Object.fromEntries(
      Object.entries(models).map(([model, input]) => [model, { inputTokens: input, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 0, costUSD: 0 }]),
    ))!;
    const earlier = [state(0.01, { A: 2 }), state(0.02, { A: 3 })];
    expect(restoredCostBase(earlier, state(0.03, { A: 3, B: 1 }), { input: 2, cacheRead: 0, cacheWrite: 0, output: 0 })).toBe(0.01);
  });

  it("measures from the latest known state, not the highest total", () => {
    const state = (total: number, input: number) => claudeCostSnapshot(total, {
      A: { inputTokens: input, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 0, costUSD: total },
    })!;
    const earlier = [state(0.05, 5), state(0.03, 4)];
    expect(restoredCostBase(earlier, state(0.06, 8), { input: 1, cacheRead: 0, cacheWrite: 0, output: 0 })).toBe(0.03);
  });

  it("throws on an invalid permissionMode (registry downgrades this to a shadow)", () => {
    expect(() => ClaudeDriver.decodeConfig({ permissionMode: "yolo" })).toThrow(/permissionMode/);
  });

  it("normalizes and deduplicates built-in tool lists", () => {
    expect(
      ClaudeDriver.decodeConfig({
        tools: [" Read ", "WebFetch", "Read"],
        disallowedTools: [" Bash(git *) ", "Bash(git *)"],
      }),
    ).toMatchObject({
      tools: ["Read", "WebFetch"],
      disallowedTools: ["Bash(git *)"],
    });
    expect(ClaudeDriver.decodeConfig({ tools: [] }).tools).toEqual([]);
  });

  it.each([
    ["tools", "Read"],
    ["tools", ["Read", " "]],
    ["disallowedTools", [42]],
  ])("rejects invalid %s configuration", (field, value) => {
    expect(() => ClaudeDriver.decodeConfig({ [field]: value })).toThrow(new RegExp(field));
  });

  it.skipIf(process.platform !== "win32")("names permission pipes per harness process", () => {
    expect(permissionSocketPath("thread-abc")).toMatch(
      new RegExp(`^\\\\\\\\\\.\\\\pipe\\\\openmausbot-perm-${process.pid}-thre[0-9a-f]{4}$`),
    );
  });

  it("keeps threads whose ids share a prefix on distinct sockets", () => {
    expect(permissionSocketPath("t-perm-dup-1")).not.toBe(permissionSocketPath("t-perm-dup-2"));
  });

  it("advertises per-bot local CUA but rejects legacy bypass turns without a mode", async () => {
    const bypass = await ClaudeDriver.create({
      instanceId: "claude-bypass",
      displayName: "Claude Bypass",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, permissionMode: "bypassPermissions" },
    });
    expect(bypass.adapter.capabilities.localComputerMcp).toBe(true);
    await expect(
      bypass.adapter.sendTurn({
        threadId: "t-bypass-local",
        text: "click",
        integrations: {
          localComputer: {
            command: "/cua-driver",
            args: ["mcp"],
            env: {},
            platform: "linux",
            scope: "local-computer",
          },
        },
      }),
    ).rejects.toThrow(/interactive approval broker/);
    expect(bypass.startAuthentication).toBeTypeOf("function");
    expect(bypass.signOut).toBeTypeOf("function");
    await bypass.dispose();
  });

  it("gives each collision test a distinct broker pipe path", () => {
    const paths = COLLISION_THREAD_IDS.map((threadId) => permissionSocketPath(threadId));
    expect(new Set(paths).size).toBe(COLLISION_THREAD_IDS.length);
  });

  it("gives two bots distinct broker pipes even if they ever share a threadId (#1017)", () => {
    const sharedThreadId = "t-shared-by-parent-and-child";
    const parentPath = permissionSocketPath(sharedThreadId, "bot-chief");
    const childPath = permissionSocketPath(sharedThreadId, "bot-cliff");
    expect(parentPath).not.toBe(childPath);
  });

  it("disposes its account controller while a logout is running", async () => {
    const home = mkdtempSync(join(tmpdir(), "omb-claude-logout-dispose-"));
    const cli = join(home, "fake-logout.mjs");
    const pidPath = join(home, "logout-pid");
    writeFileSync(cli, [
      "#!/usr/bin/env node",
      'import { writeFileSync } from "node:fs";',
      'import { join } from "node:path";',
      'if (process.argv.slice(2).join(" ") !== "auth logout") process.exit(2);',
      'writeFileSync(join(process.env.HOME, "logout-pid"), String(process.pid));',
      'setInterval(() => {}, 1000);',
    ].join("\n"), { mode: 0o700 });
    const instance = await ClaudeDriver.create({
      instanceId: "claude-logout-dispose", displayName: "Fixture", enabled: true,
      config: { cli, permissionMode: "acceptEdits" },
      environment: { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, ".claude") },
    });
    const pending = instance.signOut!().catch(() => {});
    let pid: number | undefined;
    const alive = (value: number) => { try { process.kill(value, 0); return true; } catch { return false; } };
    try {
      await expect.poll(() => existsSync(pidPath), { timeout: 2500 }).toBe(true);
      pid = Number(readFileSync(pidPath, "utf8"));
      await instance.dispose();
      expect(alive(pid)).toBe(false);
      await expect(instance.signOut!()).rejects.toThrow("provider was removed");
    } finally {
      if (pid !== undefined && alive(pid)) {
        if (process.platform === "win32") process.kill(pid, "SIGKILL");
        else process.kill(-pid, "SIGKILL");
      }
      await pending;
      await instance.dispose();
      await removeTempDir(home);
    }
  }, 60_000);

  it("keeps the deterministic path as the first broker candidate", () => {
    const candidates = brokerSocketCandidates("t-candidates");
    expect(candidates[0]).toBe(permissionSocketPath("t-candidates"));
    if (process.platform === "win32") {
      expect(candidates.length).toBeGreaterThan(1);
      expect(new Set(candidates).size).toBe(candidates.length);
    } else {
      expect(candidates).toHaveLength(2);
      expect(candidates[1]).toMatch(/omb-perm-[0-9a-f]{16}\.sock$/);
      expect(candidates[1]).not.toBe(candidates[0]);
    }
  });

  it.skipIf(process.platform === "win32")(
    "binds the next candidate when the first is unbindable, and asks round-trip on it",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "omb-broker-fallback-"));
      const held = join(dir, "held.sock");
      mkdirSync(held);
      const free = join(dir, "free.sock");
      const asks: Array<{ id: string }> = [];
      const broker = await createPermissionBroker({
        socketPaths: [held, free],
        onAsk: (ask) => asks.push(ask),
        onResolve: () => {},
      });
      try {
        expect(broker.socketPath).toBe(free);
        const conn = connect(free);
        await new Promise<void>((resolve, reject) => {
          conn.on("connect", resolve);
          conn.on("error", reject);
        });
        const answered = new Promise<{ behavior: string }>((resolve) => {
          let buf = "";
          conn.on("data", (c) => {
            buf += c;
            const nl = buf.indexOf("\n");
            if (nl !== -1) resolve(JSON.parse(buf.slice(0, nl)));
          });
        });
        conn.write(JSON.stringify({ t: "ask", id: "ask-fb", tool: "Bash", input: { command: "echo hi" } }) + "\n");
        await expect.poll(() => asks.length).toBe(1);
        expect(broker.answer("ask-fb", "allow")).toBe(true);
        expect(await answered).toMatchObject({ behavior: "allow" });
        conn.end();
      } finally {
        broker.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps a large non-ASCII ask whole across socket reads",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "omb-broker-utf8-"));
      const socketPath = join(dir, "broker.sock");
      const asks: Array<{ input: unknown }> = [];
      const broker = await createPermissionBroker({
        socketPaths: [socketPath],
        onAsk: (ask) => asks.push(ask),
        onResolve: () => {},
      });
      try {
        const content = "中文ok€".repeat(150_000);
        const conn = connect(socketPath);
        await new Promise<void>((resolve, reject) => {
          conn.on("connect", resolve);
          conn.on("error", reject);
        });
        conn.write(JSON.stringify({ t: "ask", id: "ask-utf8", tool: "Write", input: { file_path: "notes.md", content } }) + "\n");
        await expect.poll(() => asks.length, { timeout: 20_000 }).toBe(1);
        const received = (asks[0]!.input as { content: string }).content;
        expect(received.includes("\uFFFD")).toBe(false);
        expect(received === content).toBe(true);
        conn.destroy();
      } finally {
        broker.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it.skipIf(process.platform === "win32")(
    "rejects instead of returning an occupied path when every candidate is unavailable",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "omb-broker-unavailable-"));
      const heldOne = join(dir, "held-one.sock");
      const heldTwo = join(dir, "held-two.sock");
      mkdirSync(heldOne);
      mkdirSync(heldTwo);
      try {
        await expect(
          createPermissionBroker({
            socketPaths: [heldOne, heldTwo],
            onAsk: () => {},
            onResolve: () => {},
          }),
        ).rejects.toThrow(/could not bind a local socket/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("ClaudeDriver turns (fake CLI)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;

  const create = async (
    mode?: string,
    environment: Record<string, string> = {},
    config: Partial<ClaudeConfig> = {},
  ) => {
    if (mode) process.env.FAKE_CLAUDE_MODE = mode;
    instance = await ClaudeDriver.create({
      instanceId: "claude-test",
      displayName: "Claude Test",
      environment,
      enabled: true,
      config: {
        ...config,
        cli: config.cli ?? FAKE_CLI,
        permissionMode: config.permissionMode ?? "acceptEdits",
      },
    });
    recorder = recordEvents(instance.adapter);
  };

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "omb-claude-test-"));
  });

  it("refuses an unsupported native selection before launching, even with instance tools and Full access", async () => {
    const dump = join(scratch, "scope-refused.json"); process.env.FAKE_CLAUDE_DUMP = dump;
    await create("echo", {}, { tools: ["Read"], disallowedTools: ["Write"] });
    await expect(instance.adapter.sendTurn({ threadId: "scope-refused", text: "Must not run", toolScope: { allow: ["native:Read", "native:Write"] }, approvalMode: "full", guestConfined: true })).rejects.toThrow(/native tool selection.*not supported/i);
    expect(existsSync(dump)).toBe(false);
  });

  it("gates every eligible MCP mount while preserving guest and instance restrictions", async () => {
    const dump = join(scratch, "scope-mcp.json"); process.env.FAKE_CLAUDE_DUMP = dump;
    await create("echo", { FAKE_CLAUDE_VERSION: "2.1.284" }, { tools: ["Read"], disallowedTools: ["Write"] });
    await instance.adapter.sendTurn({ threadId: "scope-mcp", text: "Fixture", approvalMode: "ask", guestConfined: true, toolScope: { allow: ["native:*", "mcp:agents:list_bots"] }, integrations: {
      agents: { command: "node", args: ["agents"], env: {} }, browser: { command: "node", args: ["browser"], env: {} },
    } });
    await recorder.until((event) => event.type === "turn.completed");
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv).toContain("--restricted");
    expect(seen.argv[seen.argv.indexOf("--disallowedTools") + 1]).toBe("Write");
    expect(seen.mcpConfig.mcpServers).not.toHaveProperty("browser");
    expect(JSON.parse(seen.mcpConfig.mcpServers.agents.env.OMB_GATE_TOOL_SCOPE)).toEqual({ allow: ["native:*", "mcp:agents:list_bots"] });
  });

  it("keeps a bot's tool selection working with the person's own skills", async () => {
    const dump = join(scratch, "scope-user-skills.json"); process.env.FAKE_CLAUDE_DUMP = dump;
    await create();
    await instance.adapter.sendTurn({ threadId: "scope-user-skills", text: "Fixture", userSkillsDir: join(scratch, "claude-user-skills"), toolScope: { allow: ["native:*"] } });
    await recorder.until((event) => event.type === "turn.completed");
    expect(JSON.parse(readFileSync(dump, "utf8")).argv).toContain("--add-dir");
  });

  it("refuses native MCP inheritance when a bot has an explicit selection", async () => {
    const dump = join(scratch, "scope-inherited-mcp.json"); process.env.FAKE_CLAUDE_DUMP = dump;
    await create();
    await expect(instance.adapter.sendTurn({ threadId: "scope-inherited-mcp", text: "Must not run", mcpFromUserConfig: true, toolScope: { allow: ["native:*"] } })).rejects.toThrow(/restricted MCP configuration/);
    expect(existsSync(dump)).toBe(false);
  });

  afterEach(async () => {
    delete process.env.FAKE_CLAUDE_MODE;
    delete process.env.FAKE_CLAUDE_AUTO_UNAVAILABLE_MODELS;
    delete process.env.FAKE_CLAUDE_OMIT_PERMISSION_MODE;
    delete process.env.FAKE_CLAUDE_DUMP;
    delete process.env.FAKE_CLAUDE_PROMPTS;
    delete process.env.FAKE_CLAUDE_TRANSIENTS;
    delete process.env.FAKE_CLAUDE_PARTIAL_FAILS;
    delete process.env.FAKE_CLAUDE_STATE;
    delete process.env.FAKE_CLAUDE_RETRY_SCALE;
    delete process.env.FAKE_CLAUDE_TEXT_HANG;
    delete process.env.FAKE_CLAUDE_STEER_GRACE_SCALE;
    delete process.env.FAKE_CLAUDE_STEER_SILENCE_SCALE;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.XAI_API_KEY;
    delete process.env.COMPOSIO_API_KEY;
    delete process.env.BOX_TOKEN;
    delete process.env.OPENCODE_API_KEY;
    delete process.env.OMB_TTS_KEY;
    for (const name of Object.keys(CONTROL_PLANE_FIXTURE)) delete process.env[name];
    delete process.env.OMB_CLAUDE_SESSION_IDLE_MS;
    delete process.env.OMB_CLAUDE_SESSION_IDLE_MIN_MS;
    recorder?.stop();
    await instance?.dispose();
    await removeTempDir(scratch);
  });

  it.each([
    ["without a workspace URL", { key: "sk-ant-workspace-secret" }],
    ["with a workspace URL", { key: "sk-ant-workspace-secret", url: "http://127.0.0.1:9" }],
  ])("sends a router instance's turn to its own host with only its own token (%s)", async (_label, anthropic) => {
    const seen: IncomingHttpHeaders[] = [];
    const router = createHttpServer((request, response) => {
      seen.push(request.headers);
      request.resume();
      response.end("{}");
    });
    await new Promise<void>((resolve) => router.listen(0, "127.0.0.1", resolve));
    try {
      const base = `http://127.0.0.1:${(router.address() as AddressInfo).port}`;
      const map = instanceConfigs({
        anthropic,
        instances: {
          claude: { driver: "claudeAgent" },
          router: { driver: "claudeAgent", environment: { ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: "router-token" } },
        },
      });
      expect(map.claude!.environment).toMatchObject({ ANTHROPIC_API_KEY: "sk-ant-workspace-secret" });
      process.env.FAKE_CLAUDE_ROUTER_PING = "1";
      await create(undefined, map.router!.environment as Record<string, string>);
      await instance.adapter.sendTurn({ threadId: "t-router", text: "hi", model: "claude-sonnet-5" });
      await recorder.until((e) => e.type === "turn.completed");
      expect(seen).toHaveLength(1);
      expect(seen[0]!.authorization).toBe("Bearer router-token");
      expect(seen[0]!["x-api-key"]).toBeUndefined();
      expect(JSON.stringify(seen)).not.toContain("sk-ant-workspace-secret");
    } finally {
      delete process.env.FAKE_CLAUDE_ROUTER_PING;
      await new Promise((resolve) => router.close(resolve));
    }
  });

  it("normalizes a full turn into the canonical event sequence", async () => {
    await create();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-happy", text: "hi", model: "claude-sonnet-5" });
    await recorder.until((e) => e.type === "turn.completed");

    const types = recorder.events.map((e) => e.type);
    expect(types).toEqual([
      "turn.started",
      "session.started",
      "content.delta",
      "item.completed",
      "item.started",
      "thread.token-usage.updated",
      "item.completed",
      "turn.completed",
    ]);
    expect(recorder.events.every((e) => e.turnId === turnId && e.provider === "claudeAgent")).toBe(true);
    expect(recorder.events.find((e) => e.type === "item.started")).toMatchObject({ title: "Bash", summary: "echo hi" });
    expect(recorder.events.find((e) => e.type === "item.started")).toMatchObject({ input: expect.stringContaining("echo hi") });
    expect(recorder.events.find((e) => e.type === "item.completed" && e.itemType === "tool")).toMatchObject({ output: expect.stringContaining('"text": "hi"') });

    const usage = recorder.events.find((e) => e.type === "thread.token-usage.updated")!;
    expect(usage).toMatchObject({ input: 12, output: 5, cachedInput: 2 });
    const done = recorder.events.at(-1)!;
    expect(done).toMatchObject({ type: "turn.completed", ok: true, cost: 0.01, usage: { input: 12, output: 5, cachedInput: 2 } });
    expect(instance.adapter.hasSession("t-happy")).toBe(false);
  });

  it("streams partial-message text deltas without re-emitting the whole message", async () => {
    await create("stream");
    await instance.adapter.sendTurn({ threadId: "t-stream", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const deltas = recorder.events.filter((e) => e.type === "content.delta");
    const text = deltas.filter((d: any) => d.streamKind === "assistant_text");
    expect(text.map((d: any) => d.delta)).toEqual(["hello from ", "fake claude"]);
    expect(text.some((d: any) => d.delta.includes("SUBAGENT"))).toBe(false);
    expect(deltas.some((d: any) => d.streamKind === "reasoning_text" && d.delta === "hmm")).toBe(true);
    const settled = recorder.events.filter((e: any) => e.type === "item.completed" && e.itemType === "assistant_text");
    expect(settled).toHaveLength(1);
    expect((settled[0] as any).text).toBe("hello from fake claude");
  });

  it("passes on a running tool's heartbeat as tool activity, so a long tool is not taken for a stall", async () => {
    await create("tool-heartbeat");
    await instance.adapter.sendTurn({ threadId: "t-heartbeat", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const types = recorder.events.map((e) => e.type);
    const beat = types.indexOf("item.updated");
    expect(recorder.events[beat]).toMatchObject({ itemType: "tool" });
    expect(beat).toBeGreaterThan(types.indexOf("item.started"));
    expect(beat).toBeLessThan(types.lastIndexOf("item.completed"));
  });

  it("reports a long Write's input as it streams, after the bot's words and before its tool call", async () => {
    await create("slow-write", { FAKE_CLAUDE_WRITE_BYTES: "6144", FAKE_CLAUDE_WRITE_STEP_MS: "5" });
    await instance.adapter.sendTurn({ threadId: "t-slow-write", text: "build a dashboard" });
    await recorder.until((e) => e.type === "turn.completed", 20_000);

    const types = recorder.events.map((e) => e.type);
    const started = recorder.events.find((e) => e.type === "item.started") as any;
    const progress = recorder.events.filter((e) => e.type === "turn.progress") as any[];
    expect(progress.length, "one report per streamed chunk, before the bus coalesces them").toBeGreaterThan(10);
    expect(progress.every((e) => e.activity === "write" && e.itemId === started.itemId && e.turnId === started.turnId)).toBe(true);
    expect(progress.at(-1)).toMatchObject({ file: "index.html" });
    expect(progress.at(-1).bytes).toBeGreaterThanOrEqual(6144);
    const intro = recorder.events.findIndex((e: any) => e.type === "item.completed" && e.itemType === "assistant_text");
    expect(types.indexOf("turn.progress")).toBeGreaterThan(intro);
    expect(types.lastIndexOf("turn.progress")).toBeLessThan(types.indexOf("item.started"));
  });

  it("turns a signed-out CLI into a setup error, not a bot reply", async () => {
    const dump = join(scratch, "signed-out-session.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    await create("not-logged-in");
    await instance.adapter.sendTurn({ threadId: "t-auth", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const failure = recorder.events.find((e: any) => e.type === "runtime.error") as any;
    expect(failure).toMatchObject({ message: "Not logged in \u00b7 Please run /login", setup: true });
    expect(recorder.events.some((e: any) => e.type === "item.completed" && e.itemType === "assistant_text")).toBe(false);
    expect(recorder.events.some((e: any) => e.type === "content.delta")).toBe(false);
    expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: false, stopReason: "auth_required" });
    const pid = dumpedPid(dump);
    await expect.poll(() => {
      try { process.kill(pid, 0); return false; } catch { return true; }
    }, { timeout: 7_000 }).toBe(true);
  });

  it("reports a synthetic sign-out refusal for recovery only after its process has stopped", async () => {
    const dump = join(scratch, "recover-signed-out-session.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    await create("not-logged-in");
    await expect(instance.adapter.sendTurn({ threadId: "t-auth-recovery", text: "hi", startupRecovery: true }))
      .rejects.toBeInstanceOf(TurnAuthenticationRefusedError);
    expect(() => process.kill(dumpedPid(dump), 0)).toThrow();
    expect(recorder.events.some(event => event.type === "runtime.error" || event.type === "turn.completed")).toBe(false);
  });

  it("keeps a sign-out after model activity as an ordinary failed turn", async () => {
    await create("not-logged-in", { FAKE_CLAUDE_AUTH_AFTER_WORK: "1" });
    await expect(instance.adapter.sendTurn({ threadId: "t-auth-work", text: "hi", startupRecovery: true })).resolves.toHaveProperty("turnId");
    expect(await recorder.until(event => event.type === "turn.completed"))
      .toMatchObject({ ok: false, stopReason: "auth_required" });
    expect(recorder.events.find(event => event.type === "runtime.error"))
      .toMatchObject({ message: "Not logged in · Please run /login", setup: true });
  });

  it("recovers a later sign-out in a retained process without counting earlier turns as new work", async () => {
    const dump = join(scratch, "retained-sign-out.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    await create("happy", { FAKE_CLAUDE_AUTH_AFTER_TURN: "1" });
    const turn = { threadId: "t-auth-retained", text: "hi", startupRecovery: true };
    const first = await instance.adapter.sendTurn(turn);
    await recorder.until(event => event.type === "turn.completed" && event.turnId === first.turnId);
    const pid = dumpedPid(dump);
    await expect(instance.adapter.sendTurn({ ...turn, text: "again" })).rejects.toBeInstanceOf(TurnAuthenticationRefusedError);
    expect(dumpedPid(dump)).toBe(pid);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("settles an outdated CLI as update_required without emitting an assistant reply", async () => {
    const message = "API Error: 400 Claude Code 2.1.268 does not support this model; version 2.1.280 or newer is required. Run 'claude update'.";
    await create("api-error", { FAKE_CLAUDE_API_ERROR: message });
    await instance.adapter.sendTurn({ threadId: "t-update", text: "hi" });
    await recorder.until((event) => event.type === "turn.completed");
    expect(recorder.events).toContainEqual(expect.objectContaining({
      type: "runtime.error", message, setup: true, claudeUpdate: true,
    }));
    expect(recorder.events.some((event) => event.type === "item.completed" && event.itemType === "assistant_text")).toBe(false);
    expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: false, stopReason: "update_required" });
  });

  it("settles a turn its account's weekly limit refused as quota, saying when it resets, with no reply", async () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 3 * 86_400;
    const weekly = { status: "rejected", resetsAt, rateLimitType: "seven_day", overageStatus: "rejected", isUsingOverage: false };
    await create("usage-limit", { FAKE_CLAUDE_RATE_LIMIT: JSON.stringify(weekly) });
    await instance.adapter.sendTurn({ threadId: "t-weekly", text: "Hey talk to @Tango" });
    await recorder.until((event) => event.type === "turn.completed");
    const errors = recorder.events.filter((event) => event.type === "runtime.error");
    expect(errors).toEqual([expect.objectContaining({ message: claudeLimitMessage({ window: "seven_day", resetsAt }), limitResetsAt: resetsAt * 1000 })]);
    expect((errors[0] as any).message).toMatch(/^This Claude account has reached its weekly limit, which resets .+\. Until then, /);
    expect(errors[0]).not.toHaveProperty("setup");
    expect(errors[0]).not.toHaveProperty("claudeUpdate");
    expect(recorder.events.some((event) => event.type === "item.completed" && event.itemType === "assistant_text")).toBe(false);
    expect(recorder.events.some((event) => event.type === "content.delta")).toBe(false);
    expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: false, stopReason: "quota" });
  });

  it("settles a turn whose model's extra-usage credits ran out as quota, without holding the engine", async () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 11 * 86_400;
    const credits = { status: "rejected", resetsAt, overageDisabledReason: "out_of_credits", isUsingOverage: false, errorCode: "credits_required" };
    await create("usage-limit", { FAKE_CLAUDE_RATE_LIMIT: JSON.stringify(credits) });
    await instance.adapter.sendTurn({ threadId: "t-credits", text: "continue" });
    await recorder.until((event) => event.type === "turn.completed");
    const errors = recorder.events.filter((event) => event.type === "runtime.error");
    expect(errors).toEqual([expect.objectContaining({ message: claudeLimitMessage({ window: null, resetsAt, credits: true }) })]);
    expect((errors[0] as any).message).toContain("those credits are used up");
    expect(errors[0]).not.toHaveProperty("limitResetsAt");
    expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: false, stopReason: "quota" });
  });

  it("names the weekly limit behind an older CLI's update request, and offers no update", async () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 86_400;
    await create("api-error", {
      FAKE_CLAUDE_API_ERROR: "API Error: 400 Claude Code 2.1.272 does not support this model; version 2.1.280 or newer is required. Run 'claude update'.",
      FAKE_CLAUDE_RATE_LIMIT: JSON.stringify({ status: "rejected", resetsAt, rateLimitType: "seven_day", isUsingOverage: false }),
    });
    await instance.adapter.sendTurn({ threadId: "t-weekly-old-cli", text: "hi" });
    await recorder.until((event) => event.type === "turn.completed");
    expect(recorder.events.filter((event) => event.type === "runtime.error")).toEqual([
      expect.objectContaining({ message: claudeLimitMessage({ window: "seven_day", resetsAt }) }),
    ]);
    expect(recorder.events.some((event) => event.type === "runtime.error" && (event.claudeUpdate || event.setup))).toBe(false);
    expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: false, stopReason: "quota" });
  });

  it("still offers the update to an account near, not past, its limit", async () => {
    const message = "API Error: 400 Claude Code 2.1.268 does not support this model; version 2.1.280 or newer is required. Run 'claude update'.";
    await create("api-error", {
      FAKE_CLAUDE_API_ERROR: message,
      FAKE_CLAUDE_RATE_LIMIT: JSON.stringify({ status: "allowed_warning", resetsAt: Math.floor(Date.now() / 1000) + 86_400, rateLimitType: "seven_day", utilization: 0.97 }),
    });
    await instance.adapter.sendTurn({ threadId: "t-near-limit", text: "hi" });
    await recorder.until((event) => event.type === "turn.completed");
    expect(recorder.events.filter((event) => event.type === "runtime.error")).toEqual([
      expect.objectContaining({ message, setup: true, claudeUpdate: true }),
    ]);
    expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: false, stopReason: "update_required" });
  });

  it.each([
    // 2.1.295 on Cloud: no terminal_reason, so the result's only stop token is its synthetic message's "stop_sequence"
    [{ FAKE_CLAUDE_API_ERROR: "Credit balance is too low", FAKE_CLAUDE_API_ERROR_KIND: "billing_error", FAKE_CLAUDE_API_ERROR_STATUS: "402", FAKE_CLAUDE_NO_TERMINAL_REASON: "1" },
      'Your Claude account is out of credits (Claude says: "Credit balance is too low"). Add credits with Claude, then run it again.', "stop_sequence"],
    [{ FAKE_CLAUDE_API_ERROR: "API Error: Repeated 529 Overloaded errors. The API is at capacity — this is usually temporary. Try again in a moment.", FAKE_CLAUDE_API_ERROR_KIND: "overloaded" },
      'Claude is overloaded right now (Claude says: "Repeated 529 Overloaded errors"). This is usually temporary, so try again in a few minutes.', "api_error"],
    [{ FAKE_CLAUDE_API_ERROR: "There's an issue with the selected model (claude-fixture). It may not exist or you may not have access to it.", FAKE_CLAUDE_API_ERROR_KIND: "model_not_found", FAKE_CLAUDE_NO_TERMINAL_REASON: "1" },
      "There's an issue with the selected model (claude-fixture). It may not exist or you may not have access to it.", "stop_sequence"],
  ])("shows an api-error frame as one plain error row in Claude's real cause, never a reply or a bare stop token (%#)", async (environment, message, stopReason) => {
    await create("api-error", environment);
    await instance.adapter.sendTurn({ threadId: "t-api-error-words", text: "hi" });
    await recorder.until((event) => event.type === "turn.completed");
    expect(recorder.events.filter((event) => event.type === "runtime.error")).toEqual([expect.objectContaining({ message })]);
    expect(recorder.events.filter((event) => event.type === "runtime.error")[0]).not.toHaveProperty("setup");
    expect(recorder.events.some((event) => event.type === "item.completed" && event.itemType === "assistant_text")).toBe(false);
    expect(recorder.events.some((event) => event.type === "content.delta")).toBe(false);
    expect(recorder.events.some((event) => event.type === "thread.token-usage.updated" && event.contextTokens === 0)).toBe(false);
    expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: false, stopReason });
  });

  it("retires an outdated child before retry while preserving a healthy pooled session", async () => {
    await create(undefined, {
      FAKE_CLAUDE_API_ERROR: "Claude Code 2.1.268 does not support this model; version 2.1.280 or newer is required.",
    });
    const healthyDump = join(scratch, "healthy-session.json");
    process.env.FAKE_CLAUDE_DUMP = healthyDump;
    const healthy = await instance.adapter.sendTurn({ threadId: "t-update-healthy", text: "keep this session" });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === healthy.turnId);
    const healthyPid = dumpedPid(healthyDump);

    process.env.FAKE_CLAUDE_MODE = "api-error";
    const outdatedDump = join(scratch, "outdated-session.json");
    process.env.FAKE_CLAUDE_DUMP = outdatedDump;
    const resumeCursor = "fixture-update-session";
    const outdated = await instance.adapter.sendTurn({ threadId: "t-update-retry", text: "try the model", resumeCursor });
    await expect(recorder.until((event) => event.type === "turn.completed" && event.turnId === outdated.turnId))
      .resolves.toMatchObject({ ok: false, stopReason: "update_required" });
    const outdatedPid = JSON.parse(readFileSync(outdatedDump, "utf8")).pid;

    process.env.FAKE_CLAUDE_MODE = "happy";
    const retryDump = join(scratch, "updated-session.json");
    process.env.FAKE_CLAUDE_DUMP = retryDump;
    const retry = await instance.adapter.sendTurn({ threadId: "t-update-retry", text: "retry explicitly", resumeCursor });
    await expect(recorder.until((event) => event.type === "turn.completed" && event.turnId === retry.turnId))
      .resolves.toMatchObject({ ok: true });
    const replacement = JSON.parse(readFileSync(retryDump, "utf8"));
    expect(replacement.pid).not.toBe(outdatedPid);
    expect(replacement.argv).toContain("--resume");
    expect(replacement.argv).toContain(resumeCursor);

    const continued = await instance.adapter.sendTurn({ threadId: "t-update-healthy", text: "continue normally" });
    await expect(recorder.until((event) => event.type === "turn.completed" && event.turnId === continued.turnId))
      .resolves.toMatchObject({ ok: true });
    expect(dumpedPid(healthyDump)).toBe(healthyPid);
    expect(JSON.parse(readFileSync(retryDump, "utf8")).pid).toBe(replacement.pid);
    expect(recorder.events.some((event) => event.type === "turn.retrying")).toBe(false);
  });

  it("runs a guest's turn on a Cloud home with no command-running tool and no read outside its folder", async () => {
    await create(undefined, { FAKE_CLAUDE_VERSION: "2.1.284" });
    expect(instance.adapter.capabilities.guestTurns).toBe("confined");
    // Inside the scratch folder: its removal waits for the CLI to let go of it (Windows).
    const folder = mkdtempSync(join(scratch, "guest-folder-"));
    writeFileSync(join(folder, ".mcp.json"), JSON.stringify({ mcpServers: { planted: { command: "sh", args: ["-c", "id"] } } }));
    const dump = join(scratch, "dump-guest.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    await instance.adapter.sendTurn({ threadId: "t-guest", text: "hello", approvalMode: "ask", guestConfined: true, cwd: folder,
      integrations: { browser: { command: process.execPath, args: ["fixture-browser"], env: {} } } });
    await recorder.until((e) => e.type === "turn.completed");
    const seen = JSON.parse(readFileSync(dump, "utf8")) as { argv: string[]; settings: any; mcpConfig: any };
    const after = (flag: string) => seen.argv[seen.argv.indexOf(flag) + 1];
    expect(seen.argv).toContain("--restricted");
    expect(after("--tools")).toBe("Read,Grep,Glob,Edit,Write,WebSearch");
    expect(after("--permission-mode")).toBe("default");
    expect(seen.settings.permissions).toMatchObject({ blockReadsOutsideWorkingDirectories: true });
    expect(seen.settings.permissions.deny).toEqual(expect.arrayContaining(["Bash", "PowerShell", "WebFetch"]));
    expect(Object.keys(seen.mcpConfig.mcpServers)).not.toContain("planted");
    expect(after("--allowedTools").split(",")).not.toContain("mcp__browser");
    expect(recorder.events.find((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
  });

  it("stops a guest's turn when the CLI kept a shell, and refuses one too old to confine it", async () => {
    await create(undefined, { FAKE_CLAUDE_VERSION: "2.1.284", FAKE_CLAUDE_KEEP_BASH: "1" });
    await instance.adapter.sendTurn({ threadId: "t-kept", text: "hello", approvalMode: "ask", guestConfined: true, confinedWhy: "This routine was made before this update." });
    await recorder.until((e) => e.type === "turn.completed");
    expect(JSON.stringify(recorder.events)).toContain("kept its shell, so it can't run this turn. Update Claude Code. This routine was made before this update.");
    expect(recorder.events.find((e) => e.type === "turn.completed")).toMatchObject({ ok: false });
    await create(undefined, { FAKE_CLAUDE_VERSION: "2.1.250" });
    const refused = await instance.adapter.sendTurn({ threadId: "t-old", text: "hello", approvalMode: "ask", guestConfined: true })
      .then(() => recorder.until((e) => e.type === "turn.completed").then((event) => JSON.stringify(event) + JSON.stringify(recorder.events)), (error: unknown) => String(error));
    expect(refused).toContain("too old to run this turn without a shell");
  });

  it("keeps a workspace Anthropic key set on purpose while still dropping one from the parent env", async () => {
    await create(undefined, { ANTHROPIC_API_KEY: "sk-ant-workspace-fixture" });
    const dump = join(scratch, "dump-workspace-key.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    process.env.ANTHROPIC_API_KEY = "sk-should-not-leak";
    await instance.adapter.sendTurn({ threadId: "t-workspace-key", text: "hello" });
    await recorder.until((e) => e.type === "turn.completed");
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.env.ANTHROPIC_API_KEY).toBe("sk-ant-workspace-fixture");
  });

  it("hands a hosted tenant's CLI the hosted model token but none of the operator's control-plane secrets", async () => {
    await create(undefined, { ANTHROPIC_API_KEY: "omb_workspace_fixture", ANTHROPIC_AUTH_TOKEN: "omb_workspace_fixture" });
    const dump = join(scratch, "dump-hosted.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    Object.assign(process.env, CONTROL_PLANE_FIXTURE);
    await instance.adapter.sendTurn({ threadId: "t-hosted-env", text: "hello" });
    await recorder.until((e) => e.type === "turn.completed");
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.env.ANTHROPIC_API_KEY).toBe("omb_workspace_fixture");
    expect(seen.env.ANTHROPIC_AUTH_TOKEN).toBe("omb_workspace_fixture");
    for (const name of Object.keys(CONTROL_PLANE_FIXTURE)) expect(seen.env[name]).toBeUndefined();
  });

  it("keeps user and system prompts off argv and strips identity env vars", async () => {
    await create();
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    process.env.ANTHROPIC_API_KEY = "sk-should-not-leak";
    process.env.XAI_API_KEY = "xai-should-not-leak";
    process.env.BOX_TOKEN = "box-should-not-leak";
    process.env.OMB_TTS_KEY = "tts-should-not-leak";

    await instance.adapter.sendTurn({ threadId: "t-hygiene", text: "the secret prompt", system: "You are Testy." });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(JSON.stringify(seen.argv)).not.toContain("the secret prompt");
    expect(JSON.stringify(seen.argv)).not.toContain("You are Testy.");
    expect(seen.prompt).toMatchObject({ type: "user", message: { role: "user", content: "the secret prompt" } });
    expect(seen.argv).toContain("--append-system-prompt-file");
    expect(seen.systemPrompt).toBe("You are Testy.");
    expect(existsSync(seen.argv[seen.argv.indexOf("--append-system-prompt-file") + 1])).toBe(false);
    expect(seen.argv).toContain("--session-id");
    expect(seen.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(seen.env.CLAUDECODE).toBeUndefined();
    expect(seen.env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(seen.env.XAI_API_KEY).toBeUndefined();
    expect(seen.env.BOX_TOKEN).toBeUndefined();
    expect(seen.env.OMB_TTS_KEY).toBeUndefined();
  });

  it("per-bot Ask restores the broker on a legacy bypass instance", async () => {
    await create(undefined, {}, { permissionMode: "bypassPermissions" });
    const dump = join(scratch, "ask-overrides-bypass.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-ask-overrides-bypass",
      text: "go",
      approvalMode: "ask",
    });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv).toContain("--permission-mode");
    expect(seen.argv[seen.argv.indexOf("--permission-mode") + 1]).toBe("default");
    expect(seen.argv).toContain("--permission-prompt-tool");
  });

  it.each(["claude-sonnet-5", "claude-fable-5"])("reapplies Full, Auto, and Ask on the same resumed %s conversation", async (model) => {
    await create(undefined, {}, { permissionMode: "bypassPermissions" });
    const dump = join(scratch, "approval-transitions.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    for (const [approvalMode, nativeMode] of [["full", "bypassPermissions"], ["auto", "auto"], ["edits", "acceptEdits"], ["ask", "default"]] as const) {
      const { turnId } = await instance.adapter.sendTurn({
        threadId: "t-mode-transitions",
        text: "hello",
        model,
        approvalMode,
        resumeCursor: "11111111-1111-4111-8111-111111111111",
      });
      await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
      const seen = JSON.parse(readFileSync(dump, "utf8"));
      expect(seen.argv[seen.argv.indexOf("--model") + 1]).toBe(model);
      expect(seen.argv[seen.argv.indexOf("--permission-mode") + 1]).toBe(nativeMode);
      expect(seen.argv.includes("--permission-prompt-tool")).toBe(approvalMode !== "full");
      expect(seen.argv).toContain("--resume");
    }
  });

  it("keeps questions answerable in per-bot Full access", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: "t-full-question", text: "go", approvalMode: "full" });
    const conn = await connectSocket(permissionSocketPath("t-full-question"));
    try {
      conn.write(JSON.stringify({ t: "ask", kind: "question", id: "full-question", tool: "ask_user", input: { question: "Which account?" } }) + "\n");
      const opened = await recorder.until((e) => e.type === "request.opened");
      expect(opened).toMatchObject({ requestType: "question" });
      expect(await instance.adapter.respondToRequest("t-full-question", (opened as { requestId: string }).requestId, { behavior: "answer", message: "Work" })).toBe("answered");
    } finally {
      conn.destroy();
    }
  });

  it("flattens ask_user choices a model sends as {label, description} rows", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: "t-object-choices", text: "go" });
    const conn = await connectSocket(permissionSocketPath("t-object-choices"));
    try {
      conn.write(JSON.stringify({
        t: "ask",
        kind: "question",
        id: "object-choices",
        tool: "ask_user",
        input: {
          question: "Email the Persun COGS breakdown with PDF template now?",
          choices: [
            { label: "Yes, email it now", description: "Generate the PDF and send it." },
            { label: "No, skip the email", description: "Leave it as file-only." },
          ],
        },
      }) + "\n");
      const opened = await recorder.until((e) => e.type === "request.opened") as { requestId: string; choices?: unknown };
      expect(opened.choices).toEqual(["Yes, email it now", "No, skip the email"]);
      expect(await instance.adapter.respondToRequest("t-object-choices", opened.requestId, { behavior: "answer", message: "No, skip the email" })).toBe("answered");
    } finally {
      conn.destroy();
    }
  });

  it("draws a multiSelect ask_user as a checkbox question card", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: "t-multi-ask", text: "go", approvalMode: "full" });
    const conn = await connectSocket(permissionSocketPath("t-multi-ask"));
    try {
      const questions = [{ question: "Which fruits?", multiSelect: true, options: [{ label: "Apple" }, { label: "Cherry" }] }];
      conn.write(JSON.stringify({
        t: "ask", kind: "question", id: "multi-ask", tool: "ask_user",
        input: { question: "Which fruits?", choices: ["Apple", "Cherry"], questions },
      }) + "\n");
      const opened = await recorder.until((e) => e.type === "request.opened") as { requestId: string; questions?: unknown; choices?: unknown };
      expect(opened.questions).toEqual(questions);
      expect(opened.choices).toBeUndefined();
      expect(await instance.adapter.respondToRequest("t-multi-ask", opened.requestId, { behavior: "answer", message: "Apple, Cherry" })).toBe("answered");
    } finally {
      conn.destroy();
    }
  });

  it("turns Claude's own AskUserQuestion into a question card, not an approval", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: "t-structured-ask", text: "go" });
    const conn = await connectSocket(permissionSocketPath("t-structured-ask"));
    try {
      conn.write(JSON.stringify({
        t: "ask",
        kind: "question",
        id: "structured-ask",
        tool: "AskUserQuestion",
        input: {
          questions: [{
            question: "Which model should this bot run on?",
            header: "Model",
            options: [{ label: "Opus 5", description: "What it had before." }, { label: "Sonnet 5" }],
          }],
        },
      }) + "\n");
      const opened = await recorder.until((e) => e.type === "request.opened") as {
        requestType: string;
        summary: string;
        requestId: string;
        questions?: { question: string; header?: string; options: { label: string }[] }[];
        choices?: string[];
      };
      expect(opened.requestType).toBe("question");
      expect(opened.summary).toBe("Which model should this bot run on?");
      expect(opened.questions?.[0]).toMatchObject({ question: "Which model should this bot run on?", header: "Model" });
      expect(opened.choices).toEqual(["Opus 5", "Sonnet 5"]);
      expect(
        await instance.adapter.respondToRequest("t-structured-ask", opened.requestId, {
          behavior: "answer",
          message: "The user answered your questions.\n\nQ: Which model should this bot run on?\nA: Opus 5",
        }),
      ).toBe("answered");
    } finally {
      conn.destroy();
    }
  });

  it("never lets a PERMISSION take its buttons or its summary from a nested questions[]", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: "t-perm-lbl", text: "go" });
    await recorder.until((e) => e.type === "session.started");

    const conn = await connectSocket(permissionSocketPath("t-perm-lbl"));
    conn.write(
      JSON.stringify({
        t: "ask",
        id: "ask-lbl",
        tool: "mcp__x__wire",
        input: {
          questions: [{ question: "Send the payroll export?", options: [{ label: "Yes" }, { label: "No" }] }],
          to: "acct-9",
          amount: 4200,
        },
      }) + "\n",
    );

    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({ requestType: "permission" });
    expect((opened as { choices?: string[] }).choices).toBeUndefined();
    expect((opened as { summary: string }).summary).toContain("acct-9");
    expect((opened as { summary: string }).summary).toContain("4200");

    conn.end();
    await instance.adapter.interruptTurn("t-perm-lbl");
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("still shows an unknown permission tool's raw arguments — they are the whole decision", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: "t-perm-raw", text: "go" });
    await recorder.until((e) => e.type === "session.started");

    const conn = await connectSocket(permissionSocketPath("t-perm-raw"));
    conn.write(
      JSON.stringify({ t: "ask", id: "ask-raw", tool: "mcp__x__wire", input: { amount: 4200, to: "acct-9" } }) + "\n",
    );

    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({ requestType: "permission", summary: '{"amount":4200,"to":"acct-9"}' });
    expect((opened as { choices?: string[] }).choices).toBeUndefined();

    conn.end();
    await instance.adapter.interruptTurn("t-perm-raw");
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("answers to unknown or already-resolved asks resolve `unavailable` — typed, never a throw", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: "t-perm-2", text: "go" });
    await expect(instance.adapter.respondToRequest("t-perm-2", "never-asked", { behavior: "allow" })).resolves.toBe("unavailable");
    await expect(instance.adapter.respondToRequest("no-such-thread", "x", { behavior: "deny" })).resolves.toBe("unavailable");
    await instance.adapter.interruptTurn("t-perm-2");
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("sends attached images as native blocks before text without logging their bytes", async () => {
    await create();
    const dump = join(scratch, "dump-images.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 5, 6, 7]);
    const pngPath = join(scratch, "one.png");
    const jpegPath = join(scratch, "two.jpg");
    writeFileSync(pngPath, png);
    writeFileSync(jpegPath, jpeg);

    await instance.adapter.sendTurn({
      threadId: "t-native-images",
      text: "describe both",
      images: [
        { path: pngPath, mime: "image/png", bytes: png.length },
        { path: jpegPath, mime: "image/jpeg", bytes: jpeg.length },
      ],
    });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.prompt).toEqual({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: png.toString("base64") },
          },
          {
            type: "image",
            source: { type: "base64", media_type: "image/jpeg", data: jpeg.toString("base64") },
          },
          { type: "text", text: "describe both" },
        ],
      },
    });

    const nativeLog = readFileSync(join(NATIVE_DIR, "t-native-images.ndjson"), "utf8");
    expect(nativeLog).not.toContain(png.toString("base64"));
    expect(nativeLog).not.toContain(jpeg.toString("base64"));
    const outgoing = nativeLog
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((row) => row.dir === "out" && row.source === "claude.sdk.message")
      .at(-1);
    expect(outgoing.msg.message.content).toEqual([
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "[image data: 12 base64 chars]" },
      },
      {
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: "[image data: 12 base64 chars]" },
      },
      { type: "text", text: "describe both" },
    ]);
  });

  it("launches with a Windows-sized system prompt without putting it on argv", async () => {
    await create();
    const dump = join(scratch, "dump-long-system.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    const system = `room instructions\n${"context-0123456789".repeat(8_000)}`;

    await instance.adapter.sendTurn({ threadId: "t-long-system", text: "review this", system });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.systemPrompt).toBe(system);
    expect(JSON.stringify(seen.argv)).not.toContain("room instructions");
    expect(JSON.stringify(seen.argv).length).toBeLessThan(8_000);
  });

  it("uses instance credentials when launching an injected local model", async () => {
    await create(undefined, { UNSLOTH_STUDIO_AUTH_TOKEN: "unsloth-secret" });
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-local-model",
      text: "hi",
      model: "unsloth::local-model",
    });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv[seen.argv.indexOf("--model") + 1]).toBe("local-model");
    expect(seen.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8888");
    expect(seen.env.ANTHROPIC_AUTH_TOKEN).toBe("unsloth-secret");
  });

  it("injects a leftover API id when a local host is serving that model", async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      if (String(url).includes(":8888")) {
        return new Response(JSON.stringify({ data: [{ id: "orcarouter/Qwen3.8-27B-Uncensored-GGUF" }] }), { status: 200 });
      }
      return new Response("nope", { status: 500 });
    }) as typeof fetch;
    try {
      await create(undefined, { UNSLOTH_STUDIO_AUTH_TOKEN: "unsloth-secret" });
      const dump = join(scratch, "dump-leftover.json");
      process.env.FAKE_CLAUDE_DUMP = dump;

      await instance.adapter.sendTurn({
        threadId: "t-leftover-local",
        text: "hi",
        model: "orcarouter/Qwen3.8-27B-Uncensored-GGUF",
      });
      await recorder.until((e) => e.type === "turn.completed");

      const seen = JSON.parse(readFileSync(dump, "utf8"));
      expect(seen.argv[seen.argv.indexOf("--model") + 1]).toBe("orcarouter/Qwen3.8-27B-Uncensored-GGUF");
      expect(seen.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8888");
      expect(seen.env.ANTHROPIC_AUTH_TOKEN).toBe("unsloth-secret");
      expect(seen.env.ANTHROPIC_API_KEY).toBe("unsloth-secret");
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it.each(["ask", "auto"] as const)("pre-allows the agents comms proxy while retaining native %s approval", async (approvalMode) => {
    await create();
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-agents",
      text: "hi",
      approvalMode,
      integrations: {
        agents: {
          command: process.execPath,
          args: ["/fake/agents-proxy.js"],
          env: { OMB_HARNESS_URL: "http://127.0.0.1:1", OMB_BOT_ID: "b1", OMB_COMMS_TOKEN: "tok", OMB_TURN_DEPTH: "0" },
        },
      },
    });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.mcpConfig.mcpServers.agents).toMatchObject({
      alwaysLoad: true,
      args: ["/fake/agents-proxy.js"],
      env: { OMB_BOT_ID: "b1", OMB_COMMS_TOKEN: "tok" },
    });
    expect(JSON.stringify(seen.argv)).not.toContain("tok");
    const allowed = seen.argv[seen.argv.indexOf("--allowedTools") + 1];
    expect(allowed).toContain("mcp__agents");
    expect(seen.argv[seen.argv.indexOf("--permission-mode") + 1]).toBe(approvalMode === "auto" ? "auto" : "default");
    expect(seen.argv).toContain("--permission-prompt-tool");
    expect(seen.mcpConfig.mcpServers.ogb.alwaysLoad).toBe(true);
  });

  it("rewrites the hook token file only when the bearer changes", async () => {
    await create();
    const threadId = "t-hook-token";
    const file = hookTokenFile(threadId, "b-hook");
    const turn = async (token: string) => {
      const { turnId } = await instance.adapter.sendTurn({
        threadId, botId: "b-hook", text: "hi",
        integrations: { hooks: { url: "http://127.0.0.1:1/hooks", token } },
      });
      await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    };

    await turn("bearer-one");
    const saved = statSync(file).ino;
    await turn("bearer-one");
    expect(statSync(file).ino).toBe(saved);
    expect(readFileSync(file, "utf8")).toBe("bearer-one");

    await turn("bearer-two");
    expect(readFileSync(file, "utf8")).toBe("bearer-two");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("keeps the session alive when only the volatile half of the prompt changed", async () => {
    await create();
    const dump = join(scratch, "volatile.json");
    const prompts = join(scratch, "volatile-prompts.jsonl");
    process.env.FAKE_CLAUDE_DUMP = dump;
    process.env.FAKE_CLAUDE_PROMPTS = prompts;

    await instance.adapter.sendTurn({
      threadId: "t-volatile",
      text: "one",
      system: "You are Testy.\n\nYour memory:\nlikes tea",
      systemStable: "You are Testy.",
      systemVolatile: "Your memory:\nlikes tea",
    });
    await recorder.until((e) => e.type === "turn.completed");
    const firstPid = JSON.parse(readFileSync(dump, "utf8")).pid;

    recorder.events.length = 0;
    await instance.adapter.sendTurn({
      threadId: "t-volatile",
      text: "two",
      system: "You are Testy.\n\nYour memory:\nlikes tea, dislikes cloud kitchens",
      systemStable: "You are Testy.",
      systemVolatile: "Your memory:\nlikes tea, dislikes cloud kitchens",
    });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.pid).toBe(firstPid);
    const sent = readFileSync(prompts, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(sent).toHaveLength(2);
    expect(sent[0].message.content).toContain("likes tea");
    expect(sent[0].message.content.endsWith("one")).toBe(true);
    expect(sent[1].message.content).toContain("dislikes cloud kitchens");
    expect(sent[1].message.content.endsWith("two")).toBe(true);
  });

  it("redelivers unchanged mention context on every tagged turn", async () => {
    await create();
    const dump = join(scratch, "mention.json");
    const prompts = join(scratch, "mention-prompts.jsonl");
    process.env.FAKE_CLAUDE_DUMP = dump;
    process.env.FAKE_CLAUDE_PROMPTS = prompts;

    const send = async (text: string, mentionTurn?: boolean) => {
      await instance.adapter.sendTurn({
        threadId: "t-mention",
        text,
        system: "You are Testy.\n\nTagged: @Testy",
        systemStable: "You are Testy.",
        systemVolatile: "Tagged: @Testy",
        ...(mentionTurn ? { mentionTurn: true } : {}),
      });
      await recorder.until((e) => e.type === "turn.completed");
    };
    await send("one");
    recorder.events.length = 0;
    await send("two", true);

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    const sent = readFileSync(prompts, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(sent).toHaveLength(2);
    expect(sent[0].message.content).toContain("Tagged: @Testy");
    expect(sent[0].message.content.endsWith("one")).toBe(true);
    expect(sent[1].message.content).toContain("Tagged: @Testy");
    expect(sent[1].message.content.endsWith("two")).toBe(true);
    expect(seen.systemPrompt).toContain("Tagged: @Testy");
  });

  it("relaunches a resumed session with the same prompt file and the current volatile half in its first message", async () => {
    await create();
    const dump = join(scratch, "relaunch.json");
    const prompts = join(scratch, "relaunch-prompts.jsonl");
    process.env.FAKE_CLAUDE_DUMP = dump;
    process.env.FAKE_CLAUDE_PROMPTS = prompts;
    const halves = (memory: string) => ({ system: `You are Testy.\n\nYour memory:\n${memory}`, systemStable: "You are Testy.", systemVolatile: `Your memory:\n${memory}` });

    await instance.adapter.sendTurn({ threadId: "t-relaunch", text: "one", ...halves("likes tea") });
    await recorder.until((e) => e.type === "turn.completed");
    const first = JSON.parse(readFileSync(dump, "utf8"));
    const announced = (recorder.events.find((e) => e.type === "session.started") as { sessionId: string }).sessionId;

    recorder.events.length = 0;
    // A new spawn contract closes the warm process; the next one resumes the conversation.
    await instance.adapter.sendTurn({ threadId: "t-relaunch", text: "two", effort: "high", resumeCursor: announced, ...halves("likes tea, dislikes cloud kitchens") });
    await recorder.until((e) => e.type === "turn.completed");

    const second = JSON.parse(readFileSync(dump, "utf8"));
    expect(second.pid).not.toBe(first.pid);
    expect(second.argv[second.argv.indexOf("--resume") + 1]).toBe(announced);
    expect(first.systemPromptFile).toBe("You are Testy.");
    expect(second.systemPromptFile).toBe(first.systemPromptFile);
    const sent = readFileSync(prompts, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(sent[1].message.content).toMatch(/^<system-reminder>\nThis part of your instructions changes from turn to turn/);
    expect(sent[1].message.content).toContain("likes tea, dislikes cloud kitchens");
    expect(sent[1].message.content.endsWith("two")).toBe(true);
  });

  it("re-sends an unchanged volatile half after the CLI compacts the conversation", async () => {
    await create();
    const prompts = join(scratch, "compact-prompts.jsonl");
    process.env.FAKE_CLAUDE_PROMPTS = prompts;
    process.env.FAKE_CLAUDE_COMPACT = "1";
    try {
      for (const text of ["one", "two", "three"]) {
        recorder.events.length = 0;
        await instance.adapter.sendTurn({
          threadId: "t-compact", text,
          system: "You are Testy.\n\nYour memory:\nlikes tea", systemStable: "You are Testy.", systemVolatile: "Your memory:\nlikes tea",
        });
        await recorder.until((e) => e.type === "turn.completed");
      }
    } finally {
      delete process.env.FAKE_CLAUDE_COMPACT;
    }
    const sent = readFileSync(prompts, "utf8").trim().split("\n").map((line) => JSON.parse(line).message.content);
    expect(sent).toHaveLength(3);
    expect(sent[0]).toContain("likes tea");
    // The second turn compacts; until then the conversation still holds the launch copy.
    expect(sent[1]).toBe("two");
    expect(sent[2]).toContain("likes tea");
    expect(sent[2].endsWith("three")).toBe(true);
  });

  it("still relaunches when the stable half of the prompt changes", async () => {
    await create();
    const dump = join(scratch, "stable.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-stable", text: "one", system: "You are Testy.", systemStable: "You are Testy." });
    await recorder.until((e) => e.type === "turn.completed");
    const firstPid = JSON.parse(readFileSync(dump, "utf8")).pid;

    recorder.events.length = 0;
    await instance.adapter.sendTurn({ threadId: "t-stable", text: "two", system: "You are Grumpy.", systemStable: "You are Grumpy." });
    await recorder.until((e) => e.type === "turn.completed");

    expect(JSON.parse(readFileSync(dump, "utf8")).pid).not.toBe(firstPid);
  });

  it("launches a new session with only the stable half in the system prompt file, the volatile half in its first message", async () => {
    await create();
    const dump = join(scratch, "volatile-spawn.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-volatile-spawn",
      text: "hi",
      system: "You are Testy.\n\nYour memory:\nlikes tea",
      systemStable: "You are Testy.",
      systemVolatile: "Your memory:\nlikes tea",
    });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    // the fake folds the first message's volatile note into systemPrompt: the file itself is the stable half
    expect(seen.systemPrompt).toBe("You are Testy.\n\nYour memory:\nlikes tea");
    const content = seen.prompt.message.content;
    const text = typeof content === "string" ? content : content.map((c: any) => c.text ?? "").join("");
    expect(text).toContain("<system-reminder>");
    expect(text).toContain("likes tea");
    expect(text.endsWith("hi")).toBe(true);
  });

  it("refreshes a resumed session's recorded prompt on every turn when the CLI supports it", async () => {
    await create(undefined, { FAKE_CLAUDE_DUMP: join(scratch, "coordination-snapshot.json"), FAKE_CLAUDE_VERSION: "2.1.267" });
    // After an Engines snapshot, the cached version is what admits the flag.
    await instance.snapshot();
    await instance.adapter.sendTurn({
      threadId: "t-coordinated-resume",
      text: "Addressed teammate request 2. Add the new header row.",
      resumeCursor: "existing-claude-session",
      system: "Stable coordination policy, without the earlier assignment.",
    });
    await recorder.until((e) => e.type === "turn.completed");
    const seen = JSON.parse(readFileSync(join(scratch, "coordination-snapshot.json"), "utf8"));
    expect(seen.argv[seen.argv.indexOf("--system-prompt-snapshot") + 1]).toBe("off");
    expect(seen.argv[seen.argv.indexOf("--resume") + 1]).toBe("existing-claude-session");
    expect(seen.prompt.message.content).toContain("Add the new header row.");
  });

  it("refreshes the recorded prompt on a plain turn too: no caller has to ask", async () => {
    const dump = join(scratch, "plain-snapshot.json");
    await create(undefined, { FAKE_CLAUDE_DUMP: dump, FAKE_CLAUDE_VERSION: "2.1.267" });
    await instance.adapter.sendTurn({ threadId: "t-plain-snapshot", text: "hi", system: "You are Testy." });
    await recorder.until((e) => e.type === "turn.completed");
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv[seen.argv.indexOf("--system-prompt-snapshot") + 1]).toBe("off");
  });

  it("keeps resumed turns working on a CLI without the snapshot flag", async () => {
    const dump = join(scratch, "coordination-no-snapshot.json");
    await create(undefined, { FAKE_CLAUDE_DUMP: dump, FAKE_CLAUDE_VERSION: "2.1.232" });
    await instance.snapshot();
    await instance.adapter.sendTurn({
      threadId: "t-coordinated-old-cli",
      text: "Addressed teammate request 2. Add the new header row.",
      resumeCursor: "existing-claude-session",
      system: "Stable coordination policy, without the earlier assignment.",
    });
    await recorder.until((e) => e.type === "turn.completed");
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv).not.toContain("--system-prompt-snapshot");
    expect(seen.prompt.message.content).toContain("Add the new header row.");
  });

  it("replaces the previous computer prompt when a normal conversation changes its place", async () => {
    const dump = join(scratch, "surface-snapshot.json");
    await create(undefined, { FAKE_CLAUDE_DUMP: dump, FAKE_CLAUDE_VERSION: "2.1.267" });
    await instance.adapter.sendTurn({
      threadId: "t-surface-resume", text: "Open the test page.",
      resumeCursor: "previous-host-computer-session",
      system: "Everything you do on screen happens in the built-in browser tab; no host computer tools are mounted.",
      integrations: { browser: { command: process.execPath, args: ["fixture-browser"], env: {} } },
    });
    await recorder.until((event) => event.type === "turn.completed");
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv[seen.argv.indexOf("--system-prompt-snapshot") + 1]).toBe("off");
    expect(seen.argv[seen.argv.indexOf("--resume") + 1]).toBe("previous-host-computer-session");
    expect(seen.systemPrompt).toContain("no host computer tools are mounted");
    expect(seen.mcpConfig.mcpServers.browser).toBeTruthy();
    expect(seen.mcpConfig.mcpServers.computer).toBeUndefined();
  });

  it.each([["2.1.232", false], ["2.1.267", true]] as const)(
    "probes Claude %s before the first turn without an Engines snapshot",
    async (version, supportsSnapshot) => {
      const dump = join(scratch, `coordination-first-turn-${version}.json`);
      await create(undefined, { FAKE_CLAUDE_DUMP: dump, FAKE_CLAUDE_VERSION: version });
      await instance.adapter.sendTurn({
        threadId: `t-coordinated-first-turn-${version}`,
        text: "Addressed teammate request 2. Add the new header row.",
        resumeCursor: "existing-claude-session",
        system: "Stable coordination policy, without the earlier assignment.",
      });
      await recorder.until((e) => e.type === "turn.completed");
      const seen = JSON.parse(readFileSync(dump, "utf8"));
      expect(seen.argv.includes("--system-prompt-snapshot")).toBe(supportsSnapshot);
      if (supportsSnapshot) expect(seen.argv[seen.argv.indexOf("--system-prompt-snapshot") + 1]).toBe("off");
      expect(seen.prompt.message.content).toContain("Add the new header row.");
    },
  );

  it("compacts the CLI session at a window the harness picks", async () => {
    await create();
    await instance.snapshot();
    const dump = join(scratch, "compact.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-compact", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv[seen.argv.indexOf("--autocompact") + 1]).toBe("200000");
  });

  it("clamps a configured compaction window into the range the CLI accepts", () => {
    expect(autoCompactWindow({ OMB_CLAUDE_AUTOCOMPACT: "50000" })).toBe("100000");
    expect(autoCompactWindow({ OMB_CLAUDE_AUTOCOMPACT: "9000000" })).toBe("1000000");
    expect(autoCompactWindow({ OMB_CLAUDE_AUTOCOMPACT: "150000" })).toBe("150000");
    expect(autoCompactWindow({ OMB_CLAUDE_AUTOCOMPACT: "nonsense" })).toBe("200000");
    expect(autoCompactWindow({})).toBe("200000");
    expect(autoCompactWindow({ OMB_CLAUDE_AUTOCOMPACT: "auto" })).toBe("auto");
    expect(autoCompactWindow({ OMB_CLAUDE_AUTOCOMPACT: "off" })).toBe(null);
  });

  it("passes no compaction window when it is turned off", async () => {
    const dump = join(scratch, "compact-off.json");
    await create(undefined, { FAKE_CLAUDE_DUMP: dump, OMB_CLAUDE_AUTOCOMPACT: "off" });
    await instance.adapter.sendTurn({ threadId: "t-compact-off", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");
    expect(JSON.parse(readFileSync(dump, "utf8")).argv).not.toContain("--autocompact");
  });

  it("launches isolated from the machine's own Claude Code configuration", async () => {
    await create();
    const dump = join(scratch, "isolation.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-isolate", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv).toContain("--strict-mcp-config");
    expect(seen.argv[seen.argv.indexOf("--setting-sources") + 1]).toBe("project");
    expect(seen.settings.claudeMdExcludes).toEqual([join(homedir(), ".claude", "CLAUDE.md")]);
  });

  it("inherits the machine's configuration again when the escape hatch is set", async () => {
    const dump = join(scratch, "inherit.json");
    await create(undefined, { FAKE_CLAUDE_DUMP: dump, OMB_CLAUDE_INHERIT_USER_CONFIG: "1" });

    await instance.adapter.sendTurn({ threadId: "t-inherit", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv).not.toContain("--strict-mcp-config");
    expect(seen.argv).not.toContain("--setting-sources");
    expect(seen.settings?.claudeMdExcludes).toBeUndefined();
  });

  it("loads the machine's own MCP servers when the turn asks, keeping the rest isolated", async () => {
    await create();
    const dump = join(scratch, "user-mcp.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-user-mcp", text: "hi", mcpFromUserConfig: true });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv).not.toContain("--strict-mcp-config");
    expect(seen.argv[seen.argv.indexOf("--setting-sources") + 1]).toBe("project");
  });

  it("adds the person's own skills folder when the turn asks, keeping everything else isolated", async () => {
    await create();
    const dump = join(scratch, "user-skills.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    const skills = join(scratch, "claude-user-skills");

    await instance.adapter.sendTurn({ threadId: "t-user-skills", text: "hi", userSkillsDir: skills });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv[seen.argv.indexOf("--add-dir") + 1]).toBe(skills);
    expect(seen.argv).toContain("--strict-mcp-config");
    expect(seen.argv[seen.argv.indexOf("--setting-sources") + 1]).toBe("project");
  });

  it("mounts a url server in the CLI's own shape, header values in the private file", async () => {
    await create();
    const dump = join(scratch, "remote-mcp.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-remote-mcp",
      text: "hi",
      integrations: { custom: {
        docs: { type: "http", url: "https://docs.example/mcp", headers: { Authorization: "Bearer tok-docs" } },
        legacy: { type: "sse", url: "https://old.example/sse", headers: {} },
      } },
    });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.mcpConfig.mcpServers.docs).toEqual({ type: "http", url: "https://docs.example/mcp", headers: { Authorization: "Bearer tok-docs" } });
    expect(seen.mcpConfig.mcpServers.legacy).toEqual({ type: "sse", url: "https://old.example/sse", headers: {} });
    expect(JSON.stringify(seen.mcpConfig)).not.toContain("mcp-remote-proxy");
    expect(JSON.stringify(seen.argv)).not.toContain("tok-docs");
  });

  // Claude Code advertises no MCP Apps UI extension and keeps tool results to itself, so only OMB's
  // remote proxy can observe a URL app server.
  it("mounts a url app server through the proxy and a url server without apps natively, unchanged", async () => {
    await create();
    const dump = join(scratch, "app-mcp.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    const docs = { type: "http" as const, url: "https://docs.example/mcp", headers: { Authorization: "Bearer tok-docs" } };
    const draw = { type: "http" as const, url: "https://mcp.excalidraw.com/mcp", headers: { Authorization: "Bearer tok-draw" } };
    const board = { command: "board-mcp", args: [], env: {} };
    const agents = { command: process.execPath, args: ["agents-proxy.js"], env: { OMB_HARNESS_URL: "http://127.0.0.1:8799", OMB_COMMS_TOKEN: "comms-fixture" } };
    await instance.adapter.sendTurn({
      threadId: "t-app-mcp", text: "hi",
      integrations: { agents, custom: { docs, draw, board }, mcpApps: { draw: { extension: true }, board: { extension: true } } },
    });
    await recorder.until((e) => e.type === "turn.completed");
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.mcpConfig.mcpServers.docs).toEqual(docs);
    const proxy = seen.mcpConfig.mcpServers.draw;
    expect(proxy.args[0]).toContain("mcp-remote-proxy");
    expect(JSON.parse(proxy.env.OMB_REMOTE_MCP_SERVER)).toEqual(draw);
    expect(JSON.parse(proxy.env.OMB_REMOTE_MCP_APPS)).toEqual({ server: "draw", harnessUrl: "http://127.0.0.1:8799", token: "comms-fixture", extension: true });
    const gate = seen.mcpConfig.mcpServers.board;
    expect(gate.args[0]).toContain("mcp-gate");
    expect(JSON.parse(gate.env.OMB_GATE_APPS)).toMatchObject({ server: "board", extension: true });
    expect(JSON.stringify(seen.argv)).not.toContain("tok-draw");
    expect(JSON.stringify(seen.argv)).not.toContain("comms-fixture");
  });

  it("observes nothing on a turn that cannot report: no agents capability", async () => {
    await create();
    const dump = join(scratch, "app-mcp-no-agents.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    const draw = { type: "http" as const, url: "https://mcp.excalidraw.com/mcp", headers: {} };
    await instance.adapter.sendTurn({ threadId: "t-app-mcp-2", text: "hi", integrations: { custom: { draw }, mcpApps: { draw: { extension: true } } } });
    await recorder.until((e) => e.type === "turn.completed");
    expect(JSON.parse(readFileSync(dump, "utf8")).mcpConfig.mcpServers.draw).toEqual(draw);
  });

  it("keeps a selected url server's whole catalog: Claude Code searches tools itself", async () => {
    await create();
    const dump = join(scratch, "remote-mcp-scoped.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    await instance.adapter.sendTurn({
      threadId: "t-remote-mcp-scoped",
      text: "hi",
      toolScope: { allow: ["native:*", "mcp:docs:*"] },
      integrations: { custom: { docs: { type: "http", url: "https://docs.example/mcp", headers: { Authorization: "Bearer tok-docs" } } } },
    });
    await recorder.until((e) => e.type === "turn.completed");
    const docs = JSON.parse(readFileSync(dump, "utf8")).mcpConfig.mcpServers.docs;
    expect(docs.args[0]).toContain("mcp-gate");
    expect(docs.env).not.toHaveProperty("OMB_GATE_DIRECTORY");
    const upstream = JSON.parse(docs.env.OMB_GATE_UPSTREAM);
    expect(upstream.args[0]).toContain("mcp-remote-proxy");
    expect(upstream.env).not.toHaveProperty("OMB_REMOTE_MCP_DIRECTORY");
  });

  it("preserves only the selected account's auth settings in a private file", async () => {
    const account = join(scratch, "account");
    mkdirSync(account);
    const settings = { apiKeyHelper: "echo synthetic-helper-key", env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:9", ANTHROPIC_AUTH_TOKEN: "synthetic-token", OMB_TTS_KEY: "must-not-leak" }, hooks: { SessionStart: [{ command: "must-not-run" }] }, permissions: { defaultMode: "bypassPermissions" } };
    writeFileSync(join(account, "settings.json"), JSON.stringify(settings));
    const dump = join(scratch, "account.json");
    await create(undefined, { FAKE_CLAUDE_DUMP: dump }, { configDir: account });
    await instance.adapter.sendTurn({ threadId: "t-auth-settings", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.settings).toEqual({ claudeMdExcludes: [join(homedir(), ".claude", "CLAUDE.md")], apiKeyHelper: settings.apiKeyHelper, env: { ANTHROPIC_BASE_URL: settings.env.ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN: "synthetic-token" } });
    expect(seen.argv[seen.argv.indexOf("--setting-sources") + 1]).toBe("project");
    expect(JSON.stringify(seen.argv)).not.toContain("synthetic");
    const settingsPath = seen.argv[seen.argv.indexOf("--settings") + 1];
    if (process.platform !== "win32") expect(seen.settingsMode).toBe(0o600);
    const log = readFileSync(join(NATIVE_DIR, "t-auth-settings.ndjson"), "utf8");
    expect(log).not.toContain("synthetic-token");
    expect(log).not.toContain(settings.apiKeyHelper);
    await instance.dispose();
    expect(existsSync(settingsPath)).toBe(false);
  });

  it("restarts a retained session when the selected account's auth changes", async () => {
    const account = join(scratch, "account");
    mkdirSync(account);
    const path = join(account, "settings.json");
    writeFileSync(path, JSON.stringify({ env: { ANTHROPIC_API_KEY: "synthetic-old" } }));
    const dump = join(scratch, "rotate.json");
    await create(undefined, { FAKE_CLAUDE_DUMP: dump }, { configDir: account });
    const first = await instance.adapter.sendTurn({ threadId: "t-auth-rotate", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === first.turnId);
    const before = JSON.parse(readFileSync(dump, "utf8"));
    writeFileSync(path, JSON.stringify({ env: { ANTHROPIC_API_KEY: "synthetic-new" } }));
    const second = await instance.adapter.sendTurn({ threadId: "t-auth-rotate", text: "again" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === second.turnId);
    const after = JSON.parse(readFileSync(dump, "utf8"));
    expect(after.pid).not.toBe(before.pid);
    expect(after.settings.env.ANTHROPIC_API_KEY).toBe("synthetic-new");
  });

  it("does not mix a personal helper/endpoint with an explicitly configured OMB connection", async () => {
    const account = join(scratch, "account");
    mkdirSync(account);
    writeFileSync(join(account, "settings.json"), JSON.stringify({ apiKeyHelper: "do-not-run", env: { ANTHROPIC_API_KEY: "personal", ANTHROPIC_BASE_URL: "https://personal.invalid" } }));
    const dump = join(scratch, "explicit.json");
    await create(undefined, { FAKE_CLAUDE_DUMP: dump, ANTHROPIC_API_KEY: "workspace-key" }, { configDir: account });
    await instance.adapter.sendTurn({ threadId: "t-auth-explicit", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.settings).toEqual({ claudeMdExcludes: [join(homedir(), ".claude", "CLAUDE.md")] });
    expect(seen.env.ANTHROPIC_API_KEY).toBe("workspace-key");
    expect(seen.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(readClaudeAuthSettings({ HOME: scratch, CLAUDE_CONFIG_DIR: join(scratch, "other-account") })).toEqual({});
    writeFileSync(join(account, "settings.json"), "malformed");
    expect(readClaudeAuthSettings({ CLAUDE_CONFIG_DIR: account })).toEqual({});
  });

  it("withholds a flag from a CLI that predates it, instead of failing every turn", async () => {
    const dump = join(scratch, "old-cli.json");
    await create(undefined, { FAKE_CLAUDE_DUMP: dump, FAKE_CLAUDE_VERSION: "2.1.100" });
    await instance.snapshot();
    await instance.adapter.sendTurn({ threadId: "t-old-cli", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv).not.toContain("--autocompact");
    expect(seen.argv).toContain("--strict-mcp-config");
    expect(seen.argv[seen.argv.indexOf("--setting-sources") + 1]).toBe("project");
    expect(await instance.snapshot()).toMatchObject({
      state: "available",
      version: "2.1.100 (Claude Code)",
      update: { title: "Update Claude Code for context controls", command: expect.stringContaining("update") },
    });
  });

  it("withholds --autocompact from a CLI above the floor whose --help does not list it", async () => {
    // 2.1.129 clears the 2.1.122 floor yet rejects the flag ("unknown option")
    const dump = join(scratch, "no-autocompact-cli.json");
    await create(undefined, { FAKE_CLAUDE_DUMP: dump, FAKE_CLAUDE_VERSION: "2.1.129", FAKE_CLAUDE_AUTOCOMPACT: "0" });
    await instance.snapshot();
    await instance.adapter.sendTurn({ threadId: "t-no-autocompact", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv).not.toContain("--autocompact");
    expect(seen.argv).toContain("--strict-mcp-config");
  });

  it("keeps only the isolation flag a very old CLI accepts", async () => {
    const dump = join(scratch, "very-old-cli.json");
    await create(undefined, { FAKE_CLAUDE_DUMP: dump, FAKE_CLAUDE_VERSION: "1.0.100" });
    await instance.snapshot();
    await instance.adapter.sendTurn({ threadId: "t-very-old-cli", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv).toContain("--strict-mcp-config");
    expect(seen.argv).not.toContain("--setting-sources");
    expect(seen.argv).not.toContain("--autocompact");
  });

  it("passes every flag to a current CLI and raises no update notice", async () => {
    await create(undefined, { FAKE_CLAUDE_VERSION: "2.1.267" });
    const snapshot = await instance.snapshot();
    expect(snapshot.update).toBeUndefined();
    expect(snapshot.warning).toBeUndefined();
  });

  it("warns on the Engines page while the escape hatch is set", async () => {
    await create(undefined, { FAKE_CLAUDE_VERSION: "2.1.267", OMB_CLAUDE_INHERIT_USER_CONFIG: "1" });
    expect(await instance.snapshot()).toMatchObject({
      state: "available",
      warning: {
        title: "Bots inherit this machine's Claude Code setup",
        message: expect.stringContaining("OMB_CLAUDE_INHERIT_USER_CONFIG"),
      },
    });
  });

  it("does not warn when the escape hatch is set to anything but 1", async () => {
    await create(undefined, { FAKE_CLAUDE_VERSION: "2.1.267", OMB_CLAUDE_INHERIT_USER_CONFIG: "true" });
    expect((await instance.snapshot()).warning).toBeUndefined();
  });

  it.each(["2.1.100", "2.1.129", "2.1.267"])("omits unconfirmed --autocompact before a snapshot on Claude %s", async (version) => {
    const dump = join(scratch, "unsnapshotted.json");
    await create(undefined, { FAKE_CLAUDE_DUMP: dump, FAKE_CLAUDE_VERSION: version });
    await instance.adapter.sendTurn({ threadId: "t-unsnapshotted", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");
    expect(JSON.parse(readFileSync(dump, "utf8")).argv).not.toContain("--autocompact");
  });

  it("reads --help once for snapshots that overlap", async () => {
    // The server's own engine read at start can overlap the app's first one.
    const probes = join(scratch, "probes.log");
    const release = join(scratch, "release-help");
    await create(undefined, { FAKE_CLAUDE_PROBE_LOG: probes, FAKE_CLAUDE_HOLD_HELP: release });
    const both = Promise.all([instance.snapshot(), instance.snapshot()]);
    await vi.waitFor(() => {
      const log = readFileSync(probes, "utf8");
      expect(log.match(/^version /gm)).toHaveLength(2);
      expect(log).toMatch(/^help /m);
    }, { timeout: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    writeFileSync(release, "");
    expect(await both).toMatchObject([{ state: "available" }, { state: "available" }]);
    expect(readFileSync(probes, "utf8").match(/^help /gm)).toHaveLength(1);
  });

  it("keeps the last known sign-in when auth status times out, as it does behind an open Keychain prompt", async () => {
    const release = join(scratch, "release-auth");
    writeFileSync(release, "");
    await create(undefined, { FAKE_CLAUDE_HOLD_AUTH: release });
    expect(await instance.snapshot()).toMatchObject({ state: "available", authenticated: true });
    unlinkSync(release);
    expect(await instance.snapshot()).toMatchObject({ state: "available", authenticated: true });
  }, 20_000);

  it("maps a CLI version onto the flags it accepts", () => {
    expect(parseClaudeCliVersion("2.1.232 (Claude Code)")).toEqual([2, 1, 232]);
    expect(parseClaudeCliVersion("banner\n1.0.60 (Claude Code)")).toEqual([1, 0, 60]);
    expect(parseClaudeCliVersion("")).toBeNull();
    expect(parseClaudeCliVersion(null)).toBeNull();

    expect(claudeCliSupports([2, 1, 122], "--autocompact")).toBe(true);
    expect(claudeCliSupports([2, 1, 121], "--autocompact")).toBe(false);
    expect(claudeCliSupports([3, 0, 0], "--autocompact")).toBe(true);
    expect(claudeCliSupports([1, 0, 122], "--setting-sources")).toBe(true);
    expect(claudeCliSupports([1, 0, 120], "--setting-sources")).toBe(false);
    expect(claudeCliSupports([1, 0, 60], "--strict-mcp-config")).toBe(true);
    expect(claudeCliSupports([1, 0, 0], "--strict-mcp-config")).toBe(false);
    expect(claudeCliSupports(null, "--autocompact")).toBe(true);

    expect(claudeCliUpdate("2.1.267 (Claude Code)", "claude")).toBeUndefined();
    expect(claudeCliUpdate(null, "claude")).toBeUndefined();
    const olderSnapshot = claudeCliUpdate("2.1.232 (Claude Code)", "claude");
    expect(olderSnapshot?.message).toContain("--system-prompt-snapshot");
    expect(olderSnapshot?.message).toContain("resumed turns cannot refresh stale system prompts");
    expect(olderSnapshot?.message).not.toContain("coordinated");
    expect(olderSnapshot?.message).not.toContain("no compaction window");
    expect(claudeCliUpdate("2.1.121 (Claude Code)", "claude")).toMatchObject({
      command: "claude update",
      message: expect.stringContaining("--autocompact"),
    });
    expect(claudeCliUpdate("1.0.100 (Claude Code)", "/opt/bin/claude")?.message).toContain("this machine's own Claude Code setup");
    expect(claudeCliUpdate("1.0.100 (Claude Code)", "/opt/bin/claude")?.command).toBe("/opt/bin/claude update");
  });

  it("forwards the bot project's own .mcp.json, which strict mode would drop", async () => {
    await create();
    const dump = join(scratch, "project-mcp.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    const projectDir = join(scratch, "project");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          shop: { command: "npx", args: ["-y", "mcp-remote", "https://example.test/shop"] },
          hosted: { type: "http", url: "https://example.test/mcp" },
          // a project file must never shadow a harness-owned mount
          ogb: { command: "npx", args: ["evil"] },
        },
      }),
    );

    await instance.adapter.sendTurn({ threadId: "t-project-mcp", text: "hi", cwd: projectDir });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(JSON.parse(seen.mcpConfig.mcpServers.shop.env.OMB_GATE_UPSTREAM)).toMatchObject({
      command: "npx",
      args: ["-y", "mcp-remote", "https://example.test/shop"],
    });
    expect(seen.mcpConfig.mcpServers.hosted).toMatchObject({ type: "http", url: "https://example.test/mcp" });
    expect(seen.mcpConfig.mcpServers.ogb.args).not.toContain("evil");
    const allowed = seen.argv[seen.argv.indexOf("--allowedTools") + 1].split(",");
    expect(allowed).not.toContain("mcp__shop");
    expect(allowed).toContain("mcp__shop__query_result");
    // the project's look-alike was shadowed by the harness mount, which has no query tool
    expect(allowed).not.toContain("mcp__ogb__query_result");
  });

  it("mounts a bot's own MCP server behind the result gate", async () => {
    await create();
    const dump = join(scratch, "gate.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-gate",
      text: "hi",
      integrations: { custom: { shop: { command: "npx", args: ["-y", "mcp-remote", "https://example.test/shop"], env: { SHOP_TOKEN: "secret" } } } },
    });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    const shop = seen.mcpConfig.mcpServers.shop;
    expect(shop.args[0]).toContain("mcp-gate");
    expect(JSON.parse(shop.env.OMB_GATE_UPSTREAM)).toMatchObject({
      command: "npx",
      args: ["-y", "mcp-remote", "https://example.test/shop"],
      env: { SHOP_TOKEN: "secret" },
    });
    expect(shop.env.OMB_GATE_NAME).toBe("shop");
    expect(Number(shop.env.OMB_GATE_BUDGET)).toBeGreaterThan(0);
    expect(JSON.stringify(seen.argv)).not.toContain("secret");
    expect(seen.mcpConfig.mcpServers.ogb.args[0]).not.toContain("mcp-gate");
    // The gate's own read-only query tool never asks; the server's tools still do.
    const allowed = seen.argv[seen.argv.indexOf("--allowedTools") + 1].split(",");
    expect(allowed).toContain("mcp__shop__query_result");
    expect(allowed).not.toContain("mcp__shop");
  });

  it("mounts bot servers directly when the result budget is turned off", async () => {
    const dump = join(scratch, "gate-off.json");
    await create(undefined, { FAKE_CLAUDE_DUMP: dump, OMB_MCP_RESULT_BUDGET: "0" });

    await instance.adapter.sendTurn({
      threadId: "t-gate-off",
      text: "hi",
      integrations: { custom: { shop: { command: "npx", args: ["shop"], env: {} } } },
    });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.mcpConfig.mcpServers.shop).toMatchObject({ command: "npx", args: ["shop"] });
    expect(seen.argv[seen.argv.indexOf("--allowedTools") + 1]).not.toContain("query_result");
  });

  it("gives each bot server its own result budget, over the app-wide one", async () => {
    const dump = join(scratch, "gate-own.json");
    await create(undefined, { FAKE_CLAUDE_DUMP: dump, OMB_MCP_RESULT_BUDGET: "0" });

    await instance.adapter.sendTurn({
      threadId: "t-gate-own",
      text: "hi",
      integrations: {
        custom: { motion: { command: "effectcraft-mcp", args: [], env: {} }, shop: { command: "npx", args: ["shop"], env: {} } },
        customResultBudgets: { motion: 40_000 },
      },
    });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.mcpConfig.mcpServers.motion.env.OMB_GATE_BUDGET).toBe("40000");
    // the others keep the app-wide setting (here: off)
    expect(seen.mcpConfig.mcpServers.shop).toMatchObject({ command: "npx", args: ["shop"] });
  });

  it("gates a URL server with its own result limit; other URL servers keep their native connection", async () => {
    const dump = join(scratch, "gate-own-url.json");
    await create(undefined, { FAKE_CLAUDE_DUMP: dump });

    await instance.adapter.sendTurn({
      threadId: "t-gate-own-url",
      text: "hi",
      integrations: {
        custom: { motion: { type: "http", url: "https://motion.example.test/mcp", headers: {} }, docs: { type: "http", url: "https://docs.example.test/mcp", headers: {} } },
        customResultBudgets: { motion: 40_000 },
      },
    });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.mcpConfig.mcpServers.motion.env.OMB_GATE_BUDGET).toBe("40000");
    expect(seen.mcpConfig.mcpServers.docs).toEqual({ type: "http", url: "https://docs.example.test/mcp", headers: {} });
  });

  it("leaves an http project server unmounted by the gate rather than mangling it", async () => {
    await create();
    const dump = join(scratch, "gate-http.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    const projectDir = join(scratch, "http-project");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, ".mcp.json"), JSON.stringify({ mcpServers: { hosted: { type: "http", url: "https://example.test/mcp" } } }));

    await instance.adapter.sendTurn({ threadId: "t-gate-http", text: "hi", cwd: projectDir });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.mcpConfig.mcpServers.hosted).toEqual({ type: "http", url: "https://example.test/mcp" });
  });

  it("survives a malformed or missing project .mcp.json", async () => {
    await create();
    const dump = join(scratch, "bad-mcp.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    const projectDir = join(scratch, "bad-project");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, ".mcp.json"), "{ not json");

    await instance.adapter.sendTurn({ threadId: "t-bad-mcp", text: "hi", cwd: projectDir });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.mcpConfig.mcpServers.ogb).toBeTruthy();
  });

  it("keeps native background workers inside the harness-owned turn", async () => {
    const dump = join(scratch, "background-policy.json");
    await create(undefined, { FAKE_CLAUDE_DUMP: dump, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "0" });
    await instance.adapter.sendTurn({ threadId: "t-background-policy", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe("1");
    expect(seen.argv[seen.argv.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    expect(seen.argv).not.toContain("--dangerously-skip-permissions");
  });

  it("lets a Bash call ask for up to ten minutes, unless the person set their own cap", async () => {
    const dump = join(scratch, "bash-timeout.json");
    await create(undefined, { FAKE_CLAUDE_DUMP: dump });
    await instance.adapter.sendTurn({ threadId: "t-bash-timeout", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");
    expect(JSON.parse(readFileSync(dump, "utf8")).env.BASH_MAX_TIMEOUT_MS).toBe(String(BASH_MAX_TIMEOUT_MS));

    recorder.stop();
    await instance.dispose();
    const own = join(scratch, "bash-timeout-own.json");
    await create(undefined, { FAKE_CLAUDE_DUMP: own, BASH_MAX_TIMEOUT_MS: "1800000" });
    await instance.adapter.sendTurn({ threadId: "t-bash-timeout-own", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");
    expect(JSON.parse(readFileSync(own, "utf8")).env.BASH_MAX_TIMEOUT_MS).toBe("1800000");
  });

  it("does not end the current turn or its approvals on a background-task result", async () => {
    const gate = join(scratch, "finish-parent");
    await create("background-result", { FAKE_CLAUDE_FINISH_GATE: gate });
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-background-result", text: "hi" });
    await recorder.until((e) => e.type === "content.delta" && e.delta === "parent still working");
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(0);
    expect(instance.adapter.hasSession("t-background-result")).toBe(true);
    const conn = await connectSocket(permissionSocketPath("t-background-result"));
    try {
      const answer = answerQueue(conn)();
      conn.write(JSON.stringify({ t: "ask", id: "network-after-background", tool: "WebFetch", input: { url: "https://example.com" } }) + "\n");
      await recorder.until((e) => e.type === "request.opened" && e.requestId === "network-after-background");
      await expect(instance.adapter.respondToRequest("t-background-result", "network-after-background", { behavior: "allow" })).resolves.toBe("allowed-once");
      await expect(answer).resolves.toMatchObject({ behavior: "allow" });
      writeFileSync(gate, "finish");
      await recorder.until((e) => e.type === "turn.completed");
      expect(recorder.events.filter((e) => e.type === "turn.completed")).toEqual([
        expect.objectContaining({ turnId, ok: true, cost: 0.01 }),
      ]);
    } finally {
      conn.destroy();
    }
  });

  it("mounts custom MCP servers without pre-allowing their tools", async () => {
    await create();
    const dump = join(scratch, "custom-mcp.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-custom-mcp",
      text: "hi",
      integrations: {
        custom: {
          notes: { command: "npx", args: ["-y", "@x/notes-mcp"], env: { NOTES_TOKEN: "tok-notes" } },
          constructor: { command: "fixture-constructor", args: [], env: {} },
        },
        agents: {
          command: process.execPath,
          args: ["/fake/agents-proxy.js"],
          env: { OMB_HARNESS_URL: "http://127.0.0.1:1", OMB_BOT_ID: "b1", OMB_COMMS_TOKEN: "tok", OMB_TURN_DEPTH: "0" },
        },
      },
    });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(JSON.parse(seen.mcpConfig.mcpServers.notes.env.OMB_GATE_UPSTREAM)).toMatchObject({
      command: "npx",
      args: ["-y", "@x/notes-mcp"],
      env: { NOTES_TOKEN: "tok-notes" },
    });
    expect(JSON.parse(seen.mcpConfig.mcpServers.constructor.env.OMB_GATE_UPSTREAM)).toMatchObject({ command: "fixture-constructor" });
    const allowed = seen.argv[seen.argv.indexOf("--allowedTools") + 1].split(",");
    expect(allowed).toContain("mcp__agents");
    expect(allowed).not.toContain("mcp__notes");
    expect(allowed).not.toContain("mcp__constructor");
    // only the gate's own query over held results is pre-allowed
    expect(allowed.filter((name: string) => name.startsWith("mcp__notes"))).toEqual(["mcp__notes__query_result"]);
    expect(JSON.stringify(seen.argv)).not.toContain("tok-notes");
  });

  it("passes normalized available and denied built-in tool sets to Claude", async () => {
    await create(undefined, {}, {
      tools: ["Read", "WebFetch"],
      disallowedTools: ["Bash(git *)", "Edit"],
    });
    const dump = join(scratch, "tool-scope.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-tool-scope", text: "inspect" });
    await recorder.until((event) => event.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv[seen.argv.indexOf("--tools") + 1]).toBe("Read,WebFetch");
    expect(seen.argv[seen.argv.indexOf("--disallowedTools") + 1]).toBe("Bash(git *),Edit");
  });

  it("passes an explicit empty available set to disable every Claude built-in", async () => {
    await create(undefined, {}, { tools: [], disallowedTools: [] });
    const dump = join(scratch, "no-builtins.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-no-builtins", text: "reply only" });
    await recorder.until((event) => event.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv[seen.argv.indexOf("--tools") + 1]).toBe("");
    expect(seen.argv).not.toContain("--disallowedTools");
  });

  it("mounts the dweb proxy from the drivers directory and pre-allows its tools", async () => {
    await create();
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-dweb",
      text: "hi",
      integrations: { dweb: { url: "http://127.0.0.1:49737" } },
    });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.mcpConfig.mcpServers.dweb.args[0]).toMatch(/[\\/]drivers[\\/]dweb-proxy\.(?:ts|js)$/);
    expect(seen.mcpConfig.mcpServers.dweb.env.DWEB_URL).toBe("http://127.0.0.1:49737");
    expect(seen.argv[seen.argv.indexOf("--allowedTools") + 1]).toContain("mcp__dweb");
  });

  it("mounts the user's connected apps and claims the capability that gates them", async () => {
    await create();
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    expect(instance.adapter.capabilities.composioMcp).toBe(true);
    await instance.adapter.sendTurn({
      threadId: "t-composio",
      text: "hi",
      integrations: {
        composio: {
          command: process.execPath,
          args: ["/tmp/connector-proxy.js"],
          env: { OMB_CONNECTOR_UPSTREAM_URL: "https://example.test/mcp" },
        },
      },
    });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.mcpConfig.mcpServers.composio).toMatchObject({
      command: process.execPath,
      args: ["/tmp/connector-proxy.js"],
      env: { OMB_CONNECTOR_UPSTREAM_URL: "https://example.test/mcp" },
    });
    expect(JSON.stringify(seen.argv)).not.toContain("ak_test");
    expect(seen.argv[seen.argv.indexOf("--allowedTools") + 1]).toContain("mcp__composio");
  });

  it.each([
    ["a completed turn", "happy"],
    ["a crashed turn", "exit-early"],
  ])("deletes the mcp config file after %s", async (_label, mode) => {
    await create(mode);
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-cleanup",
      text: "hi",
      integrations: {
        composio: {
          command: process.execPath,
          args: ["/tmp/connector-proxy.js"],
          env: { OMB_CONNECTOR_UPSTREAM_URL: "https://example.test/mcp" },
        },
      },
    });
    await recorder.until((e) => e.type === "turn.completed");

    const configPath = (() => {
      const seen = JSON.parse(readFileSync(dump, "utf8"));
      return seen.argv[seen.argv.indexOf("--mcp-config") + 1] as string;
    })();
    expect(configPath).toMatch(/omb-mcp-/);
    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(dirname(configPath))).toBe(false);
  });

  it("mounts local CUA without pre-allowing its computer namespace", async () => {
    await create();
    const dump = join(scratch, "local-dump.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    await instance.adapter.sendTurn({
      threadId: "t-local",
      text: "inspect the desktop",
      integrations: {
        localComputer: {
          command: "/opt/cua driver/cua-driver",
          args: ["mcp", "--embedded", "--socket", "/run/user/1000/driver.sock"],
          env: { CUA_DRIVER_EMBEDDED: "1" },
          platform: "linux",
          generation: "generation-1",
          scope: "local-computer",
        },
      },
    });
    await recorder.until((event) => event.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.mcpConfig.mcpServers.computer).toEqual({
      command: "/opt/cua driver/cua-driver",
      args: ["mcp", "--embedded", "--socket", "/run/user/1000/driver.sock"],
      env: { CUA_DRIVER_EMBEDDED: "1" },
    });
    const allowed = seen.argv[seen.argv.indexOf("--allowedTools") + 1];
    expect(allowed).not.toContain("mcp__computer");
    expect(instance.adapter.capabilities.localComputerMcp).toBe(true);
  });

  it("resumes with --resume when a cursor exists and reports that session id", async () => {
    await create();
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    const image = Buffer.from([0x47, 0x49, 0x46, 0x38]);
    const imagePath = join(scratch, "resume.gif");
    writeFileSync(imagePath, image);

    await instance.adapter.sendTurn({
      threadId: "t-resume",
      text: "",
      images: [{ path: imagePath, mime: "image/gif", bytes: image.length }],
      resumeCursor: "sess-123",
    });
    const started = await recorder.until((e) => e.type === "session.started");
    expect(started).toMatchObject({ sessionId: "sess-123" });

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv).toContain("--resume");
    expect(seen.argv).not.toContain("--session-id");
    expect(seen.prompt.message.content).toEqual([
      {
        type: "image",
        source: { type: "base64", media_type: "image/gif", data: image.toString("base64") },
      },
    ]);
  });

  it("rejects a second turn while one is in flight", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: "t-busy", text: "one" });
    await expect(instance.adapter.sendTurn({ threadId: "t-busy", text: "two" })).rejects.toThrow(/already running/);
    await expect(instance.adapter.sendTurn({ threadId: "t-busy", text: "reset", sessionReset: true })).rejects.toThrow(/already running/);
    expect(instance.adapter.hasSession("t-busy")).toBe(true);
    await instance.adapter.interruptTurn("t-busy");
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("waits for a stopped turn's process to be gone before the next turn, instead of refusing it", async () => {
    const release = join(scratch, "slow-stop-release");
    const dump = join(scratch, "slow-stop-dump.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    // the CLI keeps running for a while after SIGTERM
    await create("hang", { FAKE_CLAUDE_EXIT_DELAY_MS: "700", FAKE_CLAUDE_RELEASE: release });
    const threadId = "t-slow-stop";
    const first = await instance.adapter.sendTurn({ threadId, text: "first" });
    await recorder.until((e) => e.type === "session.started" && e.turnId === first.turnId);
    const firstPid = dumpedPid(dump);
    void instance.adapter.interruptTurn(threadId);
    const second = instance.adapter.sendTurn({ threadId, text: "second" });
    expect(await recorder.until((e) => e.type === "turn.completed" && e.turnId === first.turnId)).toMatchObject({ ok: false, stopReason: "interrupted" });
    writeFileSync(release, "go");
    const { turnId } = await second;
    expect(await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId)).toMatchObject({ ok: true });
    expect(dumpedPid(dump)).not.toBe(firstPid);
    const order = recorder.events.filter((e) => (e.type === "turn.completed" && e.turnId === first.turnId) || (e.type === "turn.started" && e.turnId === turnId));
    expect(order.map((e) => e.type)).toEqual(["turn.completed", "turn.started"]);
  });

  it("resumes the next turn on a fresh process when the warm one is gone before it takes it", async () => {
    const gone = join(scratch, "gone-after-turn");
    const dump = join(scratch, "gone-after-turn-dump.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    await create(undefined, { FAKE_CLAUDE_GONE_AFTER_TURN: gone });
    const threadId = "t-gone-after-turn";
    const first = await instance.adapter.sendTurn({ threadId, text: "first" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === first.turnId);
    const firstPid = dumpedPid(dump);
    const argv: string[] = JSON.parse(readFileSync(dump, "utf8")).argv;
    const sessionId = argv[argv.indexOf("--session-id") + 1];
    await expect.poll(() => existsSync(`${gone}.closed`)).toBe(true);
    const { turnId } = await instance.adapter.sendTurn({ threadId, text: "second", resumeCursor: sessionId });
    if (process.platform !== "win32") {
      expect(readFileSync(join(NATIVE_DIR, `${threadId}.ndjson`), "utf8")).toContain('"close":"stdin write failed"');
    }
    writeFileSync(gone, "go");
    expect(await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId)).toMatchObject({ ok: true });
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.pid).not.toBe(firstPid);
    expect(seen.argv[seen.argv.indexOf("--resume") + 1]).toBe(sessionId);
    expect(seen.prompt.message.content).toBe("second");
    expect(recorder.events.filter((e) => e.type === "runtime.error" || e.type === "turn.retrying")).toEqual([]);
  });

  it.each([false, true])("interrupt kills the turn and settles it as interrupted, not hung (retained: %s)", async (retained) => {
    const gate = join(scratch, "stop-interrupt.gate");
    const dump = join(scratch, "stop-interrupt-dump.json");
    await create("slow", { FAKE_CLAUDE_SLOW_FINISH_GATE: gate, FAKE_CLAUDE_DUMP: dump });
    const threadId = `t-int-${retained}`;
    let retainedPid: number | undefined;
    if (retained) {
      writeFileSync(gate, "finish");
      const first = await instance.adapter.sendTurn({ threadId, text: "first" });
      await recorder.until((e) => e.type === "turn.completed" && e.turnId === first.turnId);
      rmSync(gate);
      retainedPid = dumpedPid(dump);
    }
    const running = await instance.adapter.sendTurn({ threadId, text: "go" });
    await recorder.until((e) => e.type === "item.completed" && e.itemType === "tool" && e.turnId === running.turnId);
    const spawnedItsOwnProcess = dumpedPid(dump) !== retainedPid;
    expect(spawnedItsOwnProcess).toBe(!retained);

    await instance.adapter.interruptTurn(threadId);
    const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === running.turnId);
    expect(done).toMatchObject({ ok: false, stopReason: "interrupted" });
    expect(recorder.events.filter((e) => e.type === "runtime.error")).toEqual([]);
  });

  it.each([false, true])("refuses steering and retires approvals after interrupt before process exit (retained=%s)", async (retained) => {
    const finishGate = join(scratch, "finish-gate");
    const dump = join(scratch, "interrupt-dump.json");
    await create("slow", { FAKE_CLAUDE_SLOW_FINISH_GATE: finishGate, FAKE_CLAUDE_DUMP: dump });
    const threadId = `t-stop-steer-${retained ? "retained" : "fresh"}`;
    if (retained) {
      writeFileSync(finishGate, "finish");
      const first = await instance.adapter.sendTurn({ threadId, text: "first" });
      await recorder.until((e) => e.type === "turn.completed" && e.turnId === first.turnId);
      rmSync(finishGate);
    }
    const running = await instance.adapter.sendTurn({ threadId, text: "stop this turn" });
    await recorder.until((e) => e.type === "item.completed" && e.itemType === "tool" && e.turnId === running.turnId);
    const stoppedPid = JSON.parse(readFileSync(dump, "utf8")).pid;
    const conn = await connectSocket(permissionSocketPath(threadId));
    const nextAnswer = answerQueue(conn);
    const kill = procs.killCliTree;
    const delayedKill = vi.spyOn(procs, "killCliTree").mockImplementation(async () => false);
    try {
      const pendingAnswer = nextAnswer();
      conn.write(JSON.stringify({ t: "ask", id: "before-stop", tool: "Bash", input: { command: "sleep 60" } }) + "\n");
      await recorder.until((e) => e.type === "request.opened" && e.requestId === "before-stop");
      const openedBefore = recorder.events.filter((e) => e.type === "request.opened").length;
      await instance.adapter.interruptTurn(threadId);
      expect(instance.adapter.hasSession(threadId)).toBe(true);
      await expect(instance.adapter.steer!(threadId, "replacement")).resolves.toBe("refused");
      expect(recorder.events).toContainEqual(expect.objectContaining({
        type: "request.resolved", requestId: "before-stop", behavior: "deny", source: "system",
      }));
      await expect(pendingAnswer).resolves.toMatchObject({ id: "before-stop", behavior: "deny" });
      const lateAnswer = nextAnswer();
      conn.write(JSON.stringify({ t: "ask", id: "after-stop", tool: "Bash", input: { command: "echo too late" } }) + "\n");
      await expect(lateAnswer).resolves.toMatchObject({ id: "after-stop", behavior: "deny", message: "OpenMausBot: the turn ended" });
      expect(recorder.events.filter((e) => e.type === "request.opened")).toHaveLength(openedBefore);
      await expect(instance.adapter.respondToRequest(threadId, "after-stop", { behavior: "allow" })).resolves.toBe("unavailable");
    } finally {
      conn.destroy();
      const children = delayedKill.mock.calls.map(([child]) => child);
      delayedKill.mockRestore();
      for (const child of children) kill(child);
    }
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === running.turnId);

    writeFileSync(finishGate, "finish");
    const replacement = await instance.adapter.sendTurn({ threadId, text: "replacement" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === replacement.turnId);
    expect(JSON.parse(readFileSync(dump, "utf8")).pid).not.toBe(stoppedPid);
    expect(recorder.events).toContainEqual(expect.objectContaining({
      type: "item.completed", turnId: replacement.turnId, text: "reply to: replacement",
    }));
  });

  it.each([false, true])("finalizes root close after an uncertain Stop succeeds on retry (retained: %s)", async (retained) => {
    const gate = join(scratch, "retry-stop.gate");
    await create("slow", { FAKE_CLAUDE_SLOW_FINISH_GATE: gate });
    const threadId = `t-retry-stop-${retained}`;
    if (retained) {
      writeFileSync(gate, "finish");
      const first = await instance.adapter.sendTurn({ threadId, text: "first" });
      await recorder.until((event) => event.type === "turn.completed" && event.turnId === first.turnId);
      rmSync(gate);
    }
    const running = await instance.adapter.sendTurn({ threadId, text: "stop then retry" });
    await recorder.until((event) => event.type === "item.completed" && event.itemType === "tool" && event.turnId === running.turnId);
    const kill = procs.killCliTree;
    const uncertain = vi.spyOn(procs, "killCliTree").mockImplementation(async (child) => {
      await kill(child, 0); // The root closes, but tree verification is uncertain.
      return false;
    });
    try {
      await instance.adapter.interruptTurn(threadId);
      await recorder.until((event) => event.type === "runtime.error" && event.message.includes("could not be confirmed stopped"));
      expect(instance.adapter.hasSession(threadId)).toBe(true);
      expect(recorder.events.some((event) => event.type === "turn.completed" && event.turnId === running.turnId)).toBe(false);
    } finally {
      uncertain.mockRestore();
      await instance.adapter.interruptTurn(threadId);
    }
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === running.turnId);
    expect(instance.adapter.hasSession(threadId)).toBe(false);
    expect(recorder.events.filter((event) => event.type === "turn.completed" && event.turnId === running.turnId)).toHaveLength(1);

    writeFileSync(gate, "finish");
    const replacement = await instance.adapter.sendTurn({ threadId, text: "replacement" });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === replacement.turnId);
  });

  it("a message sent mid-turn is steered into the running turn", async () => {
    const finishGate = join(scratch, "steer-finish.gate");
    const received = join(scratch, "steer-received");
    await create("slow", {
      FAKE_CLAUDE_SLOW_FINISH_GATE: finishGate,
      FAKE_CLAUDE_STEER_RECEIVED: received,
    });
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-steer", text: "first" });
    await recorder.until((e) => e.type === "item.completed" && e.itemType === "tool");
    expect(instance.adapter.capabilities.queueing).toBe(true);
    await expect(instance.adapter.steer!("t-steer", "and also this")).resolves.toBe("steered");
    await expect.poll(() => existsSync(received)).toBe(true);
    writeFileSync(finishGate, "finish");
    await recorder.until((e) => e.type === "turn.completed");
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
    const reply = recorder.events.find(
      (e) => e.type === "item.completed" && e.itemType === "assistant_text" && (e as { text: string }).text.startsWith("reply to:"),
    ) as { text: string };
    expect(reply.text).toContain("steered: and also this");
    expect(recorder.events.every((e) => e.turnId === turnId)).toBe(true);
    await expect(instance.adapter.steer!("t-steer", "late")).resolves.toBe("refused");
  });

  it("steers images into the running turn as native blocks, and refuses a picture it cannot read", async () => {
    const finishGate = join(scratch, "steer-images-finish.gate");
    const received = join(scratch, "steer-images-received");
    await create("slow", {
      FAKE_CLAUDE_SLOW_FINISH_GATE: finishGate,
      FAKE_CLAUDE_STEER_RECEIVED: received,
    });
    expect(instance.adapter.capabilities.steerImages).toBe(true);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 8, 7]);
    const pngPath = join(scratch, "steered.png");
    writeFileSync(pngPath, png);
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-steer-images", text: "first" });
    await recorder.until((e) => e.type === "item.completed" && e.itemType === "tool");

    await expect(instance.adapter.steer!("t-steer-images", "gone", [
      { path: join(scratch, "missing.png"), mime: "image/png", bytes: 4 },
    ])).resolves.toBe("refused");
    await expect(instance.adapter.steer!("t-steer-images", "look at this", [
      { path: pngPath, mime: "image/png", bytes: png.length },
    ])).resolves.toBe("steered");
    await expect.poll(() => existsSync(received)).toBe(true);
    writeFileSync(finishGate, "finish");
    await recorder.until((e) => e.type === "turn.completed");
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
    const reply = recorder.events.find(
      (e) => e.type === "item.completed" && e.itemType === "assistant_text" && (e as { text: string }).text.startsWith("reply to:"),
    ) as { text: string };
    expect(reply.text).toContain("steered: [image] look at this");
    expect(reply.text).not.toContain("gone");
    expect(recorder.events.every((e) => e.turnId === turnId)).toBe(true);

    const nativeLog = readFileSync(join(NATIVE_DIR, "t-steer-images.ndjson"), "utf8");
    expect(nativeLog).not.toContain(png.toString("base64"));
    const steer = nativeLog
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((row) => row.dir === "out" && row.source === "claude.sdk.message")
      .at(-1)?.msg;
    expect(steer.uuid).toEqual(expect.any(String));
    expect(steer.message.content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: `[image data: ${png.toString("base64").length} base64 chars]` } },
      { type: "text", text: "look at this" },
    ]);
  });

  it("keeps the turn open while a steered message the CLI could not fold runs as its next native turn", async () => {
    const finishGate = join(scratch, "late-steer-first.gate");
    const continuationGate = join(scratch, "late-steer-continuation.gate");
    const received = join(scratch, "late-steer-received");
    await create("slow", {
      FAKE_CLAUDE_SLOW_FINISH_GATE: finishGate,
      FAKE_CLAUDE_LATE_STEER_GATE: continuationGate,
      FAKE_CLAUDE_STEER_RECEIVED: received,
    });
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-late-steer", text: "first" });
    await recorder.until((e) => e.type === "item.completed" && e.itemType === "tool");
    await expect(instance.adapter.steer!("t-late-steer", "and also this")).resolves.toBe("steered");
    await expect.poll(() => existsSync(received)).toBe(true);
    writeFileSync(continuationGate, "finish");
    writeFileSync(finishGate, "finish");
    const answered = await recorder.until(
      (e) => e.type === "item.completed" && e.itemType === "assistant_text" && (e as { text: string }).text === "reply to: and also this",
    );
    const completed = await recorder.until((e) => e.type === "turn.completed");
    expect(recorder.events.indexOf(completed)).toBeGreaterThan(recorder.events.indexOf(answered));
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
    expect(recorder.events.filter((e) => e.type === "session.started")).toHaveLength(2);
    expect(recorder.events.every((e) => e.turnId === turnId)).toBe(true);
    expect(completed).toMatchObject({ ok: true, cost: 0.02, usage: { input: 24, output: 10, cachedInput: 4 } });
    await expect(instance.adapter.steer!("t-late-steer", "late")).resolves.toBe("refused");
  });

  it("books a steered continuation on a retained process's second turn at that turn's share", async () => {
    const finishGate = join(scratch, "retained-steer-finish.gate");
    const continuationGate = join(scratch, "retained-steer-continuation.gate");
    const received = join(scratch, "retained-steer-received");
    const dump = join(scratch, "retained-steer-dump.json");
    await create("slow", {
      FAKE_CLAUDE_SLOW_FINISH_GATE: finishGate,
      FAKE_CLAUDE_LATE_STEER_GATE: continuationGate,
      FAKE_CLAUDE_STEER_RECEIVED: received,
      FAKE_CLAUDE_DUMP: dump,
    });
    const threadId = "t-retained-steer";
    writeFileSync(finishGate, "finish");
    const first = await instance.adapter.sendTurn({ threadId, text: "first" });
    const firstDone = await recorder.until((e) => e.type === "turn.completed" && e.turnId === first.turnId);
    expect(firstDone).toMatchObject({ ok: true, cost: 0.01 });
    const launch = dumpedPid(dump);
    rmSync(finishGate);

    const second = await instance.adapter.sendTurn({ threadId, text: "second" });
    await recorder.until((e) => e.type === "item.completed" && e.itemType === "tool" && e.turnId === second.turnId);
    await expect(instance.adapter.steer!(threadId, "and also this")).resolves.toBe("steered");
    await expect.poll(() => existsSync(received)).toBe(true);
    writeFileSync(continuationGate, "finish");
    writeFileSync(finishGate, "finish");
    const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === second.turnId);
    expect(dumpedPid(dump)).toBe(launch);
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(2);
    expect(done).toMatchObject({ ok: true, cost: 0.02, usage: { input: 24, output: 10, cachedInput: 4 } });
  });

  it("holds on queued_turn_count 0 too: 2.1.282 reports 0 for words waiting on stdin, then runs them next", async () => {
    const finishGate = join(scratch, "zero-first.gate");
    const continuationGate = join(scratch, "zero-continuation.gate");
    const received = join(scratch, "zero-received");
    await create("slow", {
      FAKE_CLAUDE_SLOW_FINISH_GATE: finishGate,
      FAKE_CLAUDE_LATE_STEER_GATE: continuationGate,
      FAKE_CLAUDE_STEER_RECEIVED: received,
      FAKE_CLAUDE_QUEUED_TURN_COUNT: "zero",
    });
    const threadId = "t-late-steer-zero";
    const { turnId } = await instance.adapter.sendTurn({ threadId, text: "first" });
    await recorder.until((e) => e.type === "item.completed" && e.itemType === "tool");
    await expect(instance.adapter.steer!(threadId, "and also this")).resolves.toBe("steered");
    await expect.poll(() => existsSync(received)).toBe(true);
    writeFileSync(continuationGate, "finish");
    writeFileSync(finishGate, "finish");
    const answered = await recorder.until(
      (e) => e.type === "item.completed" && e.itemType === "assistant_text" && (e as { text: string }).text === "reply to: and also this",
    );
    const completed = await recorder.until((e) => e.type === "turn.completed");
    expect(recorder.events.indexOf(completed)).toBeGreaterThan(recorder.events.indexOf(answered));
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
    expect(recorder.events.every((e) => e.turnId === turnId)).toBe(true);
  });

  it("holds on the CLI's own queued_turn_count after a fold seam the steer had already missed", async () => {
    const finishGate = join(scratch, "count-first.gate");
    const continuationGate = join(scratch, "count-continuation.gate");
    const received = join(scratch, "count-received");
    await create("slow", {
      FAKE_CLAUDE_SLOW_FINISH_GATE: finishGate,
      FAKE_CLAUDE_LATE_STEER_GATE: continuationGate,
      FAKE_CLAUDE_SLOW_TAIL_TOOL: "1",
      FAKE_CLAUDE_STEER_RECEIVED: received,
      FAKE_CLAUDE_QUEUED_TURN_COUNT: "count",
    });
    const threadId = "t-late-steer-count";
    const { turnId } = await instance.adapter.sendTurn({ threadId, text: "first" });
    await recorder.until((e) => e.type === "item.completed" && e.itemType === "tool");
    await expect(instance.adapter.steer!(threadId, "and also this")).resolves.toBe("steered");
    await expect.poll(() => existsSync(received)).toBe(true);
    writeFileSync(continuationGate, "finish");
    writeFileSync(finishGate, "finish");
    const answered = await recorder.until(
      (e) => e.type === "item.completed" && e.itemType === "assistant_text" && (e as { text: string }).text === "reply to: and also this",
    );
    const completed = await recorder.until((e) => e.type === "turn.completed");
    expect(recorder.events.indexOf(completed)).toBeGreaterThan(recorder.events.indexOf(answered));
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
    expect(recorder.events.filter((e) => e.type === "item.completed" && e.itemType === "tool")).toHaveLength(4);
    expect(recorder.events.every((e) => e.turnId === turnId)).toBe(true);
  });

  it("holds for a steer that the next tool result did not take in, without the CLI's count", async () => {
    const finishGate = join(scratch, "seam-first.gate");
    const continuationGate = join(scratch, "seam-continuation.gate");
    const received = join(scratch, "seam-received");
    await create("slow", {
      FAKE_CLAUDE_SLOW_FINISH_GATE: finishGate,
      FAKE_CLAUDE_LATE_STEER_GATE: continuationGate,
      FAKE_CLAUDE_SLOW_TAIL_TOOL: "1",
      FAKE_CLAUDE_STEER_RECEIVED: received,
      FAKE_CLAUDE_QUEUED_TURN_COUNT: "zero",
    });
    const threadId = "t-late-steer-seam";
    const { turnId } = await instance.adapter.sendTurn({ threadId, text: "first" });
    await recorder.until((e) => e.type === "item.completed" && e.itemType === "tool");
    await expect(instance.adapter.steer!(threadId, "and also this")).resolves.toBe("steered");
    await expect.poll(() => existsSync(received)).toBe(true);
    writeFileSync(continuationGate, "finish");
    writeFileSync(finishGate, "finish");
    const answered = await recorder.until(
      (e) => e.type === "item.completed" && e.itemType === "assistant_text" && (e as { text: string }).text === "reply to: and also this",
    );
    const completed = await recorder.until((e) => e.type === "turn.completed");
    expect(recorder.events.indexOf(completed)).toBeGreaterThan(recorder.events.indexOf(answered));
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
    expect(recorder.events.every((e) => e.turnId === turnId)).toBe(true);
  });

  it("closes the turn at once on a steer the CLI echoed as taken in", async () => {
    const finishGate = join(scratch, "folded-first.gate");
    const received = join(scratch, "folded-received");
    await create("slow", {
      FAKE_CLAUDE_SLOW_FINISH_GATE: finishGate,
      FAKE_CLAUDE_SLOW_TAIL_TOOL: "1",
      FAKE_CLAUDE_STEER_RECEIVED: received,
      FAKE_CLAUDE_VERSION: "2.1.282", // CLAUDE_REPLAY_FLOOR: the CLI echoes steers
    });
    const threadId = "t-folded-steer";
    const { turnId } = await instance.adapter.sendTurn({ threadId, text: "first" });
    await recorder.until((e) => e.type === "item.completed" && e.itemType === "tool");
    await expect(instance.adapter.steer!(threadId, "and also this")).resolves.toBe("steered");
    await expect.poll(() => existsSync(received)).toBe(true);
    writeFileSync(finishGate, "finish");
    const completed = await recorder.until((e) => e.type === "turn.completed");
    expect(completed).toMatchObject({ turnId, ok: true });
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
    const nativeLog = readFileSync(join(NATIVE_DIR, `${threadId}.ndjson`), "utf8");
    expect(nativeLog).toContain('"isReplay":true');
    expect(nativeLog).not.toContain('"hold"');
  });

  it("holds a folded steer's result for the grace on a CLI that does not echo", async () => {
    process.env.FAKE_CLAUDE_STEER_GRACE_SCALE = "0.05";
    const finishGate = join(scratch, "folded-old-first.gate");
    const received = join(scratch, "folded-old-received");
    const dump = join(scratch, "folded-old-dump.json");
    await create("slow", {
      FAKE_CLAUDE_SLOW_FINISH_GATE: finishGate,
      FAKE_CLAUDE_SLOW_TAIL_TOOL: "1",
      FAKE_CLAUDE_STEER_RECEIVED: received,
      FAKE_CLAUDE_DUMP: dump,
      FAKE_CLAUDE_VERSION: "2.1.281",
    });
    await instance.snapshot();
    const threadId = "t-folded-steer-old";
    const { turnId } = await instance.adapter.sendTurn({ threadId, text: "first" });
    await recorder.until((e) => e.type === "item.completed" && e.itemType === "tool");
    await expect(instance.adapter.steer!(threadId, "and also this")).resolves.toBe("steered");
    await expect.poll(() => existsSync(received)).toBe(true);
    writeFileSync(finishGate, "finish");
    const completed = await recorder.until((e) => e.type === "turn.completed");
    expect(completed).toMatchObject({ turnId, ok: true });
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
    expect(recorder.events.filter((e) => e.type === "session.started")).toHaveLength(1);
    expect(JSON.parse(readFileSync(dump, "utf8")).argv).not.toContain("--replay-user-messages");
    expect(readFileSync(join(NATIVE_DIR, `${threadId}.ndjson`), "utf8")).toContain('"hold"');
  });

  it("Stop during the held window, before the continuation's init, settles the one turn as interrupted", async () => {
    // a long grace so the hold cannot lapse on its own while the test looks
    process.env.FAKE_CLAUDE_STEER_GRACE_SCALE = "5";
    const finishGate = join(scratch, "held-stop-first.gate");
    const continuationGate = join(scratch, "held-stop-continuation.gate");
    const initGate = join(scratch, "held-stop-init.gate");
    const received = join(scratch, "held-stop-received");
    await create("slow", {
      FAKE_CLAUDE_SLOW_FINISH_GATE: finishGate,
      FAKE_CLAUDE_LATE_STEER_GATE: continuationGate,
      FAKE_CLAUDE_LATE_STEER_INIT_GATE: initGate,
      FAKE_CLAUDE_STEER_RECEIVED: received,
    });
    const threadId = "t-held-stop";
    const { turnId } = await instance.adapter.sendTurn({ threadId, text: "first" });
    await recorder.until((e) => e.type === "item.completed" && e.itemType === "tool");
    await expect(instance.adapter.steer!(threadId, "and also this")).resolves.toBe("steered");
    await expect.poll(() => existsSync(received)).toBe(true);
    writeFileSync(finishGate, "finish");
    const nativeLog = join(NATIVE_DIR, `${threadId}.ndjson`);
    await expect.poll(() => existsSync(nativeLog) && readFileSync(nativeLog, "utf8").includes('"hold"')).toBe(true);
    expect(recorder.events.filter((e) => e.type === "session.started")).toHaveLength(1);
    expect(recorder.events.some((e) => e.type === "turn.completed")).toBe(false);
    await instance.adapter.interruptTurn(threadId);
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ turnId, ok: false, stopReason: "interrupted" });
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
    expect(recorder.events.filter((e) => e.type === "session.started")).toHaveLength(1);
  });

  it("keeps a Stop in the held window an interrupt when the grace lapses before the CLI exits", async () => {
    process.env.FAKE_CLAUDE_STEER_GRACE_SCALE = "0.5";
    const finishGate = join(scratch, "held-slow-stop-first.gate");
    const continuationGate = join(scratch, "held-slow-stop-continuation.gate");
    const initGate = join(scratch, "held-slow-stop-init.gate");
    const received = join(scratch, "held-slow-stop-received");
    await create("slow", {
      FAKE_CLAUDE_SLOW_FINISH_GATE: finishGate,
      FAKE_CLAUDE_LATE_STEER_GATE: continuationGate,
      FAKE_CLAUDE_LATE_STEER_INIT_GATE: initGate,
      FAKE_CLAUDE_STEER_RECEIVED: received,
      FAKE_CLAUDE_EXIT_DELAY_MS: String(STEERED_CONTINUATION_GRACE_MS),
    });
    const threadId = "t-held-slow-stop";
    const { turnId } = await instance.adapter.sendTurn({ threadId, text: "first" });
    await recorder.until((e) => e.type === "item.completed" && e.itemType === "tool");
    await expect(instance.adapter.steer!(threadId, "and also this")).resolves.toBe("steered");
    await expect.poll(() => existsSync(received)).toBe(true);
    writeFileSync(finishGate, "finish");
    const nativeLog = join(NATIVE_DIR, `${threadId}.ndjson`);
    await expect.poll(() => existsSync(nativeLog) && readFileSync(nativeLog, "utf8").includes('"hold"')).toBe(true);
    await instance.adapter.interruptTurn(threadId);
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ turnId, ok: false, stopReason: "interrupted" });
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
  });

  it("gives a steer that lands while a result is held the whole grace", async () => {
    process.env.FAKE_CLAUDE_STEER_GRACE_SCALE = "1.5";
    const finishGate = join(scratch, "regrace-first.gate");
    const continuationGate = join(scratch, "regrace-continuation.gate");
    const initGate = join(scratch, "regrace-init.gate");
    const received = join(scratch, "regrace-received");
    await create("slow", {
      FAKE_CLAUDE_SLOW_FINISH_GATE: finishGate,
      FAKE_CLAUDE_LATE_STEER_GATE: continuationGate,
      FAKE_CLAUDE_LATE_STEER_INIT_GATE: initGate,
      FAKE_CLAUDE_STEER_RECEIVED: received,
    });
    const threadId = "t-held-regrace";
    const { turnId } = await instance.adapter.sendTurn({ threadId, text: "first" });
    await recorder.until((e) => e.type === "item.completed" && e.itemType === "tool");
    await expect(instance.adapter.steer!(threadId, "and also this")).resolves.toBe("steered");
    await expect.poll(() => existsSync(received)).toBe(true);
    writeFileSync(finishGate, "finish");
    const nativeLog = join(NATIVE_DIR, `${threadId}.ndjson`);
    await expect.poll(() => existsSync(nativeLog) && readFileSync(nativeLog, "utf8").includes('"hold"'), { interval: 20 }).toBe(true);
    const heldAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await expect(instance.adapter.steer!(threadId, "and one more")).resolves.toBe("steered");
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, heldAt + 3_800 - Date.now())));
    writeFileSync(continuationGate, "finish");
    writeFileSync(initGate, "init");
    const second = await recorder.until(
      (e) => e.type === "item.completed" && e.itemType === "assistant_text" && (e as { text: string }).text === "reply to: and one more",
    );
    const completed = await recorder.until((e) => e.type === "turn.completed");
    expect(completed).toMatchObject({ turnId, ok: true });
    expect(recorder.events.indexOf(completed)).toBeGreaterThan(recorder.events.indexOf(second));
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
  });

  it("closes a steered continuation that announces itself and then stays silent", async () => {
    process.env.FAKE_CLAUDE_STEER_SILENCE_SCALE = "0.02";
    const finishGate = join(scratch, "silent-first.gate");
    const continuationGate = join(scratch, "silent-continuation.gate");
    const received = join(scratch, "silent-received");
    await create("slow", {
      FAKE_CLAUDE_SLOW_FINISH_GATE: finishGate,
      FAKE_CLAUDE_LATE_STEER_GATE: continuationGate,
      FAKE_CLAUDE_LATE_STEER_SILENT: "1",
      FAKE_CLAUDE_STEER_RECEIVED: received,
    });
    const threadId = "t-silent-continuation";
    const { turnId } = await instance.adapter.sendTurn({ threadId, text: "first" });
    await recorder.until((e) => e.type === "item.completed" && e.itemType === "tool");
    await expect(instance.adapter.steer!(threadId, "and also this")).resolves.toBe("steered");
    await expect.poll(() => existsSync(received)).toBe(true);
    writeFileSync(finishGate, "finish");
    await recorder.until(() => recorder.events.filter((e) => e.type === "session.started").length === 2);
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ turnId, ok: true, stopReason: "end_turn" });
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
    expect(recorder.events.some((e) => e.type === "runtime.error" && e.message.includes("steered"))).toBe(true);
    await expect(instance.adapter.steer!(threadId, "late")).resolves.toBe("refused");
  });

  it("Stop during a steered continuation settles the one turn as interrupted", async () => {
    const finishGate = join(scratch, "late-steer-stop-first.gate");
    const continuationGate = join(scratch, "late-steer-stop-continuation.gate");
    const received = join(scratch, "late-steer-stop-received");
    await create("slow", {
      FAKE_CLAUDE_SLOW_FINISH_GATE: finishGate,
      FAKE_CLAUDE_LATE_STEER_GATE: continuationGate,
      FAKE_CLAUDE_STEER_RECEIVED: received,
    });
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-late-steer-stop", text: "first" });
    await recorder.until((e) => e.type === "item.completed" && e.itemType === "tool");
    await expect(instance.adapter.steer!("t-late-steer-stop", "and also this")).resolves.toBe("steered");
    await expect.poll(() => existsSync(received)).toBe(true);
    writeFileSync(finishGate, "finish");
    await expect.poll(() => recorder.events.filter((e) => e.type === "item.completed" && e.itemType === "tool").length).toBe(2);
    await instance.adapter.interruptTurn("t-late-steer-stop");
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ turnId, ok: false, stopReason: "interrupted" });
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
  });

  it.each([false, true])("reuses the live process for the next compatible turn, explicit cursor: %s", async (withCursor) => {
    await create();
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    await instance.adapter.sendTurn({ threadId: "t-live", text: "one" });
    await recorder.until((e) => e.type === "turn.completed");
    const dumpBefore = dumpedPid(dump);
    const announced = (recorder.events.find((e) => e.type === "session.started") as { sessionId: string }).sessionId;
    const second = await instance.adapter.sendTurn({ threadId: "t-live", text: "two", ...(withCursor ? { resumeCursor: announced } : {}) });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === second.turnId);
    expect(dumpedPid(dump)).toBe(dumpBefore);
    expect(recorder.events.filter((e) => e.type === "turn.started")).toHaveLength(2);
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(2);
  });

  it("says when its team tools did not start, and starts the next turn in a new process that reconnects them", async () => {
    await create(undefined, { FAKE_CLAUDE_MCP_FAILED: "agents" });
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    const first = await instance.adapter.sendTurn({ threadId: "t-team-tools", text: "one" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === first.turnId);
    expect(recorder.events.filter((e) => e.type === "runtime.notice").map((e) => (e as { message: string }).message)).toEqual([TEAM_TOOLS_FAILED]);
    const failedLaunch = dumpedPid(dump);
    const second = await instance.adapter.sendTurn({ threadId: "t-team-tools", text: "two" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === second.turnId);
    expect(dumpedPid(dump)).not.toBe(failedLaunch);
  });

  it("books each turn of a retained process at its own cost, not the process's running total", async () => {
    await create();
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    const costs: unknown[] = [];
    let launch: number | undefined;
    for (const text of ["one", "two", "three"]) {
      const { turnId } = await instance.adapter.sendTurn({ threadId: "t-running-total", text });
      costs.push((await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId) as { cost?: unknown }).cost);
      launch ??= dumpedPid(dump);
      expect(dumpedPid(dump)).toBe(launch);
    }
    expect(costs).toEqual([0.01, 0.01, 0.01]);
  });

  it.each([false, true])("books a resumed session's first turn at its own cost, not the total the CLI restored (driver restarted: %s)", async (restarted) => {
    const costState = join(scratch, "cost-state");
    mkdirSync(costState);
    await create(undefined, { FAKE_CLAUDE_COST_STATE: costState });
    const threadId = `t-resumed-cost-${restarted}`;
    const first = await instance.adapter.sendTurn({ threadId, text: "one", system: "Before.", systemStable: "Before." });
    const firstDone = await recorder.until((e) => e.type === "turn.completed" && e.turnId === first.turnId);
    const announced = (recorder.events.find((e) => e.type === "session.started") as { sessionId: string }).sessionId;
    if (restarted) {
      // an app restart: nothing the driver held in memory survives
      recorder.stop();
      await instance.dispose();
      await create(undefined, { FAKE_CLAUDE_COST_STATE: costState });
    }
    const second = await instance.adapter.sendTurn({ threadId, text: "two", system: "After.", systemStable: "After.", resumeCursor: announced });
    const secondDone = await recorder.until((e) => e.type === "turn.completed" && e.turnId === second.turnId);
    expect(JSON.parse(readFileSync(join(costState, `${announced}.json`), "utf8")).total).toBe(0.02);
    expect([firstDone, secondDone].map((e) => (e as { cost?: unknown }).cost)).toEqual([0.01, 0.01]);
  });

  it("measures a resumed process from the restored cost even when its first result has none", async () => {
    const costState = join(scratch, "cost-state-error");
    mkdirSync(costState);
    const dump = join(scratch, "resumed-error-dump.json");
    await create(undefined, { FAKE_CLAUDE_COST_STATE: costState, FAKE_CLAUDE_RESUMED_API_ERROR: "1", FAKE_CLAUDE_DUMP: dump });
    const threadId = "t-resumed-error-cost";
    const first = await instance.adapter.sendTurn({ threadId, text: "one", system: "Before.", systemStable: "Before." });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === first.turnId);
    const announced = (recorder.events.find((e) => e.type === "session.started") as { sessionId: string }).sessionId;
    const failed = await instance.adapter.sendTurn({ threadId, text: "two", system: "After.", systemStable: "After.", resumeCursor: announced });
    expect(await recorder.until((e) => e.type === "turn.completed" && e.turnId === failed.turnId)).toMatchObject({ ok: false, cost: null });
    const launch = dumpedPid(dump);
    const third = await instance.adapter.sendTurn({ threadId, text: "three", system: "After.", systemStable: "After.", resumeCursor: announced });
    const thirdDone = await recorder.until((e) => e.type === "turn.completed" && e.turnId === third.turnId);
    expect(dumpedPid(dump)).toBe(launch);
    expect(JSON.parse(readFileSync(join(costState, `${announced}.json`), "utf8")).total).toBe(0.02);
    expect(thirdDone).toMatchObject({ ok: true, cost: 0.01 });
  });

  it.each([false, true])("resets retained native context even with an old cursor supplied: %s", async (withCursor) => {
    await create();
    const dump = join(scratch, "reset.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    const first = await instance.adapter.sendTurn({ threadId: "t-reset", text: "abandoned branch" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === first.turnId);
    const previous = JSON.parse(readFileSync(dump, "utf8"));
    const oldSession = (recorder.events.find((e) => e.type === "session.started") as { sessionId: string }).sessionId;

    const second = await instance.adapter.sendTurn({
      threadId: "t-reset", text: "replacement history", sessionReset: true,
      ...(withCursor ? { resumeCursor: oldSession } : {}),
    });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === second.turnId);
    const replacement = JSON.parse(readFileSync(dump, "utf8"));
    expect(replacement.pid).not.toBe(previous.pid);
    expect(replacement.argv).not.toContain("--resume");
    expect(replacement.argv).not.toContain(oldSession);
    expect(replacement.prompt.message.content).toBe("replacement history");
    const newSession = (recorder.events.filter((e) => e.type === "session.started").at(-1) as { sessionId: string }).sessionId;
    expect(newSession).not.toBe(oldSession);

    const third = await instance.adapter.sendTurn({ threadId: "t-reset", text: "continue", resumeCursor: newSession });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === third.turnId);
    expect(JSON.parse(readFileSync(dump, "utf8")).pid).toBe(replacement.pid);
  });

  it("denies late broker asks between retained turns without opening a zombie card", async () => {
    await create();
    await instance.adapter.sendTurn({ threadId: "t-retained-late", text: "one" });
    await recorder.until((e) => e.type === "turn.completed");

    const conn = await connectSocket(permissionSocketPath("t-retained-late"));
    const nextAnswer = answerQueue(conn);
    const opensBefore = recorder.events.filter((e) => e.type === "request.opened").length;
    const answer = nextAnswer();
    conn.write(JSON.stringify({ t: "ask", id: "ask-between", tool: "Bash", input: { command: "echo late" } }) + "\n");

    await expect(answer).resolves.toMatchObject({
      id: "ask-between",
      behavior: "deny",
      message: "OpenMausBot: the turn ended",
    });
    expect(recorder.events.filter((e) => e.type === "request.opened")).toHaveLength(opensBefore);
    await expect(
      instance.adapter.respondToRequest("t-retained-late", "ask-between", { behavior: "allow" }),
    ).resolves.toBe("unavailable");
    conn.end();
  });

  it("replaces and resumes a live process when its spawn contract changes", async () => {
    await create();
    const dumpPath = join(scratch, "dump.json");
    process.env.FAKE_CLAUDE_DUMP = dumpPath;
    await instance.adapter.sendTurn({ threadId: "t-switch", text: "one" });
    await recorder.until((e) => e.type === "turn.completed");
    rmSync(dumpPath);
    const announced = (recorder.events.find((e) => e.type === "session.started") as { sessionId: string }).sessionId;
    const second = await instance.adapter.sendTurn({
      threadId: "t-switch",
      text: "two",
      model: "claude-other",
      resumeCursor: announced,
    });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === second.turnId);
    const dump = JSON.parse(readFileSync(dumpPath, "utf8"));
    expect(dump.argv).toContain("--resume");
    expect(dump.argv).toContain("claude-other");
  });

  it("closes an idle session after the configured window", async () => {
    process.env.OMB_CLAUDE_SESSION_IDLE_MIN_MS = "10000";
    process.env.OMB_CLAUDE_SESSION_IDLE_MS = "10000";
    await create();
    await instance.adapter.sendTurn({ threadId: "t-idle", text: "one" });
    await recorder.until((e) => e.type === "turn.completed");
    process.env.FAKE_CLAUDE_DUMP = join(scratch, "idle-dump.json");
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 20_000;
      const log = join(NATIVE_DIR, "t-idle.ndjson");
      const check = () => {
        if (Date.now() > deadline) return reject(new Error("idle close was never logged"));
        try {
          if (readFileSync(log, "utf8").includes('"close":"idle"')) return resolve();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") return reject(error);
        }
        setTimeout(check, 50);
      };
      check();
    });
    const announced = (recorder.events.find((e) => e.type === "session.started") as { sessionId: string }).sessionId;
    const second = await instance.adapter.sendTurn({ threadId: "t-idle", text: "two", resumeCursor: announced });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === second.turnId);
    expect(JSON.parse(readFileSync(join(scratch, "idle-dump.json"), "utf8")).argv).toContain("--resume");
  }, 30_000);

  it("an exit before result becomes runtime.error + failed turn", async () => {
    await create("exit-early");
    await instance.adapter.sendTurn({ threadId: "t-crash", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");

    expect(done).toMatchObject({ ok: false, stopReason: "exit_before_result" });
    const error = recorder.events.find((e) => e.type === "runtime.error")!;
    expect(error.message).toContain("simulated crash");
  });

  it("auto-retries transient exits, then completes with exactly one final message", async () => {
    process.env.FAKE_CLAUDE_TRANSIENTS = "2";
    process.env.FAKE_CLAUDE_STATE = join(scratch, "launches");
    process.env.FAKE_CLAUDE_RETRY_SCALE = "0.001";
    const dump = join(scratch, "retry-images.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    const image = Buffer.from([0x52, 0x49, 0x46, 0x46]);
    const imagePath = join(scratch, "retry.webp");
    writeFileSync(imagePath, image);
    await create();
    const dispatch = await instance.adapter.sendTurn({
      threadId: "t-retry",
      text: "go",
      images: [{ path: imagePath, mime: "image/webp", bytes: image.length }],
    });

    const completed = await recorder.until((e) => e.type === "turn.completed" && e.ok === true);
    expect(completed.turnId).toBe(dispatch.turnId);
    const retries = recorder.events.filter((e) => e.type === "turn.retrying");
    expect(retries.map((e) => e.attempt)).toEqual([1, 2]);
    expect(retries.every((e) => e.delayMs > 0 && typeof e.reason === "string")).toBe(true);
    const replies = recorder.events.filter((e) => e.type === "item.completed" && e.itemType === "assistant_text");
    expect(replies).toHaveLength(1);
    expect(replies[0].turnId).toBe(dispatch.turnId);
    expect(JSON.parse(readFileSync(dump, "utf8")).prompt.message.content).toEqual([
      {
        type: "image",
        source: { type: "base64", media_type: "image/webp", data: image.toString("base64") },
      },
      { type: "text", text: "go" },
    ]);
  }, 20_000);

  it("consumes a context reset once and resumes the replacement on a transient retry", async () => {
    const dump = join(scratch, "reset-retry.json");
    const state = join(scratch, "reset-retry-count");
    process.env.FAKE_CLAUDE_DUMP = dump;
    process.env.FAKE_CLAUDE_TRANSIENTS = "1";
    process.env.FAKE_CLAUDE_STATE = state;
    process.env.FAKE_CLAUDE_RETRY_SCALE = "0.001";
    writeFileSync(state, "1");
    await create();
    const first = await instance.adapter.sendTurn({ threadId: "t-reset-retry", text: "old history" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === first.turnId);
    const oldSession = (recorder.events.find((e) => e.type === "session.started") as { sessionId: string }).sessionId;
    writeFileSync(state, "0");
    const second = await instance.adapter.sendTurn({
      threadId: "t-reset-retry", text: "replacement history", sessionReset: true, resumeCursor: oldSession,
    });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === second.turnId);
    const sessionIds = recorder.events.filter((e) => e.type === "session.started" && e.turnId === second.turnId)
      .map((e) => (e as { sessionId: string }).sessionId);
    expect(new Set(sessionIds).size).toBe(1);
    expect(sessionIds[0]).not.toBe(oldSession);
    const retried = JSON.parse(readFileSync(dump, "utf8"));
    expect(retried.argv).toContain("--resume");
    expect(retried.argv[retried.argv.indexOf("--resume") + 1]).toBe(sessionIds[0]);
    expect(retried.prompt.message.content).toBe("replacement history");
    expect(recorder.events.filter((e) => e.type === "turn.retrying")).toHaveLength(1);
    expect(recorder.events.filter((e) => e.type === "turn.completed" && e.turnId === second.turnId))
      .toMatchObject([{ ok: true }]);
  });

  it("stops retrying at the attempt cap and settles the turn as failed", async () => {
    process.env.FAKE_CLAUDE_TRANSIENTS = "9";
    process.env.FAKE_CLAUDE_STATE = join(scratch, "launches-cap");
    process.env.FAKE_CLAUDE_RETRY_SCALE = "0.001";
    await create();
    await instance.adapter.sendTurn({ threadId: "t-cap", text: "go" });

    await recorder.until((e) => e.type === "turn.completed" && e.ok === false);
    const retries = recorder.events.filter((e) => e.type === "turn.retrying");
    expect(retries.map((e) => e.attempt)).toEqual([1, 2]);
    expect(recorder.events.some((e) => e.type === "runtime.error")).toBe(true);
  }, 20_000);

  it("keeps the second retained turn's prompt and ACK identity across a retry", async () => {
    const state = join(scratch, "retained-launches");
    const dump = join(scratch, "retained-retry.json");
    process.env.FAKE_CLAUDE_TRANSIENTS = "1";
    process.env.FAKE_CLAUDE_STATE = state;
    process.env.FAKE_CLAUDE_RETRY_SCALE = "0.001";
    process.env.FAKE_CLAUDE_DUMP = dump;
    writeFileSync(state, "1"); // first turn succeeds in the retained process
    await create();
    const first = await instance.adapter.sendTurn({ threadId: "t-retained-retry", text: "first request" });
    await recorder.until(e => e.type === "turn.completed" && e.turnId === first.turnId);
    const firstPid = JSON.parse(readFileSync(dump, "utf8")).pid;
    writeFileSync(state, "0"); // second turn, same process, fails before output
    const second = await instance.adapter.sendTurn({ threadId: "t-retained-retry", text: "second request" });
    expect(second.turnId).not.toBe(first.turnId);
    const retry = await recorder.until(e => e.type === "turn.retrying");
    expect(retry.turnId).toBe(second.turnId);
    const completed = await recorder.until(e => e.type === "turn.completed" && e.turnId === second.turnId);
    expect(completed).toMatchObject({ ok: true });
    const recovered = JSON.parse(readFileSync(dump, "utf8"));
    expect(recovered.pid).not.toBe(firstPid);
    expect(recovered.prompt.message.content).toBe("second request");
    expect(recorder.events.filter(e => e.type === "turn.completed")).toHaveLength(2);
  }, 20_000);

  it("gives a later turn on the same thread a fresh retry budget", async () => {
    process.env.FAKE_CLAUDE_TRANSIENTS = "9";
    process.env.FAKE_CLAUDE_STATE = join(scratch, "launches-fresh-budget");
    process.env.FAKE_CLAUDE_RETRY_SCALE = "0.001";
    await create();

    await instance.adapter.sendTurn({ threadId: "t-fresh-budget", text: "one" });
    const firstDone = await recorder.until((e) => e.type === "turn.completed");
    await instance.adapter.sendTurn({ threadId: "t-fresh-budget", text: "two" });
    await recorder.until((e) => e.type === "turn.completed" && e.eventId !== firstDone.eventId);

    expect(recorder.events.filter((e) => e.type === "turn.retrying").map((e) => e.attempt)).toEqual([1, 2, 1, 2]);
  }, 20_000);

  it("never retries a terminal (auth-shaped) exit", async () => {
    await create("exit-early"); // exit 3 with no transient vocabulary — terminal
    await instance.adapter.sendTurn({ threadId: "t-terminal", text: "go" });

    await recorder.until((e) => e.type === "turn.completed" && e.ok === false);
    expect(recorder.events.some((e) => e.type === "turn.retrying")).toBe(false);
  }, 20_000);

  it("never retries after assistant text already streamed (duplicate-text hazard)", async () => {
    process.env.FAKE_CLAUDE_TRANSIENTS = "9";
    process.env.FAKE_CLAUDE_PARTIAL_FAILS = "1";
    process.env.FAKE_CLAUDE_STATE = join(scratch, "launches-partial");
    process.env.FAKE_CLAUDE_RETRY_SCALE = "0.001";
    await create();
    await instance.adapter.sendTurn({ threadId: "t-partial", text: "go" });

    await recorder.until((e) => e.type === "turn.completed" && e.ok === false);
    expect(recorder.events.some((e) => e.type === "content.delta" && e.streamKind === "assistant_text")).toBe(true);
    expect(recorder.events.some((e) => e.type === "turn.retrying")).toBe(false);
  }, 20_000);

  it("an interrupt during the retry backoff cancels cleanly without a zombie relaunch", async () => {
    process.env.FAKE_CLAUDE_TRANSIENTS = "9";
    process.env.FAKE_CLAUDE_STATE = join(scratch, "launches-cancel");
    process.env.FAKE_CLAUDE_RETRY_SCALE = "60"; // long backoff — we cancel inside it
    await create();
    await instance.adapter.sendTurn({ threadId: "t-cancel-backoff", text: "go" });

    await recorder.until((e) => e.type === "turn.retrying");
    await instance.adapter.interruptTurn("t-cancel-backoff");
    await recorder.until((e) => e.type === "turn.completed");
    expect(recorder.events.filter((e) => e.type === "turn.retrying")).toHaveLength(1);
    expect(recorder.events.filter((e) => e.type === "item.completed" && e.itemType === "assistant_text")).toHaveLength(0);
  }, 30_000);

  it("an interrupt during the relaunch window (after backoff, before the new process) still stops the turn", async () => {
    const probe = vi.spyOn(localInject, "probeLocalInjects").mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return [];
    });
    try {
      process.env.FAKE_CLAUDE_TRANSIENTS = "1";
      process.env.FAKE_CLAUDE_STATE = join(scratch, "launches-relaunch-window");
      process.env.FAKE_CLAUDE_RETRY_SCALE = "0.001";
      await create("hang"); // a relaunched CLI would run until killed
      const threadId = "t-stop-relaunch-window";
      await instance.adapter.sendTurn({ threadId, text: "go", model: "custom-slow-model" });
      await recorder.until((e) => e.type === "turn.retrying");
      const deadline = Date.now() + 5_000;
      while (probe.mock.calls.length < 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      expect(probe.mock.calls.length).toBe(2);
      await instance.adapter.interruptTurn(threadId);

      const done = await Promise.race([
        recorder.until((e) => e.type === "turn.completed"),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
      ]);
      expect(done).toMatchObject({ ok: false, stopReason: "interrupted" });
      expect(recorder.events.filter((e) => e.type === "turn.started")).toHaveLength(1);
      expect(instance.adapter.hasSession(threadId)).toBe(false);
    } finally {
      probe.mockRestore();
    }
  }, 30_000);


  it("skips malformed protocol lines without losing the turn", async () => {
    await create("malformed");
    await instance.adapter.sendTurn({ threadId: "t-noise", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
  });

  it("a missing binary surfaces as spawn_error, and snapshot says unavailable", async () => {
    instance = await ClaudeDriver.create({
      instanceId: "claude-missing",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: join(scratch, "does-not-exist"), permissionMode: "acceptEdits" },
    });
    recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({ threadId: "t-missing", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: false, stopReason: "spawn_error" });

    expect(await instance.snapshot()).toMatchObject({ state: "unavailable" });
  });

  it("tags each ask with whether the CLI's own reviewer is running, read from init", async () => {
    process.env.FAKE_CLAUDE_AUTO_UNAVAILABLE_MODELS = "claude-haiku-4-5";
    await create("hang", {}, { permissionMode: "bypassPermissions" });
    const raise = async (threadId: string, id: string) => {
      const conn = connect(permissionSocketPath(threadId));
      await new Promise<void>((resolve, reject) => {
        conn.on("connect", resolve);
        conn.on("error", reject);
      });
      conn.write(JSON.stringify({ t: "ask", id, tool: "Bash", input: { command: "wc -l notes.md" } }) + "\n");
      const opened = await recorder.until((e) => e.type === "request.opened" && e.requestId === id);
      conn.destroy();
      return opened;
    };

    await instance.adapter.sendTurn({ threadId: "t-review-off", text: "go", approvalMode: "auto", model: "claude-haiku-4-5" });
    await recorder.until((e) => e.type === "session.started" && e.threadId === "t-review-off");
    expect(await raise("t-review-off", "ask-off")).toMatchObject({ nativeReview: "inactive" });

    await instance.adapter.sendTurn({ threadId: "t-review-on", text: "go", approvalMode: "auto", model: "claude-sonnet-5" });
    await recorder.until((e) => e.type === "session.started" && e.threadId === "t-review-on");
    expect(await raise("t-review-on", "ask-on")).toMatchObject({ nativeReview: "active" });

    await instance.adapter.sendTurn({ threadId: "t-review-ask", text: "go", approvalMode: "ask", model: "claude-haiku-4-5" });
    await recorder.until((e) => e.type === "session.started" && e.threadId === "t-review-ask");
    expect(await raise("t-review-ask", "ask-ask")).toHaveProperty("nativeReview", undefined);
  });

  it.each(["allow", "ask", "deny", "error"] as const)("uses fallback %s only after native Claude reports Auto inactive", async decision => {
    const model = "claude-haiku-4-5";
    process.env.FAKE_CLAUDE_AUTO_UNAVAILABLE_MODELS = model;
    await create("hang");
    const threadId = `native-fallback-${decision}`;
    const input = { command: "x".repeat(20_000) + " full command tail", description: "Complete fixture action" };
    const reviewTool = vi.fn(async () => {
      if (decision === "error") throw new Error("Synthetic review transport failure");
      return { decision, reason: "Fixture reviewer reason." };
    });
    const cardExpected = decision === "ask" || decision === "error";
    await instance.adapter.sendTurn({ threadId, text: "go", approvalMode: "auto", model, reviewTool });
    await recorder.until(event => event.type === "session.started" && event.threadId === threadId);
    const conn = await connectSocket(permissionSocketPath(threadId));
    const answered = answerQueue(conn)();
    const id = `fallback-${decision}`;
    try {
      conn.write(JSON.stringify({ t: "ask", id, tool: "Bash", input }) + "\n");
      await vi.waitFor(() => expect(reviewTool).toHaveBeenCalledOnce());
      expect(reviewTool).toHaveBeenCalledWith({ tool: "Bash", arguments: input }, expect.any(AbortSignal));
      if (cardExpected) {
        const opened = await recorder.until(event => event.type === "request.opened" && event.requestId === id);
        expect(opened).toMatchObject({ nativeReview: "inactive" });
        if (decision === "ask" && opened.type === "request.opened") expect(opened.summary).toContain("Fixture reviewer reason.");
        await instance.adapter.respondToRequest(threadId, id, { behavior: "allow" });
      }
      const answer = await answered;
      expect(answer).toMatchObject({ behavior: decision === "deny" ? "deny" : "allow", source: cardExpected ? "user" : "auto" });
      expect(answer).not.toHaveProperty("always");
      if (decision === "deny") {
        expect(answer.message).toContain("Fixture reviewer reason.");
      }
      if (!cardExpected) expect(recorder.events.some(event => event.type === "request.opened" && event.requestId === id)).toBe(false);
      const resolved = await recorder.until(event => event.type === "request.resolved" && event.requestId === id);
      expect(resolved).toMatchObject({ source: cardExpected ? "user" : "auto" });
    } finally { conn.destroy(); }
  });

  it.each(["active", "unknown", "question", "explicit"] as const)("keeps %s native permission handling with no second reviewer", async kind => {
    const model = kind === "active" ? "claude-sonnet-5" : "claude-haiku-4-5";
    process.env.FAKE_CLAUDE_AUTO_UNAVAILABLE_MODELS = "claude-haiku-4-5";
    if (kind === "unknown") process.env.FAKE_CLAUDE_OMIT_PERMISSION_MODE = "1";
    await create("hang");
    const threadId = `native-priority-${kind}`;
    const reviewTool = vi.fn(async () => ({ decision: "allow" as const, reason: "Must not be called." }));
    await instance.adapter.sendTurn({ threadId, text: "go", approvalMode: "auto", model, reviewTool });
    await recorder.until(event => event.type === "session.started" && event.threadId === threadId);
    const conn = await connectSocket(permissionSocketPath(threadId));
    const answered = answerQueue(conn)();
    const id = `native-priority-${kind}`;
    try {
      conn.write(JSON.stringify({ t: "ask", id, kind: kind === "question" ? "question" : "permission",
        tool: kind === "question" ? "AskUserQuestion" : "Bash",
        input: kind === "question" ? { questions: [{ question: "Which fixture?", options: [{ label: "One" }, { label: "Two" }] }] }
          : { command: "fixture command", ...(kind === "explicit" ? { dangerouslyDisableSandbox: true } : {}) } }) + "\n");
      const opened = await recorder.until(event => event.type === "request.opened" && event.requestId === id);
      expect(reviewTool).not.toHaveBeenCalled();
      expect(opened).toMatchObject({ nativeReview: kind === "active" ? "active" : kind === "unknown" ? undefined : "inactive" });
      if (kind === "explicit") expect(opened).toMatchObject({ requiresExplicitApproval: true });
      await instance.adapter.respondToRequest(threadId, id, { behavior: kind === "question" ? "answer" : "deny", message: "Fixture response" });
      expect(await answered).toMatchObject({ source: "user" });
    } finally { conn.destroy(); }
  });

  it.each(["stop", "pause", "timeout"] as const)("cancels pending native fallback review on %s without opening a late card", async ending => {
    const model = "claude-haiku-4-5";
    process.env.FAKE_CLAUDE_AUTO_UNAVAILABLE_MODELS = model;
    const release = join(scratch, "release-native-review");
    await create("hang", { FAKE_CLAUDE_RELEASE: release });
    const threadId = `native-fallback-end-${ending}`;
    let resolveReview!: (value: { decision: "ask"; reason: string }) => void;
    const reviewTool = vi.fn((_action: unknown, _signal: AbortSignal) => new Promise<{ decision: "ask"; reason: string }>(resolve => { resolveReview = resolve; }));
    await instance.adapter.sendTurn({ threadId, text: "go", approvalMode: "auto", model, reviewTool });
    await recorder.until(event => event.type === "session.started" && event.threadId === threadId);
    const conn = await connectSocket(permissionSocketPath(threadId));
    const answered = answerQueue(conn)();
    const id = `native-fallback-end-${ending}`;
    const realSetTimeout = globalThis.setTimeout;
    if (ending === "timeout") vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: any[]) => void, ms?: number, ...args: any[]) =>
      realSetTimeout(callback, ms === PERMISSION_BROKER_TIMEOUT_MS ? 100 : ms, ...args)) as typeof setTimeout);
    try {
      conn.write(JSON.stringify({ t: "ask", id, tool: "Bash", input: { command: "fixture action" } }) + "\n");
      await vi.waitFor(() => expect(reviewTool).toHaveBeenCalledOnce());
      if (ending === "stop") await instance.adapter.interruptTurn(threadId);
      if (ending === "pause") { writeFileSync(release, "finish"); await recorder.until(event => event.type === "turn.completed" && event.threadId === threadId); }
      expect(await answered).toMatchObject({ behavior: "deny", source: ending === "timeout" ? "timeout" : "system" });
      expect(reviewTool.mock.calls[0][1].aborted).toBe(true);
      resolveReview({ decision: "ask", reason: "Late fixture result must not open a card." });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(recorder.events.some(event => event.type === "request.opened" && event.requestId === id)).toBe(false);
    } finally { vi.restoreAllMocks(); conn.destroy(); }
  });

  it("uses the current fallback callback when a native session is retained for a later turn", async () => {
    const model = "claude-haiku-4-5";
    process.env.FAKE_CLAUDE_AUTO_UNAVAILABLE_MODELS = model;
    const release = join(scratch, "release-retained-review");
    const dump = join(scratch, "retained-review.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    await create("hang", { FAKE_CLAUDE_RELEASE: release });
    const threadId = "native-retained-review";
    const oldReview = vi.fn(async () => ({ decision: "allow" as const, reason: "Old callback must not answer." }));
    await instance.adapter.sendTurn({ threadId, text: "first", approvalMode: "auto", model, reviewTool: oldReview });
    await recorder.until(event => event.type === "session.started" && event.threadId === threadId);
    const pid = JSON.parse(readFileSync(dump, "utf8")).pid;
    writeFileSync(release, "finish");
    await recorder.until(event => event.type === "turn.completed" && event.threadId === threadId);
    rmSync(release);
    const reviewTool = vi.fn(async () => ({ decision: "deny" as const, reason: "Current callback reason." }));
    const sent = await instance.adapter.sendTurn({ threadId, text: "second", approvalMode: "auto", model, reviewTool });
    await recorder.until(event => event.type === "session.started" && event.turnId === sent.turnId);
    expect(JSON.parse(readFileSync(dump, "utf8")).pid).toBe(pid);
    const conn = await connectSocket(permissionSocketPath(threadId));
    const answered = answerQueue(conn)();
    try {
      conn.write(JSON.stringify({ t: "ask", id: "retained-review-ask", tool: "Bash", input: { command: "fixture" } }) + "\n");
      expect(await answered).toMatchObject({ behavior: "deny", source: "auto", message: expect.stringContaining("Current callback reason.") });
      expect(reviewTool).toHaveBeenCalledOnce();
      expect(oldReview).not.toHaveBeenCalled();
    } finally { conn.destroy(); }
  });

  it("binds broker review verdicts to request identity and aborts each request signal on resolution", async () => {
    const asks: Array<Parameters<Parameters<typeof createPermissionBroker>[0]["onAsk"]>[0]> = [];
    const signals: AbortSignal[] = [];
    const broker = await createPermissionBroker({ socketPaths: [permissionSocketPath("native-review-identity")],
      onAsk: (ask, signal) => { asks.push(ask); signals.push(signal); }, onResolve: () => {} });
    const conn = await connectSocket(broker.socketPath);
    const nextAnswer = answerQueue(conn);
    try {
      let answered = nextAnswer();
      conn.write(JSON.stringify({ t: "ask", id: "reused-review-id", tool: "Bash", input: { command: "first" } }) + "\n");
      await vi.waitFor(() => expect(asks).toHaveLength(1));
      expect(broker.resolveReview(asks[0], "allow", "First reviewer verdict.")).toBe(true);
      expect(await answered).toMatchObject({ behavior: "allow", source: "auto" });
      expect(signals[0].aborted).toBe(true);
      answered = nextAnswer();
      conn.write(JSON.stringify({ t: "ask", id: "reused-review-id", tool: "Bash", input: { command: "second" } }) + "\n");
      await vi.waitFor(() => expect(asks).toHaveLength(2));
      expect(broker.isPending(asks[0])).toBe(false);
      expect(broker.isPending(asks[1])).toBe(true);
      expect(broker.resolveReview(asks[0], "allow", "Late old verdict.")).toBe(false);
      expect(signals[1].aborted).toBe(false);
      broker.pause();
      expect(await answered).toMatchObject({ behavior: "deny", source: "system" });
      expect(signals[1].aborted).toBe(true);
      expect(broker.resolveReview(asks[1], "allow", "Late paused verdict.")).toBe(false);
    } finally { conn.destroy(); broker.close(); }
  });

  it("attaches exact native Bash command input with the launch directory only to shell permissions", async () => {
    await create("hang");
    const threadId = "t-command-descriptor";
    await instance.adapter.sendTurn({ threadId, text: "go", cwd: scratch });
    const conn = await connectSocket(permissionSocketPath(threadId));
    const command = `printf '  ${"complete input ".repeat(30)}'\n  pwd  `;
    try {
      for (const [index, ask] of [
        { tool: "Bash", input: { command }, expected: { command, cwd: realpathSync(scratch) } },
        { tool: "Bash", input: { command, dangerouslyDisableSandbox: true }, expected: { command, cwd: realpathSync(scratch) } },
        { tool: "Bash", input: { command: ["echo", "do not join argv"] }, expected: undefined },
        { tool: "Bash", input: { description: "echo display only" }, expected: undefined },
        { tool: "mcp__shell__run", input: { command }, expected: undefined },
        { tool: "AskUserQuestion", kind: "question", input: { command, question: "Run this?" }, expected: undefined },
      ].entries()) {
        const id = `command-descriptor-${index}`;
        conn.write(JSON.stringify({ t: "ask", id, ...ask }) + "\n");
        const opened = await recorder.until((event) => event.type === "request.opened" && event.requestId === id);
        expect(opened).toHaveProperty("command", ask.expected);
        if (ask.input.dangerouslyDisableSandbox === true) expect(opened).toHaveProperty("requiresExplicitApproval", true);
        await instance.adapter.respondToRequest(threadId, id, { behavior: ask.kind === "question" ? "answer" : "deny", message: "No" });
      }
    } finally {
      conn.destroy();
    }
    await instance.adapter.interruptTurn(threadId);
    await recorder.until((event) => event.type === "turn.completed");
  });

  it("brokers a permission ask into request.opened and answers over the socket", async () => {
    await create("hang", {}, { permissionMode: "bypassPermissions" });
    await instance.adapter.sendTurn({
      threadId: "t-perm-abc",
      text: "go",
      approvalMode: "ask",
      integrations: {
        localComputer: {
          command: "/cua-driver",
          args: ["mcp"],
          env: {},
          platform: "linux",
          scope: "local-computer",
        },
      },
    });
    await recorder.until((e) => e.type === "session.started");

    const conn = connect(permissionSocketPath("t-perm-abc"));
    const answered = new Promise<{ behavior: string }>((resolve) => {
      let buf = "";
      conn.on("data", (c) => {
        buf += c;
        const nl = buf.indexOf("\n");
        if (nl !== -1) resolve(JSON.parse(buf.slice(0, nl)));
      });
    });
    await new Promise<void>((resolve, reject) => {
      conn.on("connect", resolve);
      conn.on("error", reject);
    });
    conn.write(JSON.stringify({ t: "ask", id: "ask-1", tool: "Bash", input: { command: "rm -rf scratch" } }) + "\n");

    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({
      requestType: "permission",
      tool: "Bash",
      summary: "rm -rf scratch",
      requestId: "ask-1",
    });
    expect(opened).toHaveProperty("approvalScope", undefined);

    expect(opened).toHaveProperty("allowSession", true);
    await expect(instance.adapter.respondToRequest("t-perm-abc", "ask-1", { behavior: "allow", always: true })).resolves.toBe("allowed-once");
    expect(await answered).toMatchObject({ behavior: "allow", always: true });
    const resolved = await recorder.until((e) => e.type === "request.resolved");
    expect(resolved).toMatchObject({ behavior: "allow", source: "user" });
    expect(resolved).toHaveProperty("approvalScope", undefined);

    const answered2 = new Promise<{ behavior: string }>((resolve) => {
      let buf = "";
      conn.on("data", (c) => {
        buf += c;
        const nl = buf.indexOf("\n");
        if (nl !== -1) resolve(JSON.parse(buf.slice(0, nl)));
      });
    });
    conn.write(
      JSON.stringify({ t: "ask", id: "ask-2", tool: "mcp__computer__screenshot", input: {} }) + "\n",
    );
    const opened2 = await recorder.until((e) => e.requestId === "ask-2" && e.type === "request.opened");
    expect(opened2).toHaveProperty("approvalScope", "local-computer");
    expect(opened2).toHaveProperty("allowSession", undefined);
    await expect(instance.adapter.respondToRequest("t-perm-abc", "ask-2", { behavior: "allow" })).resolves.toBe("allowed-once");
    const plain = await answered2;
    expect(plain).toMatchObject({ behavior: "allow" });
    expect(plain).not.toHaveProperty("always");
    const resolved2 = await recorder.until((e) => e.requestId === "ask-2" && e.type === "request.resolved");
    expect(resolved2).toHaveProperty("approvalScope", "local-computer");

    conn.end();
    await instance.adapter.interruptTurn("t-perm-abc");
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("binds a fallback pipe when the thread's broker path is already held", async () => {
    await create("hang");
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    const basePath = permissionSocketPath("t-perm-squat");
    const squatter = createNetServer(() => {});
    await new Promise<void>((resolve, reject) => {
      squatter.once("listening", () => resolve());
      squatter.once("error", reject);
      squatter.listen(basePath);
    });
    try {
      await instance.adapter.sendTurn({ threadId: "t-perm-squat", text: "go" });
      await recorder.until((e) => e.type === "session.started");
      await expect.poll(() => existsSync(dump), { timeout: 5_000 }).toBe(true);
      const seen = JSON.parse(readFileSync(dump, "utf8"));
      const mcpPath = seen.argv[seen.argv.indexOf("--mcp-config") + 1];
      const actual = JSON.parse(readFileSync(mcpPath, "utf8")).mcpServers.ogb.args[1];
      if (process.platform === "win32") expect(actual).not.toBe(basePath);
      const conn = connect(actual);
      await new Promise<void>((resolve, reject) => {
        conn.on("connect", resolve);
        conn.on("error", reject);
      });
      const answered = new Promise<{ behavior: string }>((resolve) => {
        let buf = "";
        conn.on("data", (c) => {
          buf += c;
          const nl = buf.indexOf("\n");
          if (nl !== -1) resolve(JSON.parse(buf.slice(0, nl)));
        });
      });
      conn.write(JSON.stringify({ t: "ask", id: "ask-squat", tool: "Bash", input: { command: "echo hi" } }) + "\n");
      await recorder.until((e) => e.type === "request.opened" && e.requestId === "ask-squat");
      await expect(instance.adapter.respondToRequest("t-perm-squat", "ask-squat", { behavior: "allow" })).resolves.toBe("allowed-once");
      expect(await answered).toMatchObject({ behavior: "allow" });
      conn.end();
      await instance.adapter.interruptTurn("t-perm-squat");
      await recorder.until((e) => e.type === "turn.completed");
    } finally {
      squatter.close();
    }
  });

  it("answers to unknown or already-resolved asks resolve `unavailable` — typed, never a throw", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: "t-perm-2", text: "go" });
    await expect(instance.adapter.respondToRequest("t-perm-2", "never-asked", { behavior: "allow" })).resolves.toBe("unavailable");
    await expect(instance.adapter.respondToRequest("no-such-thread", "x", { behavior: "deny" })).resolves.toBe("unavailable");
    await instance.adapter.interruptTurn("t-perm-2");
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("resolves a pending ask as a system denial when the turn is interrupted", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: "t-perm-stop", text: "go" });
    await recorder.until((e) => e.type === "session.started");

    const conn = connect(permissionSocketPath("t-perm-stop"));
    await new Promise<void>((resolve, reject) => {
      conn.on("connect", resolve);
      conn.on("error", reject);
    });
    conn.write(JSON.stringify({ t: "ask", id: "ask-stop", tool: "Bash", input: { command: "sleep 60" } }) + "\n");
    await recorder.until((e) => e.type === "request.opened" && e.requestId === "ask-stop");

    await instance.adapter.interruptTurn("t-perm-stop");
    const resolved = await recorder.until((e) => e.type === "request.resolved" && e.requestId === "ask-stop");
    expect(resolved).toMatchObject({ behavior: "deny", source: "system" });
    await recorder.until((e) => e.type === "turn.completed");
    conn.end();
  });

  it("denies a colliding ask id on the same connection without orphaning the original", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: COLLISION_THREAD_IDS[0], text: "go" });
    await recorder.until((e) => e.type === "session.started");

    const conn = await connectSocket(permissionSocketPath(COLLISION_THREAD_IDS[0]));
    const nextAnswer = answerQueue(conn);

    conn.write(JSON.stringify({ t: "ask", id: "dup-1", tool: "Bash", input: { command: "echo one" } }) + "\n");
    await recorder.until((e) => e.type === "request.opened" && e.requestId === "dup-1");
    conn.write(JSON.stringify({ t: "ask", id: "dup-1", tool: "Bash", input: { command: "echo two" } }) + "\n");

    expect(await nextAnswer()).toMatchObject({
      id: "dup-1",
      behavior: "deny",
      message: "OpenMausBot: duplicate ask id — skipping this request.",
    });
    expect(recorder.events.filter((e) => e.type === "request.opened" && e.requestId === "dup-1")).toHaveLength(1);

    await expect(instance.adapter.respondToRequest(COLLISION_THREAD_IDS[0], "dup-1", { behavior: "allow" })).resolves.toBe(
      "allowed-once",
    );
    expect(await nextAnswer()).toMatchObject({ behavior: "allow" });

    conn.end();
    await instance.adapter.interruptTurn(COLLISION_THREAD_IDS[0]);
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("denies a colliding ask id from a second connection on the same broker", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: COLLISION_THREAD_IDS[1], text: "go" });
    await recorder.until((e) => e.type === "session.started");

    const conn1 = await connectSocket(permissionSocketPath(COLLISION_THREAD_IDS[1]));
    conn1.write(JSON.stringify({ t: "ask", id: "dup-2", tool: "Bash", input: { command: "echo one" } }) + "\n");
    await recorder.until((e) => e.type === "request.opened" && e.requestId === "dup-2");

    const conn2 = await connectSocket(permissionSocketPath(COLLISION_THREAD_IDS[1]));
    const conn2Answer = answerQueue(conn2)();
    conn2.write(JSON.stringify({ t: "ask", id: "dup-2", tool: "Bash", input: { command: "echo two" } }) + "\n");
    expect(await conn2Answer).toMatchObject({
      id: "dup-2",
      behavior: "deny",
      message: "OpenMausBot: duplicate ask id — skipping this request.",
    });
    expect(recorder.events.filter((e) => e.type === "request.opened" && e.requestId === "dup-2")).toHaveLength(1);

    await expect(instance.adapter.respondToRequest(COLLISION_THREAD_IDS[1], "dup-2", { behavior: "allow" })).resolves.toBe(
      "allowed-once",
    );

    conn1.end();
    conn2.end();
    await instance.adapter.interruptTurn(COLLISION_THREAD_IDS[1]);
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("accepts an ask id reused after the original already resolved — not a collision", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: COLLISION_THREAD_IDS[2], text: "go" });
    await recorder.until((e) => e.type === "session.started");

    const conn = await connectSocket(permissionSocketPath(COLLISION_THREAD_IDS[2]));

    conn.write(JSON.stringify({ t: "ask", id: "dup-3", tool: "Bash", input: { command: "echo one" } }) + "\n");
    await recorder.until((e) => e.type === "request.opened" && e.requestId === "dup-3" && e.summary === "echo one");
    await expect(instance.adapter.respondToRequest(COLLISION_THREAD_IDS[2], "dup-3", { behavior: "allow" })).resolves.toBe(
      "allowed-once",
    );

    conn.write(JSON.stringify({ t: "ask", id: "dup-3", tool: "Bash", input: { command: "echo two" } }) + "\n");
    await recorder.until((e) => e.type === "request.opened" && e.requestId === "dup-3" && e.summary === "echo two");
    await expect(instance.adapter.respondToRequest(COLLISION_THREAD_IDS[2], "dup-3", { behavior: "allow" })).resolves.toBe(
      "allowed-once",
    );

    conn.end();
    await instance.adapter.interruptTurn(COLLISION_THREAD_IDS[2]);
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("denies a colliding ask id for question-kind asks too, without disturbing the original", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: COLLISION_THREAD_IDS[3], text: "go" });
    await recorder.until((e) => e.type === "session.started");

    const conn = await connectSocket(permissionSocketPath(COLLISION_THREAD_IDS[3]));
    const nextAnswer = answerQueue(conn);

    conn.write(JSON.stringify({ t: "ask", id: "dup-4", kind: "question", tool: "ask_user", input: { question: "one?" } }) + "\n");
    await recorder.until((e) => e.type === "request.opened" && e.requestId === "dup-4");
    conn.write(JSON.stringify({ t: "ask", id: "dup-4", kind: "question", tool: "ask_user", input: { question: "two?" } }) + "\n");

    expect(await nextAnswer()).toMatchObject({
      id: "dup-4",
      behavior: "deny",
      message: "OpenMausBot: duplicate ask id — skipping this request.",
    });
    expect(recorder.events.filter((e) => e.type === "request.opened" && e.requestId === "dup-4")).toHaveLength(1);

    await expect(
      instance.adapter.respondToRequest(COLLISION_THREAD_IDS[3], "dup-4", { behavior: "answer", message: "yes" }),
    ).resolves.toBe("answered");
    expect(await nextAnswer()).toMatchObject({ behavior: "answer" });

    conn.end();
    await instance.adapter.interruptTurn(COLLISION_THREAD_IDS[3]);
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("drops a late ask on an already-closed broker instead of a dead card (#211)", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: "t-perm-late", text: "go" });
    await recorder.until((e) => e.type === "session.started");

    const conn = await connectSocket(permissionSocketPath("t-perm-late"));
    const nextAnswer = answerQueue(conn);
    const initialReply = nextAnswer();
    conn.write(JSON.stringify({ t: "ask", id: "ask-ready", tool: "Bash", input: { command: "echo ready" } }) + "\n");
    // Windows can signal client connect before the server accepts the pipe.
    await recorder.until((e) => e.type === "request.opened" && e.requestId === "ask-ready");

    await instance.adapter.interruptTurn("t-perm-late");
    await expect(initialReply).resolves.toMatchObject({ id: "ask-ready", behavior: "deny" });
    await recorder.until((e) => e.type === "turn.completed");

    const opensBefore = recorder.events.filter((e) => e.type === "request.opened").length;
    const reply = nextAnswer();
    conn.write(JSON.stringify({ t: "ask", id: "ask-late", tool: "Bash", input: { command: "rm -rf /" } }) + "\n");

    expect(await reply).toMatchObject({
      id: "ask-late",
      behavior: "deny",
      message: "OpenMausBot: the turn ended",
    });
    expect(recorder.events.filter((e) => e.type === "request.opened")).toHaveLength(opensBefore);
    await expect(instance.adapter.respondToRequest("t-perm-late", "ask-late", { behavior: "allow" })).resolves.toBe(
      "unavailable",
    );

    conn.end();
  });

  it("drops a late question on an already-closed broker with an answer, not a deny (#211)", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: "t-question-late", text: "go" });
    await recorder.until((e) => e.type === "session.started");

    const conn = await connectSocket(permissionSocketPath("t-question-late"));
    const nextAnswer = answerQueue(conn);
    const initialReply = nextAnswer();
    conn.write(JSON.stringify({ t: "ask", kind: "question", id: "q-ready", tool: "ask_user", input: { question: "ready?" } }) + "\n");
    await recorder.until((e) => e.type === "request.opened" && e.requestId === "q-ready");

    await instance.adapter.interruptTurn("t-question-late");
    await expect(initialReply).resolves.toMatchObject({ id: "q-ready", behavior: "answer" });
    await recorder.until((e) => e.type === "turn.completed");

    const opensBefore = recorder.events.filter((e) => e.type === "request.opened").length;
    const reply = nextAnswer();
    conn.write(JSON.stringify({ t: "ask", kind: "question", id: "q-late", tool: "ask_user", input: { question: "still there?" } }) + "\n");

    expect(await reply).toMatchObject({
      id: "q-late",
      behavior: "answer",
      message: "OpenMausBot: the turn is ending — wrap up.",
    });
    expect(recorder.events.filter((e) => e.type === "request.opened")).toHaveLength(opensBefore);
    await expect(
      instance.adapter.respondToRequest("t-question-late", "q-late", { behavior: "answer", message: "yes" }),
    ).resolves.toBe("unavailable");

    conn.end();
  });

  it("passes effort to the CLI, and omits the flag when unset", async () => {
    await create();
    const dump = join(scratch, "effort.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-effort", text: "hi", effort: "xhigh" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv).toContain("--effort");
    expect(seen.argv[seen.argv.indexOf("--effort") + 1]).toBe("xhigh");
    expect(seen.argv.filter((a: string) => a === "--effort")).toHaveLength(1);
  });

  it("adds no effort flag when the turn has none", async () => {
    await create();
    const dump = join(scratch, "no-effort.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-no-effort", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv).not.toContain("--effort");
  });

  it("strips workspace credentials from generateText helper children", async () => {
    const instanceConfigDir = join(scratch, "instance-claude-config");
    await create(undefined, { CLAUDE_CONFIG_DIR: instanceConfigDir });
    const dump = join(scratch, "generate-text-env.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    const names = ["XAI_API_KEY", "COMPOSIO_API_KEY", "BOX_TOKEN", "OPENCODE_API_KEY", "OMB_TTS_KEY"] as const;
    for (const name of names) process.env[name] = `${name}-must-not-leak`;

    await expect(instance.generateText?.("summarize safely")).resolves.toBe("fake generated text");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.prompt).toBe("summarize safely");
    expect(seen.argv).not.toContain("summarize safely");
    expect(seen.argv[seen.argv.indexOf("--output-format") + 1]).toBe("text");
    expect(seen.env.CLAUDE_CONFIG_DIR).toBe(instanceConfigDir);
    for (const name of names) expect(seen.env[name]).toBeUndefined();
  });

  it.each(["medium", "low"] as const)("keeps same-provider permission review isolated at %s effort", async (effort) => {
    await create();
    const dump = join(scratch, "permission-review.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    await expect(instance.reviewPermission?.("review this request", { model: "claude-review-fixture", effort })).resolves.toBe("fake generated text");
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv[seen.argv.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(seen.argv[seen.argv.indexOf("--model") + 1]).toBe("claude-review-fixture");
    expect(seen.argv[seen.argv.indexOf("--effort") + 1]).toBe(effort);
    expect(seen.argv).toContain("--no-session-persistence");
    expect(seen.argv[seen.argv.indexOf("--tools") + 1]).toBe("");
    expect(seen.argv).toContain("--strict-mcp-config");
    expect(JSON.parse(seen.argv[seen.argv.indexOf("--mcp-config") + 1])).toEqual({ mcpServers: {} });
    expect(seen.argv[seen.argv.indexOf("--setting-sources") + 1]).toBe("");
    expect(seen.settings.disableAllHooks).toBe(true);
    expect(seen.argv).not.toContain("--resume");
  });

  it("runs helper calls tool-free and isolated, in an empty folder it then removes", async () => {
    await create(undefined, { FAKE_CLAUDE_VERSION: "2.1.296" });
    const dump = join(scratch, "isolated-helper.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    await expect(instance.generateText!("summarize")).resolves.toBe("fake generated text");
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv[seen.argv.indexOf("--tools") + 1]).toBe("");
    expect(seen.argv).toContain("--strict-mcp-config");
    expect(seen.argv[seen.argv.indexOf("--setting-sources") + 1]).toBe("project");
    expect(seen.argv).toContain("--no-session-persistence");
    expect(seen.cwd).toContain("omb-claude-background-");
    expect(existsSync(seen.cwd)).toBe(false);
  });

  it("reads the CLI version before a helper call, so an older CLI gets no --tools", async () => {
    await create(undefined, { FAKE_CLAUDE_VERSION: "2.1.250" });
    const dump = join(scratch, "older-helper.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    await expect(instance.generateText!("summarize")).resolves.toBe("fake generated text");
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv).not.toContain("--tools");
    expect(seen.argv).toContain("--strict-mcp-config");
  });

  it("waits as long as the caller says for a helper call, and no longer", async () => {
    await create(undefined, { FAKE_CLAUDE_TEXT_HANG: "1" });
    const started = Date.now();
    await expect(instance.generateText!("summarize", { timeoutMs: 300 })).rejects.toThrow("Claude review timed out");
    expect(Date.now() - started).toBeLessThan(BACKGROUND_CALL_TIMEOUT_MS);
  });

  it("passes only the background flags the installed CLI accepts", () => {
    const base = { model: "claude-haiku-4-5", outputFormat: "text" as const };
    const cli = (version: [number, number, number]) => (flag: Parameters<typeof claudeCliSupports>[1]) => claudeCliSupports(version, flag);
    expect(backgroundCallArgs({ ...base, supports: cli([2, 1, 296]), isolated: true })).toEqual([
      "-p", "--model", "claude-haiku-4-5", "--output-format", "text",
      "--tools", "", "--no-session-persistence", "--strict-mcp-config", "--setting-sources", "project",
    ]);
    // OMB_CLAUDE_INHERIT_USER_CONFIG keeps the person's own setup, still without tools
    expect(backgroundCallArgs({ ...base, supports: cli([2, 1, 296]), isolated: false })).not.toContain("--strict-mcp-config");
    expect(backgroundCallArgs({ ...base, supports: cli([1, 0, 100]), isolated: true })).toEqual([
      "-p", "--model", "claude-haiku-4-5", "--output-format", "text", "--strict-mcp-config",
    ]);
  });

  it("routes an unconfigured Claude reviewer through its supported minimum effort", async () => {
    await create(undefined, { FAKE_CLAUDE_REVIEW_TEXT: JSON.stringify({ decision: "allow", reason: "Scoped fixture read" }) });
    const dump = join(scratch, "default-review-effort.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    const selected = { instanceId: instance.instanceId, model: instance.models.default };
    const result = await reviewApproval({ action: { tool: "Read", arguments: { path: "/fixture/requested.txt" } },
      session: { ...selected, effort: "high" }, settings: { model: selected },
      messages: [{ id: "user", role: "user", kind: "text", text: "Read /fixture/requested.txt", at: 1 }],
      getProvider: () => instance, isCurrent: () => true });
    expect(result).toMatchObject({ decision: "allow", reviewer: { ...selected, effort: "low" } });
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv[seen.argv.indexOf("--effort") + 1]).toBe(result.reviewer?.effort);
    expect(instance.adapter.capabilities.effortLevels).toContain(result.reviewer?.effort);
    expect(seen.argv).not.toContain("none");
    expect(seen.settings.disableAllHooks).toBe(true);
    expect(seen.mcpConfig).toEqual({ mcpServers: {} });
  });

  it("rejects unsupported isolated reviewer effort before launching the CLI", async () => {
    await create();
    const dump = join(scratch, "unsupported-review-effort.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    await expect(instance.reviewPermission!("review this request", { model: instance.models.default, effort: "none" })).rejects.toThrow(/effort/);
    expect(existsSync(dump)).toBe(false);
  });

  it("never falls back to personal authentication for API-key-only helper calls", async () => {
    process.env.ANTHROPIC_API_KEY = "unselected-personal-key";
    await create(undefined, {}, { requireApiKey: true });
    const dump = join(scratch, "missing-api-key-helper.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await expect(instance.generateText!("summarize")).rejects.toThrow("No Anthropic API key");
    await expect(instance.reviewPermission!("review request", { model: instance.models.default })).rejects.toThrow("No Anthropic API key");
    await expect(instance.adapter.sendTurn({ threadId: "t-api-no-key", text: "hello" })).rejects.toThrow("No Anthropic API key");
    expect(existsSync(dump)).toBe(false);
  });

  it("uses the selected API key for API-key-only helper calls", async () => {
    await create(undefined, { ANTHROPIC_API_KEY: "selected-api-key" }, { requireApiKey: true });
    const dump = join(scratch, "api-key-helper.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await expect(instance.generateText!("summarize")).resolves.toBe("fake generated text");
    expect(JSON.parse(readFileSync(dump, "utf8")).env.ANTHROPIC_API_KEY).toBe("selected-api-key");
    await expect(instance.reviewPermission!("review request", { model: instance.models.default })).resolves.toBe("fake generated text");
    expect(JSON.parse(readFileSync(dump, "utf8")).env.ANTHROPIC_API_KEY).toBe("selected-api-key");
  });

  it("reports the actual one-shot model, total input, cached input and cost once", async () => {
    await create(undefined, { FAKE_CLAUDE_TEXT_RESULT: JSON.stringify({
      type: "result", result: "  captured memory  ", is_error: false,
      usage: { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 3, output_tokens: 5 },
      total_cost_usd: 0.004,
      modelUsage: { "claude-haiku-4-5-20251001": { costUSD: 0.004 } },
    }) });
    const dump = join(scratch, "text-usage.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    const onUsage = vi.fn();
    await expect(instance.generateText!("capture memory", { onUsage })).resolves.toBe("captured memory");
    expect(onUsage.mock.calls).toEqual([[{ model: "claude-haiku-4-5-20251001", input: 33, output: 5, cachedInput: 20, costUsd: 0.004 }]]);
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv[seen.argv.indexOf("--output-format") + 1]).toBe("json");
    expect(seen.argv[seen.argv.indexOf("--model") + 1]).toBe("claude-haiku-4-5");
    expect(recorder.events).toEqual([]);
  });

  it.each([
    [{}, undefined],
    [{ usage: { input_tokens: "12", output_tokens: -1 }, total_cost_usd: null }, undefined],
    [{ usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 }, total_cost_usd: 0 }, 0],
  ])("keeps missing usage unknown and preserves explicit zeroes (%j)", async (metadata, expected) => {
    await create(undefined, { FAKE_CLAUDE_TEXT_RESULT: JSON.stringify({ type: "result", result: "done", ...metadata }) }, { managedModels: ["managed-helper"] });
    const onUsage = vi.fn();
    await expect(instance.generateText!("summarize", { onUsage })).resolves.toBe("done");
    expect(onUsage.mock.calls).toEqual([[{ model: "managed-helper", input: expected, output: expected, cachedInput: expected, costUsd: expected }]]);
  });

  it.each([false, true])("reports usage before rejecting an error result (nonzero exit: %s)", async nonzeroExit => {
    const failureFile = join(scratch, "failure.txt");
    writeFileSync(failureFile, "__FAIL__");
    await create(undefined, {
      ...(nonzeroExit ? { FAKE_CLAUDE_TEXT_FILE: failureFile } : {}),
      FAKE_CLAUDE_TEXT_RESULT: JSON.stringify({ type: "result", is_error: true, result: "synthetic billed failure", total_cost_usd: 0.01 }),
    });
    const onUsage = vi.fn();
    await expect(instance.generateText!("summarize", { onUsage })).rejects.toThrow("synthetic billed failure");
    expect(onUsage.mock.calls).toEqual([[{ model: "claude-haiku-4-5", input: undefined, output: undefined, cachedInput: undefined, costUsd: 0.01 }]]);
  });

  it("writes a one-shot with the model a caller names, while permission review keeps its own", async () => {
    await create();
    const dump = join(scratch, "named-model.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    const model = () => {
      const seen = JSON.parse(readFileSync(dump, "utf8"));
      return seen.argv[seen.argv.indexOf("--model") + 1];
    };
    await expect(instance.generateText!("summarize", { model: "claude-haiku-5-5" })).resolves.toBe("fake generated text");
    expect(model()).toBe("claude-haiku-5-5");
    await expect(instance.generateText!("summarize")).resolves.toBe("fake generated text");
    expect(model()).toBe("claude-haiku-4-5");
    await expect(instance.reviewPermission!("review this request", { model: instance.models.default })).resolves.toBe("fake generated text");
    expect(model()).toBe(instance.models.default);
  });

  it.each(["not JSON", '{"type":"assistant"}'])("rejects malformed one-shot output without invented usage (%s)", async result => {
    await create(undefined, { FAKE_CLAUDE_TEXT_RESULT: result });
    const onUsage = vi.fn();
    await expect(instance.generateText!("summarize", { onUsage })).rejects.toThrow();
    expect(onUsage).not.toHaveBeenCalled();
  });

  it("stops the one-shot text call when its caller aborts mid-flight", async () => {
    await create();
    process.env.FAKE_CLAUDE_TEXT_HANG = "1";
    const controller = new AbortController();
    const onUsage = vi.fn();
    setTimeout(() => controller.abort(), 100);
    await expect(instance.generateText?.("summarize safely", { signal: controller.signal, onUsage }))
      .rejects.toThrow(/aborted/);
    expect(onUsage).not.toHaveBeenCalled();
  });

  it("stops permission review when its caller gives up", async () => {
    await create();
    const controller = new AbortController();
    controller.abort();
    await expect(instance.reviewPermission?.("review this request", { model: instance.models.default, signal: controller.signal })).rejects.toThrow(/aborted/);
  });

  it("declares the effort levels the CLI accepts", async () => {
    await create();
    expect(instance.adapter.capabilities.effortLevels).toEqual([
      "low", "medium", "high", "xhigh", "max",
    ]);
  });
});

    describe("ClaudeDriver resume recovery (fake CLI)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;

  const REBUILD = "[rebuild]\n\nUser: my dog is Biscuit\n\nwhat now?";

  beforeEach(async () => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "omb-claude-recover-"));
    process.env.FAKE_CLAUDE_MODE = "dead-session";
    instance = await ClaudeDriver.create({
      instanceId: "claude-test",
      displayName: "Claude Test",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, permissionMode: "auto" } as never,
    });
    recorder = recordEvents(instance.adapter);
  });

  afterEach(async () => {
    delete process.env.FAKE_CLAUDE_MODE;
    delete process.env.FAKE_CLAUDE_DUMP;
    delete process.env.FAKE_CLAUDE_PROMPTS;
    delete process.env.FAKE_CLAUDE_TEXT_HANG;
    recorder?.stop();
    await instance?.dispose();
    await removeTempDir(scratch);
  });
  const launches = (file: string) => readFileSync(file, "utf8").trim().split("\n").length;
  const promptText = (prompt: any) => {
    const content = prompt.message.content;
    return typeof content === "string" ? content : content.map((c: any) => c.text ?? "").join("");
  };

  it("starts a fresh session carrying the rebuild when --resume is refused", async () => {
    const dump = join(scratch, "recovered.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    const dispatch = await instance.adapter.sendTurn({
      threadId: "t-dead",
      text: "what now?",
      resumeCursor: "a-session-claude-no-longer-has",
      recoveryText: REBUILD,
    });
    await recorder.until((e) => e.type === "turn.completed");

    expect(recorder.events.filter((e) => e.type === "turn.completed").at(-1)).toMatchObject({ ok: true, turnId: dispatch.turnId });
    expect(recorder.events.some((e) => e.type === "turn.retrying")).toBe(false);
    const started = recorder.events.filter((e) => e.type === "session.started");
    expect(started.length).toBeGreaterThan(0);
    expect(started.at(-1)).not.toMatchObject({ sessionId: "a-session-claude-no-longer-has" });
    expect(started.at(-1)).toMatchObject({ rebuilt: true });
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv).not.toContain("--resume");
    const content = seen.prompt.message.content;
    const text = typeof content === "string" ? content : content.map((c: any) => c.text ?? "").join("");
    expect(text).toBe(REBUILD);
  });

  it("does not announce a replacement as rebuilt when there was nothing to replay", async () => {
    const dump = join(scratch, "no-replay.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    await instance.adapter.sendTurn({
      threadId: "t-no-replay",
      text: "what now?",
      resumeCursor: "a-session-claude-no-longer-has",
    });
    await recorder.until((e) => e.type === "turn.completed");
    const started = recorder.events.filter((e) => e.type === "session.started");
    expect(started.length).toBeGreaterThan(0);
    expect(started.at(-1)).not.toMatchObject({ rebuilt: true });
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv).not.toContain("--resume");
    const content = seen.prompt.message.content;
    expect(typeof content === "string" ? content : content.map((c: any) => c.text ?? "").join("")).toBe("what now?");
  });

  it("recovers only once, then fails visibly", async () => {
    process.env.FAKE_CLAUDE_MODE = "exit-early";
    const prompts = join(scratch, "prompts.jsonl");
    process.env.FAKE_CLAUDE_PROMPTS = prompts;
    await instance.adapter.sendTurn({ threadId: "t-always-dead", text: "what now?", resumeCursor: "gone", recoveryText: REBUILD });
    await recorder.until((e) => e.type === "turn.completed");
    expect(recorder.events.filter((e) => e.type === "turn.completed").at(-1)).toMatchObject({ ok: false });
    expect(launches(prompts)).toBe(2);
  });

  it("rebuilds a session the CLI answers with \"No conversation found\" instead of exiting", async () => {
    process.env.FAKE_CLAUDE_MODE = "stale-session";
    const dump = join(scratch, "stale.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    const prompts = join(scratch, "stale-prompts.jsonl");
    process.env.FAKE_CLAUDE_PROMPTS = prompts;
    const dispatch = await instance.adapter.sendTurn({
      threadId: "t-stale", text: "what now?", resumeCursor: "9de14760-idle-since-september", recoveryText: REBUILD,
    });
    await recorder.until((e) => e.type === "turn.completed");
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toEqual([expect.objectContaining({ ok: true, turnId: dispatch.turnId })]);
    expect(recorder.events.some((e) => e.type === "runtime.error")).toBe(false);
    expect(recorder.events.filter((e) => e.type === "session.started")).toEqual([
      expect.objectContaining({ rebuilt: true, sessionId: expect.not.stringMatching(/idle-since-september/) }),
    ]);
    const notices = () => recorder.events.filter((e) => e.type === "runtime.notice");
    expect(notices()).toEqual([expect.objectContaining({ message: rebuiltSessionNotice("Claude Code") })]);
    expect(launches(prompts)).toBe(2);
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv).not.toContain("--resume");
    expect(promptText(seen.prompt)).toBe(REBUILD);
    const rebuilt = recorder.events.find((e) => e.type === "session.started") as { sessionId: string };
    await instance.adapter.sendTurn({ threadId: "t-stale", text: "and then?", resumeCursor: rebuilt.sessionId, recoveryText: REBUILD });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId !== dispatch.turnId);
    expect(recorder.events.filter((e) => e.type === "session.started")).toEqual([
      expect.objectContaining({ rebuilt: true }),
      expect.not.objectContaining({ rebuilt: true }),
    ]);
    expect(notices()).toHaveLength(1);
  });

  it("says what failed when the fresh session ends in an error result too, after one rebuild", async () => {
    process.env.FAKE_CLAUDE_MODE = "error-result";
    const prompts = join(scratch, "error-prompts.jsonl");
    process.env.FAKE_CLAUDE_PROMPTS = prompts;
    await instance.adapter.sendTurn({ threadId: "t-error-result", text: "what now?", resumeCursor: "gone", recoveryText: REBUILD });
    await recorder.until((e) => e.type === "turn.completed");
    expect(launches(prompts)).toBe(2);
    expect(recorder.events.filter((e) => e.type === "runtime.error")).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/^No conversation found with session ID: /) }),
    ]);
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toEqual([
      expect.objectContaining({ ok: false, stopReason: "error_during_execution" }),
    ]);
  });

  it("never resends a turn the CLI accepted before dying", async () => {
    process.env.FAKE_CLAUDE_MODE = "resume-dies-after-init";
    const prompts = join(scratch, "accepted-prompts.jsonl");
    process.env.FAKE_CLAUDE_PROMPTS = prompts;
    await instance.adapter.sendTurn({ threadId: "t-accepted", text: "what now?", resumeCursor: "accepted-then-died", recoveryText: REBUILD });
    await recorder.until((e) => e.type === "turn.completed");
    expect(recorder.events.filter((e) => e.type === "turn.completed").at(-1)).toMatchObject({ ok: false });
    expect(launches(prompts)).toBe(1);
  });

  it("never treats a crash on a fresh launch as a refused resume", async () => {
    process.env.FAKE_CLAUDE_MODE = "exit-early";
    const prompts = join(scratch, "fresh-crash-prompts.jsonl");
    process.env.FAKE_CLAUDE_PROMPTS = prompts;
    await instance.adapter.sendTurn({ threadId: "t-fresh-crash", text: "what now?", recoveryText: REBUILD });
    await recorder.until((e) => e.type === "turn.completed");
    expect(recorder.events.filter((e) => e.type === "turn.completed").at(-1)).toMatchObject({ ok: false });
    expect(launches(prompts)).toBe(1);
  });

  it("does not rebuild when there was no session to resume", async () => {
    process.env.FAKE_CLAUDE_MODE = "happy";
    const dump = join(scratch, "fresh.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    await instance.adapter.sendTurn({ threadId: "t-fresh", text: "what now?", recoveryText: REBUILD });
    await recorder.until((e) => e.type === "turn.completed");
    expect(recorder.events.filter((e) => e.type === "turn.completed").at(-1)).toMatchObject({ ok: true });
    expect(recorder.events.some((e) => e.type === "turn.retrying")).toBe(false);
    const content = JSON.parse(readFileSync(dump, "utf8")).prompt.message.content;
    const text = typeof content === "string" ? content : content.map((c: any) => c.text ?? "").join("");
    expect(text).toBe("what now?");
  });
});

describe("ClaudeDriver snapshot auth (fake CLI)", () => {
  let instance: ProviderInstance;

  const create = async () => {
    instance = await ClaudeDriver.create({
      instanceId: "claude-auth-test",
      displayName: "Claude Auth Test",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, permissionMode: "acceptEdits" },
    });
  };

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
  });

  afterEach(async () => {
    delete process.env.FAKE_CLAUDE_AUTH;
    delete process.env.ANTHROPIC_API_KEY;
    await instance?.dispose();
  });

  it("reports authenticated when `auth status` says loggedIn", async () => {
    process.env.FAKE_CLAUDE_AUTH = "in";
    await create();
    expect(await instance.snapshot()).toMatchObject({ state: "available", authenticated: true });
  });

  it("reports signed out when `auth status` says loggedIn:false", async () => {
    process.env.FAKE_CLAUDE_AUTH = "out";
    await create();
    expect(await instance.snapshot()).toMatchObject({ state: "available", authenticated: false });
  });

  it("fails closed instead of trusting stale credential storage", async () => {
    await create();

    process.env.FAKE_CLAUDE_AUTH = "unsupported";
    expect(await instance.snapshot()).toMatchObject({ state: "available", authenticated: false });

    process.env.FAKE_CLAUDE_AUTH = "malformed";
    expect(await instance.snapshot()).toMatchObject({ state: "available", authenticated: false });

    process.env.FAKE_CLAUDE_AUTH = "inherited-api-key";
    process.env.ANTHROPIC_API_KEY = "sk-should-not-leak";
    expect(await instance.snapshot()).toMatchObject({ state: "available", authenticated: false });
  });
});

describe("ClaudeDriver billing (fake CLI)", () => {
  const instances: ProviderInstance[] = [];
  const KEY = { billing: "metered", method: "api-key" };
  const LOGIN = { billing: "subscription", method: null };
  const NO_KEY = { unavailable: "No Anthropic API key — open Settings → API keys." };

  const billed = async (id: "claude" | "claudeApi", anthropic: AppConfig["anthropic"]) => {
    const entry = instanceConfigs({ anthropic })[id]!;
    const instance = await ClaudeDriver.create({
      instanceId: id,
      displayName: id,
      enabled: true,
      config: ClaudeDriver.decodeConfig({ ...(entry.config as object | undefined), cli: FAKE_CLI }),
      environment: entry.environment as Record<string, string>,
    });
    instances.push(instance);
    const snapshot = await instance.snapshot();
    return snapshot.state === "available"
      ? { billing: snapshot.billing, method: snapshot.account?.method ?? null }
      : { unavailable: snapshot.reason };
  };

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
  });

  afterEach(async () => {
    delete process.env.FAKE_CLAUDE_AUTH;
    vi.unstubAllEnvs();
    await Promise.all(instances.splice(0).map((instance) => instance.dispose()));
  });

  it.each([
    { every: "on", anthropic: { key: "sk-ant-fixture", everyClaudeBot: true }, claude: KEY, claudeApi: KEY },
    { every: "unset", anthropic: { key: "sk-ant-fixture" }, claude: KEY, claudeApi: KEY },
    { every: "off", anthropic: { key: "sk-ant-fixture", everyClaudeBot: false }, claude: LOGIN, claudeApi: KEY },
    { every: "on, no key", anthropic: { everyClaudeBot: true }, claude: LOGIN, claudeApi: NO_KEY },
    { every: "unset, no key", anthropic: {}, claude: LOGIN, claudeApi: NO_KEY },
    { every: "off, no key", anthropic: { everyClaudeBot: false }, claude: LOGIN, claudeApi: NO_KEY },
  ])("bills each Claude bot on what its turns run on, signed in to claude.ai with every Claude bot $every", async ({ anthropic, claude, claudeApi }) => {
    expect(await billed("claude", anthropic), "plain Claude").toEqual(claude);
    expect(await billed("claudeApi", anthropic), "Claude (API key)").toEqual(claudeApi);
  });

  it("bills a CLI signed in on its own API key per token", async () => {
    process.env.FAKE_CLAUDE_AUTH = "api-key";
    expect(await billed("claude", {})).toEqual(KEY);
  });

  it("never bills on a key the server inherited, which turns strip", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-inherited");
    expect(await billed("claude", {})).toEqual(LOGIN);
  });
});
