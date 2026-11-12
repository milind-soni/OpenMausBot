// Codex driver contract tests, run against the scripted fake app-server
// in server/testing/fake-codex-app-server.ts — the driver must drive the
// JSON-RPC handshake, normalize notifications into canonical events, and
// surface server->client approval requests as request.opened.
//
// Spawn-based tests are POSIX-only until Windows CLI spawning lands (the
// fake is a shebang script — same constraint as codex.cmd itself).
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ProviderInstance } from "../contracts.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { CodexDriver } from "./codex.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-codex-app-server.ts");
const posixOnly = describe.skipIf(process.platform === "win32");

describe("CodexDriver.decodeConfig", () => {
  it("defaults to the codex binary with fullAuto off", () => {
    expect(CodexDriver.decodeConfig({})).toEqual({ cli: "codex", fullAuto: false });
    expect(CodexDriver.decodeConfig(undefined)).toEqual({ cli: "codex", fullAuto: false });
    expect(CodexDriver.decodeConfig({ fullAuto: true }).fullAuto).toBe(true);
    // anything non-true is off — a truthy string must not enable full auto
    expect(CodexDriver.decodeConfig({ fullAuto: "yes" }).fullAuto).toBe(false);
  });
});

describe("CodexDriver auto-approve toggle", () => {
  it("passes through fullAuto directly", () => {
    const off = CodexDriver.decodeConfig({});
    expect(CodexDriver.getAutoApprove!(off)).toBe(false);
    const on = CodexDriver.setAutoApprove!(off, true);
    expect(on.fullAuto).toBe(true);
    expect(CodexDriver.getAutoApprove!(on)).toBe(true);
    expect(CodexDriver.getAutoApprove!(CodexDriver.setAutoApprove!(on, false))).toBe(false);
  });
});

