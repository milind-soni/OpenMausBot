// Claude driver contract tests, run against the scripted fake CLI in
// server/testing/fake-claude-cli.ts — the driver must normalize the
// stream-json protocol into canonical events, keep argv hygiene (prompt
// over stdin, secrets stripped), and broker permission asks.
//
// Spawn-based tests are POSIX-only until Windows CLI spawning lands: the
// fake CLI is a shebang script, which Windows cannot exec directly (the
// same reason claude.cmd needs special handling — see the Windows PRs).
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR, ensureDirs } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { ClaudeDriver } from "./claude.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-claude-cli.ts");
const posixOnly = describe.skipIf(process.platform === "win32");

describe("ClaudeDriver.decodeConfig", () => {
  it("defaults to the claude binary with acceptEdits", () => {
    expect(ClaudeDriver.decodeConfig({})).toEqual({ cli: "claude", permissionMode: "acceptEdits" });
    expect(ClaudeDriver.decodeConfig(undefined)).toEqual({ cli: "claude", permissionMode: "acceptEdits" });
  });

  it("accepts the three known permission modes", () => {
    for (const permissionMode of ["acceptEdits", "auto", "bypassPermissions"] as const) {
      expect(ClaudeDriver.decodeConfig({ permissionMode }).permissionMode).toBe(permissionMode);
    }
  });

  it("throws on an invalid permissionMode (registry downgrades this to a shadow)", () => {
    expect(() => ClaudeDriver.decodeConfig({ permissionMode: "yolo" })).toThrow(/permissionMode/);
  });
});

describe("ClaudeDriver auto-approve toggle", () => {
  it("reports the effective permission mode, including the root fallback", () => {
    expect(ClaudeDriver.getAutoApprove!(ClaudeDriver.decodeConfig({ permissionMode: "bypassPermissions" }))).toBe(process.getuid?.() !== 0);
    expect(ClaudeDriver.getAutoApprove!(ClaudeDriver.decodeConfig({ permissionMode: "acceptEdits" }))).toBe(false);
    expect(ClaudeDriver.getAutoApprove!(ClaudeDriver.decodeConfig({ permissionMode: "auto" }))).toBe(false);
  });

  it("round-trips through setAutoApprove", () => {
    const base = ClaudeDriver.decodeConfig({});
    const on = ClaudeDriver.setAutoApprove!(base, true);
    expect(on.permissionMode).toBe("bypassPermissions");
    expect(ClaudeDriver.getAutoApprove!(on)).toBe(process.getuid?.() !== 0);
    const off = ClaudeDriver.setAutoApprove!(on, false);
    expect(off.permissionMode).toBe("acceptEdits");
    expect(ClaudeDriver.getAutoApprove!(off)).toBe(false);
  });
});

