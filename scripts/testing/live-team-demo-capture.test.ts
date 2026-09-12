import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startDemoCapture } from "./live-team-demo-capture.ts";

class FakeSocket extends EventTarget {
  static OPEN = 1;
  static current: FakeSocket;
  readyState = 0;
  sent: Array<{ id: number; method: string }> = [];
  sendError = false;
  constructor() { super(); FakeSocket.current = this; }
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
  close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
  send(data: string) {
    if (this.sendError) throw Error("send failed");
    this.sent.push(JSON.parse(data));
  }
  respond(result: unknown, error?: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id: this.sent.at(-1)!.id, result, error }) }));
  }
}
let directory: string;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeSocket);
  directory = mkdtempSync(join(tmpdir(), "studio-cdp-"));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); rmSync(directory, { recursive: true, force: true }); });
const start = () => startDemoCapture("ws://fixture", "http://fixture", directory);
const connect = async () => { FakeSocket.current.open(); await Promise.resolve(); };
const recording = async () => {
  const promise = start();
  await connect();
  FakeSocket.current.respond({ targetInfos: [{ type: "page", url: "http://fixture", targetId: "page" }] });
  await Promise.resolve();
  FakeSocket.current.respond({ sessionId: "session" });
  await Promise.resolve();
  FakeSocket.current.respond({ data: "ZnJhbWU=" });
  await Promise.resolve();
  FakeSocket.current.respond({});
  return promise;
};

describe("bounded demo CDP lifecycle", () => {
  it.each(["close", "error"])("rejects startup on socket %s and clears pending timers", async (event) => {
    const promise = start();
    const rejected = expect(promise).rejects.toThrow(/CDP socket/);
    await connect();
    FakeSocket.current.dispatchEvent(new Event(event));
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
  it("times out unanswered commands", async () => {
    const promise = start();
    const rejected = expect(promise).rejects.toThrow("CDP command timed out: Target.getTargets");
    await connect();
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["close", "error", "timeout"])("settles a connection that never opens on %s", async (event) => {
    const rejected = expect(start()).rejects.toThrow(/CDP socket/);
    if (event === "timeout") await vi.advanceTimersByTimeAsync(10_000);
    else FakeSocket.current.dispatchEvent(new Event(event));
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["send", "response"])("clears timers on %s errors", async (kind) => {
    const promise = start();
    const rejected = expect(promise).rejects.toThrow("failed");
    if (kind === "send") FakeSocket.current.sendError = true;
    await connect();
    if (kind === "response") FakeSocket.current.respond(null, { message: "failed" });
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
  it("clears successful command timers and rejects all in-flight work on disconnect", async () => {
    const capture = await recording();
    expect(vi.getTimerCount()).toBe(0);
    FakeSocket.current.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ method: "Page.screencastFrame", sessionId: "session", params: { data: "ZnJhbWU=", sessionId: 1 } }) }));
    const rejected = expect(capture.stop()).rejects.toThrow("CDP socket closed");
    expect(vi.getTimerCount()).toBe(2);
    FakeSocket.current.close();
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    await capture.stop();
  });
  it("rejects stop immediately after an idle disconnect", async () => {
    const capture = await recording();
    FakeSocket.current.close();
    await expect(capture.stop()).rejects.toThrow("CDP socket closed");
    expect(vi.getTimerCount()).toBe(0);
  });
});
