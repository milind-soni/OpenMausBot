import { chmodSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDirs } from "../config.ts";
import type { ProviderInstance, SendTurnInput } from "../contracts.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { ClaudeDriver } from "./claude.ts";
import { claudePrestartTools } from "./claude-prestart.ts";
import { PRESTART_IDLE_MS, armedIdleCount } from "./session-idle.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-claude-cli.ts");

const lines = (path: string): any[] => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(check: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("asking a started process to list its tools again", () => {
  it("asks only for the servers that list through the harness, and is done when each answers", async () => {
    const sent: any[] = [];
    const tools = claudePrestartTools().forProcess(async (frame) => { sent.push(frame); return true; });
    expect(sent.splice(0)).toEqual([{ type: "control_request", request_id: "prestart-ready", request: { subtype: "mcp_status" } }]);
    expect(tools.ready).toBe(false);
    expect(tools.frame({ type: "control_response", response: { subtype: "error", request_id: "prestart-ready", error_code: "unsupported_request" } })).toBe(true);
    expect(tools.ready).toBe(true);
    const done = tools.relist(["agents", "data", "ogb", "email"]);
    expect(sent.map((frame) => frame.request)).toEqual([{ subtype: "mcp_reconnect", serverName: "data" }, { subtype: "mcp_reconnect", serverName: "email" }]);
    expect(tools.frame({ type: "control_response", response: { subtype: "success", request_id: "someone-else" } })).toBe(false);
    for (const frame of sent) expect(tools.frame({ type: "control_response", response: { subtype: "success", request_id: frame.request_id } })).toBe(true);
    expect(await done).toBe(true);
    expect(await tools.relist(["agents", "ogb"])).toBe(true);
  });

  it("is not usable after a failure, a frame that never left, a close, or a CLI that does not know the request", async () => {
    const sent: any[] = [];
    const engine = claudePrestartTools();
    const tools = engine.forProcess(async (frame) => { sent.push(frame); return true; });
    sent.splice(0);
    const failed = tools.relist(["data"]);
    tools.frame({ type: "control_response", response: { subtype: "error", request_id: sent[0].request_id, error: "Server not connected" } });
    expect(await failed).toBe(false);
    expect(engine.usable).toBe(true);
    expect(await engine.forProcess(async () => false).relist(["data"])).toBe(false);
    const closed = tools.relist(["device"]);
    tools.close();
    expect(await closed).toBe(false);
    const unknown = tools.relist(["data"]);
    tools.frame({ type: "control_response", response: { subtype: "error", request_id: sent.at(-1).request_id, error_code: "unsupported_request" } });
    expect(await unknown).toBe(false);
    expect(engine.usable).toBe(false);
  });

  it("gives up on a server that never answers", async () => {
    vi.useFakeTimers();
    try {
      const waiting = claudePrestartTools().forProcess(async () => true, 3_000).relist(["data"]);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await waiting).toBe(false);
    } finally { vi.useRealTimers(); }
  });
});