posixOnly("CodexDriver turns (fake app-server)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;

  const create = async (opts: { mode?: string; fullAuto?: boolean } = {}) => {
    if (opts.mode) process.env.FAKE_CODEX_MODE = opts.mode;
    instance = await CodexDriver.create({
      instanceId: "codex-test",
      displayName: "Codex Test",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: opts.fullAuto ?? false },
    });
    recorder = recordEvents(instance.adapter);
  };

  beforeEach(() => {
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "omb-codex-test-"));
  });

  afterEach(async () => {
    delete process.env.FAKE_CODEX_MODE;
    delete process.env.FAKE_CODEX_DUMP;
    delete process.env.FAKE_CODEX_MCP_SERVER;
    delete process.env.OPENAI_API_KEY;
    recorder?.stop();
    await instance?.dispose();
    rmSync(scratch, { recursive: true, force: true });
  });

  it("reads idle usage without creating a thread or sending a model prompt", async () => {
    await create();
    const dump = join(scratch, "usage.json");
    process.env.FAKE_CODEX_DUMP = dump;
    await instance.adapter.refreshUsage!();
    expect(await recorder.until(e => e.type === "usage.updated")).toMatchObject({ usage: { source: "reported", status: "ok" } });
    const calls = JSON.parse(readFileSync(dump, "utf8")).calls.map((c: { method: string }) => c.method);
    expect(calls).toEqual(["initialize", "initialized", "account/rateLimits/read"]);
    expect(recorder.events.some(e => e.type === "turn.started")).toBe(false);
  });

  it("keeps unavailable account reads unknown without failing a conversation", async () => {
    process.env.FAKE_CODEX_MODE = "usage-unavailable";
    await create();
    await instance.adapter.refreshUsage!();
    expect(await recorder.until(e => e.type === "usage.updated")).toMatchObject({ usage: { status: "unknown" } });
    await instance.adapter.sendTurn({ threadId: "usage-unsupported", text: "hi" });
    expect(await recorder.until(e => e.type === "turn.completed")).toMatchObject({ ok: true });
  });

  it("emits normalized usage failures from failed turns and rolling account updates", async () => {
    process.env.FAKE_CODEX_MODE = "usage-limit";
    await create();
    await instance.adapter.sendTurn({ threadId: "usage-exhausted", text: "hi" });
    const done = await recorder.until(e => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: false, failure: { kind: "usage_limit" } });
    expect(recorder.events).toContainEqual(expect.objectContaining({ type: "runtime.error", failure: { kind: "usage_limit" } }));
    expect(recorder.events).toContainEqual(expect.objectContaining({ type: "usage.updated", usage: expect.objectContaining({ windows: expect.arrayContaining([expect.objectContaining({ remainingPercent: 0 })]) }) }));
  });

  it("runs the handshake and normalizes a full turn", async () => {
    await create();
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CODEX_DUMP = dump;
    process.env.OPENAI_API_KEY = "sk-should-not-leak";

    const { turnId } = await instance.adapter.sendTurn({
      threadId: "t-happy",
      text: "list files",
      system: "You are Testy.",
    });
    await recorder.until((e) => e.type === "turn.completed");

    const types = recorder.events.map((e) => e.type);
    expect(types).toEqual([
      "turn.started",
      "usage.updated",
      "session.started",
      "item.started", // commandExecution ls -la
      "item.completed", // commandExecution done
      "content.delta",
      "item.completed", // assistant_text
      "thread.token-usage.updated",
      "turn.completed",
    ]);
    expect(recorder.events.every((e) => e.turnId === turnId && e.provider === "codex")).toBe(true);
    expect(recorder.events.find((e) => e.type === "session.started")).toMatchObject({
      sessionId: "codex-thread-1",
      model: "fake-codex-model",
    });
    expect(recorder.events.find((e) => e.type === "thread.token-usage.updated")).toMatchObject({
      input: 7,
      output: 3,
    });
    expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: true });

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.env.OPENAI_API_KEY).toBeUndefined();
    const methods = seen.calls.map((c: { method: string }) => c.method);
    expect(methods).toEqual(["initialize", "initialized", "account/rateLimits/read", "thread/start", "turn/start"]);
    // persona rides in front of the prompt text — codex has no system slot
    const turnStart = seen.calls.at(-1);
    expect(turnStart.params.input[0].text).toBe("You are Testy.\n\nlist files");
  });

  it("passes the agents-proxy integration to app-server as a TOML -c override, not a persisted config", async () => {
    await create();
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-agents",
      text: "check the board",
      integrations: {
        agents: {
          command: "/usr/bin/node",
          args: ["/path/to/agents-proxy.ts"],
          env: { GBS_HARNESS_URL: "http://127.0.0.1:8899", GBS_BOT_ID: "bot-1", GBS_COMMS_TOKEN: "secret-token", GBS_TURN_DEPTH: "0" },
        },
      },
    });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv[0]).toBe("app-server");
    const overrides: string[] = [];
    for (let i = 0; i < seen.argv.length - 1; i++) {
      if (seen.argv[i] === "-c") overrides.push(seen.argv[i + 1]);
    }
    expect(overrides).toEqual([
      'mcp_servers.gbs_agents.command="/usr/bin/node"',
      'mcp_servers.gbs_agents.args=["/path/to/agents-proxy.ts"]',
      'mcp_servers.gbs_agents.env={GBS_HARNESS_URL="http://127.0.0.1:8899",GBS_BOT_ID="bot-1",GBS_COMMS_TOKEN="secret-token",GBS_TURN_DEPTH="0"}',
    ]);
  });

  it("omits the -c overrides entirely when no agents integration is given", async () => {
    await create();
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-no-agents", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv).toEqual(["app-server"]);
  });

  it("streams agentMessage deltas without re-emitting the settled text", async () => {
    process.env.FAKE_CODEX_MODE = "stream";
    await create();
    await instance.adapter.sendTurn({ threadId: "t-stream", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const text = recorder.events.filter(
      (e: any) => e.type === "content.delta" && e.streamKind === "assistant_text",
    );
    // the two streamed chunks only — no third whole-message fallback delta
    expect(text.map((d: any) => d.delta)).toEqual(["done from ", "fake codex"]);
    const settled = recorder.events.filter(
      (e: any) => e.type === "item.completed" && e.itemType === "assistant_text",
    );
    expect(settled).toHaveLength(1);
    expect((settled[0] as any).text).toBe("done from fake codex");
  });

  it("tries thread/resume with a cursor and reuses the thread id", async () => {
    await create({ mode: "resume" });
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-resume", text: "again", resumeCursor: "codex-thread-9" });
    const started = await recorder.until((e) => e.type === "session.started");
    expect(started).toMatchObject({ sessionId: "codex-thread-9" });
    await recorder.until((e) => e.type === "turn.completed");

    const methods = JSON.parse(readFileSync(dump, "utf8")).calls.map((c: { method: string }) => c.method);
    expect(methods).toContain("thread/resume");
    expect(methods).not.toContain("thread/start");
  });

  it("falls back to a fresh thread when resume fails", async () => {
    await create(); // fake rejects thread/resume outside resume mode
    await instance.adapter.sendTurn({ threadId: "t-fallback", text: "go", resumeCursor: "gone-thread" });
    const started = await recorder.until((e) => e.type === "session.started");
    expect(started).toMatchObject({ sessionId: "codex-thread-1" });
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("surfaces an approval request and forwards the user's decision", async () => {
    await create({ mode: "approval" });
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-approve", text: "clean up" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({ requestType: "permission", tool: "shell", summary: "rm -rf scratch" });

    await instance.adapter.respondToRequest("t-approve", opened.requestId!, { behavior: "allow" });
    const resolved = await recorder.until((e) => e.type === "request.resolved");
    expect(resolved).toMatchObject({ behavior: "allow", source: "user" });

    await recorder.until((e) => e.type === "turn.completed");
    // legacy method name → legacy decision vocabulary
    expect(JSON.parse(readFileSync(dump, "utf8")).decision).toEqual({ decision: "approved" });
  });

  it("auto-approves commands in fullAuto without opening a request", async () => {
    await create({ mode: "approval", fullAuto: true });
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-auto", text: "clean up" });
    await recorder.until((e) => e.type === "turn.completed");

    expect(recorder.events.some((e) => e.type === "request.opened")).toBe(false);
    expect(JSON.parse(readFileSync(dump, "utf8")).decision).toEqual({ decision: "approved" });
  });

  it("pre-approves tool calls from the agents MCP server with an elicitation result", async () => {
    await create({ mode: "mcp-approval" });
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-mcp-agents", text: "check the board" });
    await recorder.until((e) => e.type === "turn.completed");

    expect(recorder.events.some((e) => e.type === "request.opened")).toBe(false);
    expect(JSON.parse(readFileSync(dump, "utf8")).decision).toEqual({ action: "accept", content: {} });
  });

  it("asks before another MCP server's tool call and declines in elicitation form", async () => {
    process.env.FAKE_CODEX_MCP_SERVER = "someone_else";
    await create({ mode: "mcp-approval" });
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-mcp-other", text: "go" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({ requestType: "permission", tool: "mcp" });

    await instance.adapter.respondToRequest("t-mcp-other", opened.requestId!, { behavior: "deny" });
    await recorder.until((e) => e.type === "turn.completed");
    expect(JSON.parse(readFileSync(dump, "utf8")).decision).toEqual({ action: "decline", content: null });
  });

  it("rejects a second turn while one is in flight", async () => {
    await create({ mode: "approval" }); // approval mode parks the turn open
    await instance.adapter.sendTurn({ threadId: "t-busy", text: "one" });
    await recorder.until((e) => e.type === "request.opened");
    await expect(instance.adapter.sendTurn({ threadId: "t-busy", text: "two" })).rejects.toThrow(/already running/);
    await instance.adapter.interruptTurn("t-busy");
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("a missing binary surfaces as a failed turn, and snapshot says unavailable", async () => {
    instance = await CodexDriver.create({
      instanceId: "codex-missing",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: join(scratch, "does-not-exist"), fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({ threadId: "t-missing", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: false });
    expect(await instance.snapshot()).toMatchObject({ state: "unavailable" });
  });
});
