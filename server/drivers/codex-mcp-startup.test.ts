import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mcpStartupTracker } from "./codex-mcp-startup.ts";

afterEach(() => {
  vi.useRealTimers();
});

const tracking = (promise: Promise<boolean>) => {
  const state: { result?: boolean } = {};
  void promise.then((result) => { state.result = result; });
  return state;
};
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const live = () => new AbortController().signal;

describe("mcpStartupTracker", () => {
  it("does not wait when no server was named", async () => {
    await expect(mcpStartupTracker(new EventEmitter()).settled([], live(), 60_000)).resolves.toBe(true);
  });

  it("waits for a server Codex has not reported yet, through starting, until it is ready", async () => {
    const tracker = mcpStartupTracker(new EventEmitter());
    const wait = tracking(tracker.settled(["openmausbot_connectors"], live(), 60_000));
    await flush();
    expect(wait.result).toBeUndefined();
    tracker.record({ threadId: null, name: "openmausbot_connectors", status: "starting", error: null, failureReason: null });
    await flush();
    expect(wait.result).toBeUndefined();
    tracker.record({ threadId: null, name: "openmausbot_connectors", status: "ready", error: null, failureReason: null });
    await flush();
    expect(wait.result).toBe(true);
  });

  it("treats failed and cancelled as settled", async () => {
    const tracker = mcpStartupTracker(new EventEmitter());
    const wait = tracking(tracker.settled(["agents", "data"], live(), 60_000));
    tracker.record({ name: "agents", status: "failed", error: "MCP client for `agents` timed out after 30 seconds." });
    await flush();
    expect(wait.result).toBeUndefined();
    tracker.record({ name: "data", status: "cancelled" });
    await flush();
    expect(wait.result).toBe(true);
  });

  it("resolves at once for servers that already settled, and ignores servers it was not asked about", async () => {
    const tracker = mcpStartupTracker(new EventEmitter());
    tracker.record({ name: "openmausbot_connectors", status: "ready" });
    tracker.record({ name: "context7", status: "starting" });
    await expect(tracker.settled(["openmausbot_connectors"], live(), 60_000)).resolves.toBe(true);
  });

  it("answers false when the wait is aborted or the app-server exits", async () => {
    const appServer = new EventEmitter();
    const tracker = mcpStartupTracker(appServer);
    const stop = new AbortController();
    const aborted = tracking(tracker.settled(["openmausbot_connectors"], stop.signal, 60_000));
    stop.abort();
    await flush();
    expect(aborted.result).toBe(false);
    await expect(tracker.settled(["openmausbot_connectors"], stop.signal, 60_000)).resolves.toBe(false);

    const exited = tracking(tracker.settled(["openmausbot_connectors"], live(), 60_000));
    appServer.emit("exit", 1, null);
    await flush();
    expect(exited.result).toBe(false);
    await expect(tracker.settled([], live(), 60_000)).resolves.toBe(false);
  });

  it("stops waiting at the time limit and lets the turn start", async () => {
    vi.useFakeTimers();
    const tracker = mcpStartupTracker(new EventEmitter());
    const timed = tracking(tracker.settled(["openmausbot_connectors"], live(), 30_000));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(timed.result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(timed.result).toBe(true);
  });

  it("ignores malformed updates", async () => {
    const tracker = mcpStartupTracker(new EventEmitter());
    const wait = tracking(tracker.settled(["agents"], live(), 60_000));
    tracker.record(null);
    tracker.record({ name: 7, status: "ready" });
    tracker.record({ name: "agents" });
    await flush();
    expect(wait.result).toBeUndefined();
    tracker.record({ name: "agents", status: "ready" });
    await flush();
    expect(wait.result).toBe(true);
  });
});