posixOnly("ClaudeDriver turns (fake CLI)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;

  const create = async (mode?: string) => {
    if (mode) process.env.FAKE_CLAUDE_MODE = mode;
    instance = await ClaudeDriver.create({
      instanceId: "claude-test",
      displayName: "Claude Test",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, permissionMode: "acceptEdits" },
    });
    recorder = recordEvents(instance.adapter);
  };

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "omb-claude-test-"));
  });

  afterEach(async () => {
    delete process.env.FAKE_CLAUDE_MODE;
    delete process.env.FAKE_CLAUDE_DUMP;
    delete process.env.ANTHROPIC_API_KEY;
    recorder?.stop();
    await instance?.dispose();
    rmSync(scratch, { recursive: true, force: true });
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
      "item.completed", // assistant_text
      "item.started", // tool tu-1
      "thread.token-usage.updated",
      "item.completed", // tool tu-1 result
      "turn.completed",
    ]);
    expect(recorder.events.every((e) => e.turnId === turnId && e.provider === "claudeAgent")).toBe(true);

    const usage = recorder.events.find((e) => e.type === "thread.token-usage.updated")!;
    expect(usage).toMatchObject({ input: 12, output: 5 }); // input + cache_read
    const done = recorder.events.at(-1)!;
    expect(done).toMatchObject({ type: "turn.completed", ok: true, cost: 0.01 });
    expect(instance.adapter.hasSession("t-happy")).toBe(false);
  });

  it("streams partial-message text deltas without re-emitting the whole message", async () => {
    await create("stream");
    await instance.adapter.sendTurn({ threadId: "t-stream", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const deltas = recorder.events.filter((e) => e.type === "content.delta");
    const text = deltas.filter((d: any) => d.streamKind === "assistant_text");
    // two streamed chunks, and NO third full-text fallback delta after them
    expect(text.map((d: any) => d.delta)).toEqual(["hello from ", "fake claude"]);
    // subagent narration (parent_tool_use_id) never surfaces
    expect(text.some((d: any) => d.delta.includes("SUBAGENT"))).toBe(false);
    // reasoning streams on its own kind
    expect(deltas.some((d: any) => d.streamKind === "reasoning_text" && d.delta === "hmm")).toBe(true);
    // the settled message still lands exactly once
    const settled = recorder.events.filter((e: any) => e.type === "item.completed" && e.itemType === "assistant_text");
    expect(settled).toHaveLength(1);
    expect((settled[0] as any).text).toBe("hello from fake claude");
  });

  it("sends the prompt over stdin, never argv, and strips identity env vars", async () => {
    await create();
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    process.env.ANTHROPIC_API_KEY = "sk-should-not-leak";

    await instance.adapter.sendTurn({ threadId: "t-hygiene", text: "the secret prompt", system: "You are Testy." });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(JSON.stringify(seen.argv)).not.toContain("the secret prompt");
    expect(seen.prompt).toMatchObject({ type: "user", message: { role: "user", content: "the secret prompt" } });
    expect(seen.argv).toContain("--append-system-prompt");
    expect(seen.argv).toContain("--session-id");
    expect(seen.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(seen.env.CLAUDECODE).toBeUndefined();
    expect(seen.env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
  });

  it("uses prompted permissions for bypass config under root and keeps the broker active", async () => {
    instance = await ClaudeDriver.create({
      instanceId: "claude-root-mode",
      displayName: "Claude Test",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, permissionMode: "bypassPermissions" },
    });
    recorder = recordEvents(instance.adapter);
    const dump = join(scratch, "permissions.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    await instance.adapter.sendTurn({ threadId: "t-mode", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const argv: string[] = JSON.parse(readFileSync(dump, "utf8")).argv;
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe(process.getuid?.() === 0 ? "acceptEdits" : "bypassPermissions");
    expect(argv.includes("--permission-prompt-tool")).toBe(process.getuid?.() === 0);
  });

  it("keeps local computer tools and connected apps mounted together", async () => {
    await create();
    const dump = join(scratch, "integrations.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    const localComputer = { command: "desktop-bridge", args: ["mcp"], env: { CUA_SOCKET: "local-socket" } };
    await instance.adapter.sendTurn({
      threadId: "t-local-computer", text: "hi",
      integrations: { localComputer, composio: { key: "test-connected-app-key" } },
    });
    await recorder.until(e => e.type === "turn.completed");
    const { argv } = JSON.parse(readFileSync(dump, "utf8"));
    const { mcpServers } = JSON.parse(argv[argv.indexOf("--mcp-config") + 1]);
    expect(mcpServers.computer).toEqual(localComputer);
    expect(mcpServers.composio.headers).toEqual({ "x-consumer-api-key": "test-connected-app-key" });
    expect(argv[argv.indexOf("--allowedTools") + 1]).toContain("mcp__computer");
    expect(argv[argv.indexOf("--allowedTools") + 1]).toContain("mcp__composio");
  });

  it("mounts the agents comms proxy as an MCP server and pre-allows its tools", async () => {
    await create();
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-agents",
      text: "hi",
      integrations: {
        agents: {
          command: process.execPath,
          args: ["/fake/agents-proxy.js"],
          env: { GBS_HARNESS_URL: "http://127.0.0.1:1", GBS_BOT_ID: "b1", GBS_COMMS_TOKEN: "tok", GBS_TURN_DEPTH: "0" },
        },
      },
    });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    const mcpConfig = JSON.parse(seen.argv[seen.argv.indexOf("--mcp-config") + 1]);
    expect(mcpConfig.mcpServers.agents).toMatchObject({
      args: ["/fake/agents-proxy.js"],
      env: { GBS_BOT_ID: "b1", GBS_COMMS_TOKEN: "tok" },
    });
    const allowed = seen.argv[seen.argv.indexOf("--allowedTools") + 1];
    expect(allowed).toContain("mcp__agents");
  });

  it("resumes with --resume when a cursor exists and reports that session id", async () => {
    await create();
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-resume", text: "again", resumeCursor: "sess-123" });
    const started = await recorder.until((e) => e.type === "session.started");
    expect(started).toMatchObject({ sessionId: "sess-123" });

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv).toContain("--resume");
    expect(seen.argv).not.toContain("--session-id");
  });

  it("rejects a second turn while one is in flight", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: "t-busy", text: "one" });
    await expect(instance.adapter.sendTurn({ threadId: "t-busy", text: "two" })).rejects.toThrow(/already running/);
    expect(instance.adapter.hasSession("t-busy")).toBe(true);
    await instance.adapter.interruptTurn("t-busy");
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("interrupt kills the turn and settles it as failed, not hung", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: "t-int", text: "go" });
    await recorder.until((e) => e.type === "session.started");

    await instance.adapter.interruptTurn("t-int");
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: false, stopReason: "exit_before_result" });
  });

  it("an exit before result becomes runtime.error + failed turn", async () => {
    await create("exit-early");
    await instance.adapter.sendTurn({ threadId: "t-crash", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");

    expect(done).toMatchObject({ ok: false, stopReason: "exit_before_result" });
    const error = recorder.events.find((e) => e.type === "runtime.error")!;
    expect(error.message).toContain("simulated crash");
  });

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

  it("brokers a permission ask into request.opened and answers over the socket", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: "t-perm-abc", text: "go" });
    await recorder.until((e) => e.type === "session.started");

    // connect as the MCP proxy would and raise an ask (same tag rule as
    // permissionSocketPath in claude.ts)
    const tag = "t-perm-abc".replace(/[^\w-]/g, "").slice(0, 8);
    const socketPath = join(DATA_DIR, `perm-${tag}.sock`);
    const conn = connect(socketPath);
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

    await instance.adapter.respondToRequest("t-perm-abc", "ask-1", { behavior: "allow" });
    expect(await answered).toMatchObject({ behavior: "allow" });
    const resolved = await recorder.until((e) => e.type === "request.resolved");
    expect(resolved).toMatchObject({ behavior: "allow", source: "user" });

    conn.end();
    await instance.adapter.interruptTurn("t-perm-abc");
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("rejects answers to unknown or already-resolved asks", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: "t-perm-2", text: "go" });
    await expect(
      instance.adapter.respondToRequest("t-perm-2", "never-asked", { behavior: "allow" }),
    ).rejects.toThrow(/pending request/);
    await instance.adapter.interruptTurn("t-perm-2");
    await recorder.until((e) => e.type === "turn.completed");
  });
});