describe("ClaudeDriver: a process started before the first message (fake CLI)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;
  let launches: string, prompts: string, relists: string;
  const halves = { system: "You are Testy.\n\nYour memory:\nlikes tea", systemStable: "You are Testy.", systemVolatile: "Your memory:\nlikes tea" };
  const turn = (threadId: string, extra: Partial<SendTurnInput> = {}): SendTurnInput => ({ threadId, botId: "b1", text: "hi", model: "claude-sonnet-5", ...halves, ...extra });
  const pids = () => lines(launches).map((launch) => launch.pid as number);
  /** Launched, and running far enough to have said so: `count` processes in all so far. */
  const started = async (threadId: string, count: number, extra: Partial<SendTurnInput> = {}) => {
    const launched = await instance.adapter.prestart!.start(turn(threadId, { text: "", ...extra }));
    if (launched) await until(() => pids().length >= count && instance.adapter.prestart!.ready(threadId), `process ${count} to start up`);
    return launched;
  };
  const create = async (environment: Record<string, string> = {}) => {
    instance = await ClaudeDriver.create({ instanceId: "claude-prestart", displayName: "Claude", environment, enabled: true, config: { cli: FAKE_CLI, permissionMode: "acceptEdits" } });
    recorder = recordEvents(instance.adapter);
  };

  beforeEach(async () => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "omb-prestart-test-"));
    launches = join(scratch, "launches.jsonl"); prompts = join(scratch, "prompts.jsonl"); relists = join(scratch, "relists.jsonl");
    process.env.FAKE_CLAUDE_LAUNCHES = launches;
    process.env.FAKE_CLAUDE_PROMPTS = prompts;
    process.env.FAKE_CLAUDE_MCP_RECONNECT = relists;
    await create();
  });

  afterEach(async () => {
    vi.useRealTimers();
    delete process.env.FAKE_CLAUDE_LAUNCHES;
    delete process.env.FAKE_CLAUDE_PROMPTS;
    delete process.env.FAKE_CLAUDE_MCP_RECONNECT;
    recorder?.stop();
    await instance?.dispose();
    await removeTempDir(scratch);
  });

  it("is taken by the first turn: one process in all, and the turn reads as a fresh launch's", async () => {
    expect(await started("t-ahead", 1)).toBe(true);
    expect(instance.adapter.prestart!.held("t-ahead")).toBe(true);
    expect(instance.adapter.hasSession("t-ahead")).toBe(false);
    expect(pids()).toHaveLength(1);
    expect(recorder.events).toEqual([]);
    expect(lines(prompts)).toEqual([]);

    await instance.adapter.sendTurn(turn("t-ahead"));
    await recorder.until((e) => e.type === "turn.completed" && e.threadId === "t-ahead");
    expect(pids()).toHaveLength(1);
    expect(instance.adapter.prestart!.held("t-ahead")).toBe(false);
    expect(recorder.events.filter((e) => e.threadId === "t-ahead").map((e) => e.type).slice(0, 2)).toEqual(["turn.started", "session.started"]);
    expect(recorder.events.find((e) => e.type === "turn.completed")).toMatchObject({ ok: true });

    await instance.adapter.sendTurn(turn("t-fresh"));
    await recorder.until((e) => e.type === "turn.completed" && e.threadId === "t-fresh");
    const [ahead, fresh] = lines(prompts);
    expect(JSON.stringify(ahead.message.content)).toContain("likes tea");
    expect(ahead).toEqual(fresh);

    // The taken process is the conversation's own from here on: its next turn runs in it too.
    await instance.adapter.sendTurn(turn("t-ahead", { text: "again" }));
    await recorder.until((e) => e.type === "turn.completed" && e.threadId === "t-ahead" && recorder.events.filter((seen) => seen.type === "turn.completed" && seen.threadId === "t-ahead").length === 2);
    expect(pids()).toHaveLength(2);
  });

  it("lists the harness-served tools again before the turn's message is written", async () => {
    const data = { integrations: { data: { command: process.execPath, args: ["-e", ""], env: {} } } };
    expect(await started("t-data", 1, data)).toBe(true);
    expect(lines(relists)).toEqual([]);
    await instance.adapter.sendTurn(turn("t-data", data));
    await recorder.until((e) => e.type === "turn.completed");
    expect(lines(relists).map((frame) => frame.request)).toEqual([{ subtype: "mcp_reconnect", serverName: "data" }]);
    expect(pids()).toHaveLength(1);
    expect(recorder.events.find((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
  });

  it("is replaced, not used, when its tools cannot be listed again", async () => {
    process.env.FAKE_CLAUDE_MCP_RECONNECT = "refuse";
    await instance.dispose();
    await create();
    const data = { integrations: { data: { command: process.execPath, args: ["-e", ""], env: {} } } };
    expect(await started("t-stale", 1, data)).toBe(true);
    const [first] = pids();
    await instance.adapter.sendTurn(turn("t-stale", data));
    await recorder.until((e) => e.type === "turn.completed");
    expect(pids()).toHaveLength(2);
    await until(() => !alive(first!), "the unused process to exit");
    expect(recorder.events.filter((e) => e.type === "runtime.error" || e.type === "runtime.notice")).toEqual([]);
    expect(recorder.events.find((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
  });

  it("is never started again on a CLI that does not know the request", async () => {
    delete process.env.FAKE_CLAUDE_MCP_RECONNECT;
    await instance.dispose();
    await create();
    const data = { integrations: { data: { command: process.execPath, args: ["-e", ""], env: {} } } };
    expect(await started("t-old", 1, data)).toBe(true);
    await instance.adapter.sendTurn(turn("t-old", data));
    await recorder.until((e) => e.type === "turn.completed");
    expect(pids()).toHaveLength(2);
    expect(await started("t-old-2", 3, data)).toBe(false);
    expect(pids()).toHaveLength(2);
  });

  it("is closed and replaced by exactly one process when the turn's launch differs", async () => {
    expect(await started("t-differs", 1)).toBe(true);
    const [first] = pids();
    await instance.adapter.sendTurn(turn("t-differs", { effort: "high" }));
    await recorder.until((e) => e.type === "turn.completed");
    expect(pids()).toHaveLength(2);
    await until(() => !alive(first!), "the unused process to exit");
    expect(recorder.events.filter((e) => e.type === "runtime.error")).toEqual([]);
    expect(recorder.events.filter((e) => e.type === "session.started")).toHaveLength(1);
    expect(recorder.events.find((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
  });

  it("is replaced by a message that comes before it has started up: the turn never waits for it", async () => {
    const launching = instance.adapter.prestart!.start(turn("t-race", { text: "" }));
    const sent = instance.adapter.sendTurn(turn("t-race"));
    await Promise.all([launching, sent]);
    await recorder.until((e) => e.type === "turn.completed");
    await until(() => pids().filter(alive).length === 1, "only the turn's own process to be left");
    expect(instance.adapter.prestart!.held("t-race")).toBe(false);
    expect(recorder.events.filter((e) => e.type === "session.started")).toHaveLength(1);
    expect(recorder.events.filter((e) => e.type === "runtime.error")).toEqual([]);
    expect(recorder.events.find((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
  });

  it("does not start beside a running turn or a second time", async () => {
    await instance.adapter.sendTurn(turn("t-busy"));
    expect(await started("t-busy", 1)).toBe(false);
    await recorder.until((e) => e.type === "turn.completed");
    expect(await started("t-busy", 1)).toBe(false);
    expect(await started("t-twice", 2)).toBe(true);
    expect(await instance.adapter.prestart!.start(turn("t-twice", { text: "" }))).toBe(true);
    expect(instance.adapter.prestart!.ready("t-twice")).toBe(true);
    await instance.adapter.sendTurn(turn("t-twice"));
    await recorder.until((e) => e.type === "turn.completed" && e.threadId === "t-twice");
    expect(pids()).toHaveLength(2);
  });

  it("closes by itself when no message comes, having said nothing", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const before = armedIdleCount();
    expect(await instance.adapter.prestart!.start(turn("t-unused", { text: "" }))).toBe(true);
    expect(armedIdleCount()).toBe(before + 1);
    vi.advanceTimersByTime(PRESTART_IDLE_MS - 1);
    expect(instance.adapter.prestart!.held("t-unused")).toBe(true);
    vi.advanceTimersByTime(1);
    vi.useRealTimers();
    await until(() => pids().length === 1 && !alive(pids()[0]!), "the unused process to exit");
    await until(() => !instance.adapter.prestart!.held("t-unused"), "the driver to forget it");
    expect(armedIdleCount()).toBe(before);
    expect(recorder.events).toEqual([]);
    expect(lines(prompts)).toEqual([]);
  });

  it("is stopped by a drop, while waiting and while still launching", async () => {
    expect(await started("t-drop", 1)).toBe(true);
    const launching = instance.adapter.prestart!.start(turn("t-drop-early", { text: "" }));
    instance.adapter.prestart!.drop("t-drop-early");
    instance.adapter.prestart!.drop("t-drop");
    await launching;
    await until(() => !instance.adapter.prestart!.held("t-drop") && !instance.adapter.prestart!.held("t-drop-early"), "the driver to forget them");
    await until(() => pids().every((pid) => !alive(pid)), "every process to exit");
    expect(recorder.events).toEqual([]);
    // A drop never touches a process a turn has taken.
    const before = pids().length;
    expect(await started("t-taken", before + 1)).toBe(true);
    await instance.adapter.sendTurn(turn("t-taken"));
    instance.adapter.prestart!.drop("t-taken");
    await recorder.until((e) => e.type === "turn.completed");
    expect(recorder.events.find((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
  });

  it("is gone after the server shuts down or every engine is stopped", async () => {
    expect(await started("t-shutdown", 1)).toBe(true);
    await instance.adapter.stopAll();
    await until(() => pids().every((pid) => !alive(pid)), "the process to exit after stopAll");
    expect(await started("t-shutdown-2", 2)).toBe(true);
    await instance.dispose();
    expect(pids()).toHaveLength(2);
    expect(pids().some(alive)).toBe(false);
    expect(recorder.events).toEqual([]);
  });

  it("says nothing when it cannot start", async () => {
    await instance.adapter.prestart!.start(turn("t-nowhere", { text: "", cwd: join(scratch, "no-such-folder") }));
    await until(() => !instance.adapter.prestart!.held("t-nowhere"), "the driver to forget it");
    expect(recorder.events).toEqual([]);
    await instance.adapter.sendTurn(turn("t-nowhere"));
    await recorder.until((e) => e.type === "turn.completed");
    expect(recorder.events.find((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
  });
});
