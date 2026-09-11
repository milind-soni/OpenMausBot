import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserRuntime } from "./browser-runtime.ts";
import { BrowserLive, browserStreamPort, normalizeBrowserLiveMessage, parseBrowserLiveAction } from "./browser-live.ts";

const execute = vi.hoisted(() => vi.fn());
const nativeClose = vi.hoisted(() => vi.fn());
const nativeInput = vi.fn();
vi.mock("./browser-engine.ts", () => ({ closeBrowserSession: nativeClose }));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  return { ...actual, execFile: Object.assign(vi.fn(), { [promisify.custom]: execute }) };
});

class ResponseFixture extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  headersSent = false;
  writableLength = 0;
  backpressure = false;
  chunks: string[] = [];
  headers: Record<string, string> = {};
  writeHead(_status: number, headers: Record<string, string>) { this.headersSent = true; this.headers = headers; }
  flushHeaders() {}
  write(value: string) { this.chunks.push(value); return !this.backpressure; }
  end() { this.writableEnded = true; }
  destroy() { this.destroyed = true; this.emit("close"); }
  events(type: string) {
    return this.chunks.filter((chunk) => chunk.startsWith(`event: ${type}\n`)).map((chunk) => JSON.parse(chunk.split("\ndata: ")[1]!));
  }
  get id(): string { return this.events("ready")[0]?.viewerId ?? ""; }
}

class SocketFixture extends EventTarget {
  static OPEN = 1;
  static instances: SocketFixture[] = [];
  static initialMessages: unknown[] = [];
  static failOpen = false;
  readyState = 1;
  bufferedAmount = 0;
  messages: unknown[] = [];
  constructor(readonly url: string) {
    super(); SocketFixture.instances.push(this);
    queueMicrotask(() => {
      this.dispatchEvent(new Event(SocketFixture.failOpen ? "error" : "open"));
      for (const message of SocketFixture.initialMessages) this.receive(message);
    });
  }
  send(value: string) { this.messages.push(JSON.parse(value)); }
  close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
  receive(value: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); }
}

const frame = { type: "frame", seq: 1, data: "/9j/AAAA", metadata: { deviceWidth: 1280, deviceHeight: 720, offsetTop: 0, pageScaleFactor: 1, timestamp: 123 } };
const ready = { enabled: true, connected: true, port: 43210 };
function output(data: unknown) { return { stdout: JSON.stringify({ success: true, data }), stderr: "" }; }
let live: BrowserLive;
let held: Map<string, string>;
let runtime: BrowserRuntime;
beforeEach(() => {
  held = new Map();
  runtime = {
    heldBy: (session: string) => held.get(session),
    canControl: (session: string, owner: string) => held.get(session) === owner,
    take: vi.fn(async (session: string, owner: string) => {
      if (held.has(session) && held.get(session) !== owner) throw new Error("held");
      held.set(session, owner);
    }),
    release: vi.fn((session: string, owner: string) => { if (held.get(session) === owner) held.delete(session); }),
    abandonHumanInput: vi.fn(),
    withHumanAction: vi.fn(async (_session: string, _owner: string, fn: () => unknown) => fn()),
  } as unknown as BrowserRuntime;
  live = new BrowserLive({ runtime });
  SocketFixture.instances = [];
  SocketFixture.initialMessages = []; SocketFixture.failOpen = false;
  vi.stubGlobal("WebSocket", SocketFixture);
  vi.stubGlobal("fetch", nativeInput);
  nativeInput.mockReset().mockImplementation(async () => Response.json({ success: true, data: { dispatched: true } }));
  nativeClose.mockReset().mockResolvedValue(true);
  execute.mockReset().mockResolvedValue(output(ready));
});
afterEach(() => { live.closeAll(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

async function open({ botId = "bot-a", session = "profile-a", owner = "admin-a", current = () => true }: { botId?: string; session?: string; owner?: string; current?: () => boolean } = {}) {
  const res = new ResponseFixture();
  await live.open({ botId, session, owner, isCurrent: current, res: res as unknown as ServerResponse,
    spec: { command: "/trusted/agent-browser", args: ["mcp", "--tools", "core"], env: { AGENT_BROWSER_SESSION: session, AGENT_BROWSER_SOCKET_DIR: "/isolated/socket" } } });
  return { res, socket: SocketFixture.instances.at(-1)!, action: (body: unknown) => live.action({ viewerId: res.id, botId, owner, body }) };
}

describe("browser viewer protocol boundary", () => {
  it.each(["console", "command", "result", "chat", "unknown"])("drops %s messages, including their private payloads", (type) => {
    expect(normalizeBrowserLiveMessage({ type, data: "secret", params: { password: "secret" } })).toBeNull();
  });
  it("projects frames and tab/status fields, never engine extras or raw error messages", () => {
    expect(normalizeBrowserLiveMessage({ ...frame, password: "secret" })).toEqual({ type: "frame", seq: 1, data: "/9j/AAAA", format: "jpeg", metadata: { ...frame.metadata, scrollOffsetX: 0, scrollOffsetY: 0 } });
    expect(normalizeBrowserLiveMessage({ type: "error", message: "secret arguments" })).not.toHaveProperty("message", "secret arguments");
    expect(normalizeBrowserLiveMessage({ type: "tabs", tabs: [{ tabId: "t1", title: "Page", url: "https://user:secret@example.com/", active: true, targetId: "private" }] })).toEqual({ type: "tabs", tabs: [{ tabId: "t1", title: "Page", url: "https://example.com/", active: true }] });
    expect(normalizeBrowserLiveMessage({ type: "status", connected: true, engine: "private" })).not.toHaveProperty("engine");
  });
  it("rejects corrupt, oversized and non-image frames", () => {
    for (const patch of [{ seq: -1 }, { seq: 1.5 }, { data: "<script>" }, { data: "/9j/" + "A".repeat(3 * 1024 * 1024) }, { metadata: { deviceWidth: 100000, deviceHeight: 100000 } }]) {
      expect(normalizeBrowserLiveMessage({ ...frame, ...patch })).toBeNull();
    }
  });
  it("requires a valid integer port from successful stream status, not a caller URL", () => {
    expect(browserStreamPort(ready)).toBe(43210);
    for (const value of [null, {}, { enabled: false, port: 42 }, { enabled: true, port: "42" }, { enabled: true, port: 0 }, { enabled: true, port: 65536 }, { enabled: true, port: 2.2 }]) expect(() => browserStreamPort(value)).toThrow();
  });
  it("maps only fixed navigation/tab verbs and rejects executable URLs and flags", () => {
    expect(parseBrowserLiveAction({ type: "navigate", url: "https://example.com/?q=hi", command: "eval", args: ["secret"] })).toEqual({ type: "command", args: ["open", "https://example.com/?q=hi"] });
    expect(parseBrowserLiveAction({ type: "tab-new" })).toEqual({ type: "command", args: ["tab", "new"] });
    expect(parseBrowserLiveAction({ type: "tab-select", tabId: "t2" })).toEqual({ type: "command", args: ["tab", "t2"] });
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "--cdp=9222", "https://a:secret@example.com", "https://example.com\n--headed", "http:\\example.com"]) expect(() => parseBrowserLiveAction({ type: "navigate", url })).toThrow();
    for (const body of [{ type: "eval", script: "1" }, { type: "press", key: "Control+a" }, { type: "tab-close", tabId: "--all" }, { type: "tab-select", tabId: 1 }, { type: "config", port: 1 }]) expect(() => parseBrowserLiveAction(body)).toThrow();
  });
  it("bounds input coordinates, text and modifiers, and strips arbitrary CDP fields", () => {
    expect(parseBrowserLiveAction({ type: "input_mouse", eventType: "mousePressed", x: 12, y: 20, button: "left", clickCount: 1, method: "Runtime.evaluate" })).toEqual({ type: "input", message: { type: "input_mouse", eventType: "mousePressed", x: 12, y: 20, button: "left", clickCount: 1, deltaX: 0, deltaY: 0, modifiers: 0 } });
    expect(parseBrowserLiveAction({ type: "input_keyboard", eventType: "keyDown", key: "a", text: "a" })).toEqual({ type: "input", message: { type: "input_keyboard", eventType: "keyDown", key: "a", text: "a", modifiers: 0, windowsVirtualKeyCode: 0 } });
    for (const body of [{ type: "input_mouse", eventType: "mouseMoved", x: Infinity, y: 1 }, { type: "input_mouse", eventType: "mouseMoved", x: -1, y: 1 }, { type: "input_keyboard", eventType: "keyDown", key: "a", modifiers: 16 }, { type: "input_keyboard", eventType: "keyDown", key: "a", text: "a".repeat(4097) }]) expect(() => parseBrowserLiveAction(body)).toThrow();
  });
});

describe("authenticated browser viewer relay", () => {
  it("keeps opening status, tabs and the seed frame even if they arrive immediately with the WebSocket upgrade", async () => {
    SocketFixture.initialMessages = [{ type: "status", connected: true }, { type: "tabs", tabs: [] }, frame];
    const a = await open();
    expect(a.res.events("status")).toHaveLength(1);
    expect(a.res.events("tabs")).toHaveLength(1);
    expect(a.res.events("frame")).toHaveLength(1);
  });
  it("reports post-header WebSocket failures as SSE errors without throwing into a JSON route handler", async () => {
    SocketFixture.failOpen = true;
    const a = await open();
    expect(a.res.writableEnded).toBe(true);
    expect(a.res.events("error")).toHaveLength(1);
  });
  it("does not write premature headers when another view takes control during startup", async () => {
    const a = await open();
    let finish!: (value: ReturnType<typeof output>) => void;
    execute.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const res = new ResponseFixture();
    const opening = live.open({ botId: "b", session: "profile-a", owner: "admin-a", isCurrent: () => true, res: res as unknown as ServerResponse, spec: { command: "/engine" } });
    await a.action({ type: "take" });
    expect(res.headersSent).toBe(false); expect(res.chunks).toHaveLength(0);
    finish(output(ready)); await opening;
    expect(res.id).toBeTruthy();
    expect(res.headers["Content-Type"]).toBe("text/event-stream");
  });
  it("uses session-owned CLI environment and a loopback-only paced socket without browser flags", async () => {
    vi.stubEnv("PRIVATE_SERVER_SECRET", "secret"); vi.stubEnv("AGENT_BROWSER_CDP", "https://unrelated-browser.invalid");
    const { res, socket } = await open();
    expect(res.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(res.headers).toMatchObject({ "Cache-Control": "no-store", "Content-Type": "text/event-stream" });
    expect(socket.url).toBe("ws://127.0.0.1:43210/?pacing=ack&maxFps=15");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[1]).toEqual(["stream", "status", "--json", "--no-webmcp"]);
    expect(execute.mock.calls[0]?.[2].env).toMatchObject({ AGENT_BROWSER_SESSION: "profile-a", AGENT_BROWSER_SOCKET_DIR: "/isolated/socket" });
    expect(execute.mock.calls[0]?.[2].env).not.toHaveProperty("PRIVATE_SERVER_SECRET");
    expect(execute.mock.calls[0]?.[2].env).not.toHaveProperty("AGENT_BROWSER_CDP");
  });
  it("only enables disabled streams and launches a blank browser without navigating an existing one", async () => {
    execute.mockResolvedValueOnce(output({ enabled: false, connected: false, port: null }))
      .mockResolvedValueOnce(output({ ...ready, connected: false })).mockResolvedValueOnce(output({ launched: true }));
    await open();
    expect(execute.mock.calls.map((call) => call[1])).toEqual([
      ["stream", "status", "--json", "--no-webmcp"], ["stream", "enable", "--json", "--no-webmcp"], ["open", "--json", "--no-webmcp"],
    ]);
  });
  it("fails closed on missing ports and sanitizes CLI errors without ending an unwritten error response", async () => {
    execute.mockResolvedValueOnce(output({ enabled: true, connected: true, port: null }));
    await expect(open()).rejects.toThrow("valid local stream");
    expect(SocketFixture.instances).toHaveLength(0);
    execute.mockRejectedValueOnce(new Error("PASSWORD=secret CLI args"));
    const res = new ResponseFixture();
    await expect(live.open({ botId: "a", session: "s", owner: "a", isCurrent: () => true, res: res as unknown as ServerResponse, spec: { command: "/engine" } })).rejects.toThrow("browser could not complete");
    expect(res.writableEnded).toBe(false);
    expect(res.chunks).toHaveLength(0);
  });
  it("only acknowledges the exact frame rendered by this bound viewer", async () => {
    const { res, socket, action } = await open();
    socket.receive(frame);
    expect(res.events("frame")).toHaveLength(1);
    expect(socket.messages).toHaveLength(0);
    await action({ type: "ack", seq: 999 });
    expect(socket.messages).toHaveLength(0);
    await action({ type: "ack", seq: 1 });
    expect(socket.messages).toEqual([{ type: "ack", seq: 1 }]);
    await expect(live.action({ viewerId: res.id, botId: "bot-a", owner: "another-admin", body: { type: "take" } })).rejects.toThrow("no longer available");
    await expect(live.action({ viewerId: res.id, botId: "other-bot", owner: "admin-a", body: { type: "take" } })).rejects.toThrow("no longer available");
  });
  it.each([1, 2])("accepts a rendered ACK for identical image bytes with frame sequence %s without timing out", async (seq) => {
    vi.useFakeTimers();
    const a = await open();
    a.socket.receive(frame); await a.action({ type: "ack", seq: 1 });
    await vi.advanceTimersByTimeAsync(15_000);
    a.socket.receive({ ...frame, seq });
    expect(a.res.events("frame").map((event) => event.seq)).toEqual([1, seq]);
    await a.action({ type: "ack", seq });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(a.res.writableEnded).toBe(false); expect(a.res.destroyed).toBe(false);
    expect(a.socket.messages).toEqual([{ type: "ack", seq: 1 }, { type: "ack", seq }]);
  });
  it("keeps the newest frame until drain if the last rendered ACK arrives during SSE backpressure", async () => {
    vi.useFakeTimers();
    const a = await open();
    a.res.backpressure = true;
    a.socket.receive(frame);
    await a.action({ type: "ack", seq: 1 });
    a.socket.receive({ ...frame, seq: 2 });
    a.socket.receive({ ...frame, seq: 3 });
    await a.action({ type: "ack", seq: 2 }); // Not delivered, so cannot acknowledge it.
    expect(a.res.events("frame").map((event) => event.seq)).toEqual([1]);
    expect(a.socket.messages).toEqual([{ type: "ack", seq: 1 }]);
    a.res.backpressure = false; a.res.emit("drain");
    expect(a.res.events("frame").map((event) => event.seq)).toEqual([1, 3]);
    await a.action({ type: "ack", seq: 3 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(a.res.writableEnded).toBe(false); expect(a.res.destroyed).toBe(false);
    expect(a.socket.messages).toEqual([{ type: "ack", seq: 1 }, { type: "ack", seq: 3 }]);
  });
  it("requires a viewer-specific human lease and releases only its own control on disconnect", async () => {
    const a = await open(); const b = await open({ botId: "bot-b" });
    await expect(a.action({ type: "navigate", url: "https://example.com" })).rejects.toThrow("Take control");
    await a.action({ type: "take" });
    await expect(b.action({ type: "take" })).rejects.toThrow("Another browser");
    b.socket.close();
    expect(held.get("profile-a")).toBe(a.res.id);
    await a.action({ type: "input_keyboard", eventType: "keyDown", key: "a", text: "a" });
    expect(nativeInput.mock.calls[0]?.[0]).toBe("http://127.0.0.1:43210/api/command");
    expect(nativeInput.mock.calls[0]?.[1]).toMatchObject({ method: "POST", redirect: "error", headers: { Origin: "http://127.0.0.1:43210" } });
    expect(JSON.parse(nativeInput.mock.calls[0]?.[1].body)).toEqual({ action: "input_keyboard", type: "keyDown", key: "a", text: "a" });
    expect(a.socket.messages).toHaveLength(0);
    a.socket.close(); expect(held.has("profile-a")).toBe(false);
    expect(execute).toHaveBeenCalledTimes(2); // No close command: logins/browser survive viewers.
  });
  it("withholds login frames/tabs/URLs from other views, advances their upstream ACK and restores the newest frame on release", async () => {
    const a = await open(); const b = await open({ botId: "bot-b" });
    await a.action({ type: "take" });
    a.socket.receive(frame); b.socket.receive(frame);
    b.socket.receive({ type: "url", url: "https://private.example/login" });
    b.socket.receive({ type: "tabs", tabs: [] });
    expect(a.res.events("frame")).toHaveLength(1);
    expect(b.res.events("frame")).toHaveLength(0);
    expect(b.res.events("tabs")).toHaveLength(0);
    expect(b.res.events("url")).toHaveLength(0);
    expect(b.socket.messages).toEqual([{ type: "ack", seq: 1 }]);
    expect(b.res.events("control").at(-1)).toEqual({ held: true, owned: false, controlling: false });
    await a.action({ type: "release" });
    expect(b.res.events("frame")).toHaveLength(1);
  });
  it("closes stale authenticated viewers, slow readers and viewers that never acknowledge frames", async () => {
    vi.useFakeTimers();
    let current = true;
    const stale = await open({ current: () => current });
    current = false;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stale.res.writableEnded).toBe(true);
    const slow = await open(); slow.res.backpressure = true; slow.socket.receive(frame);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(slow.res.destroyed).toBe(true);
    const noAck = await open(); noAck.socket.receive(frame);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(noAck.res.writableEnded).toBe(true);
  });
  it("caps views per profile and closes all associated viewers on profile deletion", async () => {
    const a = await open(); const b = await open({ botId: "b" });
    await expect(open({ botId: "c" })).rejects.toThrow("Too many");
    live.closeForSession("profile-a");
    expect(a.res.writableEnded).toBe(true); expect(b.res.writableEnded).toBe(true);
    await expect(a.action({ type: "take" })).rejects.toThrow("no longer available");
  });
  it("closing one bot's view does not close peers that share its profile", async () => {
    const a = await open(); const b = await open({ botId: "bot-b" });
    await b.action({ type: "take" });
    live.closeForBot("bot-a");
    expect(a.res.writableEnded).toBe(true);
    expect(b.res.writableEnded).toBe(false);
    expect(held.get("profile-a")).toBe(b.res.id);
  });
  it("inserts pasted text literally and preserves modifier shortcuts via native acknowledged actions", async () => {
    const a = await open(); await a.action({ type: "take" });
    await a.action({ type: "input_keyboard", eventType: "char", text: "--cdp=secret\nhello" });
    await a.action({ type: "input_keyboard", eventType: "keyDown", key: "a", modifiers: 2 });
    await a.action({ type: "input_keyboard", eventType: "keyUp", key: "a", modifiers: 2 });
    expect(nativeInput.mock.calls.map((call) => JSON.parse(call[1].body))).toEqual([
      { action: "keyboard", subaction: "insertText", text: "--cdp=secret\nhello" }, { action: "press", key: "Control+a" },
    ]);
  });
  it.each(["Backspace", "Enter", "Tab", "Escape", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"])("uses an acknowledged native press for %s without a duplicate key release", async (key) => {
    const a = await open(); await a.action({ type: "take" });
    await a.action({ type: "input_keyboard", eventType: "keyDown", key, code: key });
    await a.action({ type: "input_keyboard", eventType: "keyUp", key, code: key });
    expect(nativeInput.mock.calls.map(([, options]) => JSON.parse(options.body))).toEqual([{ action: "press", key }]);
    await a.action({ type: "release" });
    expect(runtime.abandonHumanInput).not.toHaveBeenCalled();
  });
  it.each([
    { key: "a", code: "KeyA", modifiers: 2, chord: "Control+a" },
    { key: "a", code: "KeyA", modifiers: 4, chord: "Meta+a" },
    { key: "Tab", code: "Tab", modifiers: 8, chord: "Shift+Tab" },
    { key: "ArrowLeft", code: "ArrowLeft", modifiers: 3, chord: "Alt+Control+ArrowLeft" },
  ])("does not resend $chord when its modifiers change before keyUp", async ({ key, code, modifiers, chord }) => {
    const a = await open(); await a.action({ type: "take" });
    await a.action({ type: "input_keyboard", eventType: "keyDown", key, code, modifiers });
    await a.action({ type: "input_keyboard", eventType: "keyUp", key, code, modifiers: 0 });
    expect(nativeInput.mock.calls.map(([, options]) => JSON.parse(options.body))).toEqual([{ action: "press", key: chord }]);
  });
  it("preserves printable text and releases raw held keys even if modifiers change", async () => {
    const a = await open(); await a.action({ type: "take" });
    await a.action({ type: "input_keyboard", eventType: "keyDown", key: "+", code: "Equal", text: "+", modifiers: 8 });
    await a.action({ type: "input_keyboard", eventType: "keyUp", key: "=", code: "Equal", modifiers: 2 });
    await a.action({ type: "input_keyboard", eventType: "keyDown", key: "a", code: "KeyA", text: "a" });
    await a.action({ type: "input_keyboard", eventType: "keyUp", key: "a", code: "KeyA" });
    expect(nativeInput.mock.calls.map(([, options]) => JSON.parse(options.body))).toEqual([
      { action: "input_keyboard", type: "keyDown", key: "+", code: "Equal", text: "+" },
      { action: "input_keyboard", type: "keyUp", key: "=", code: "Equal" },
      { action: "input_keyboard", type: "keyDown", key: "a", code: "KeyA", text: "a" },
      { action: "input_keyboard", type: "keyUp", key: "a", code: "KeyA" },
    ]);
    await a.action({ type: "release" });
    expect(runtime.abandonHumanInput).not.toHaveBeenCalled();
  });
  it("keeps unknown raw key names literal instead of interpreting them as chords or commands", async () => {
    const a = await open(); await a.action({ type: "take" });
    await a.action({ type: "input_keyboard", eventType: "keyDown", key: "Control+a", command: "eval", script: "private" });
    expect(nativeInput.mock.calls.map(([, options]) => JSON.parse(options.body))).toEqual([
      { action: "input_keyboard", type: "keyDown", key: "Control+a" },
    ]);
  });
  it("handles repeated discrete keyDowns once each and does not mark them held", async () => {
    const a = await open(); await a.action({ type: "take" });
    await a.action({ type: "input_keyboard", eventType: "keyDown", key: "Backspace", code: "Backspace" });
    await a.action({ type: "input_keyboard", eventType: "keyDown", key: "Backspace", code: "Backspace" });
    await a.action({ type: "release" });
    expect(nativeInput.mock.calls.map(([, options]) => JSON.parse(options.body))).toEqual([
      { action: "press", key: "Backspace" }, { action: "press", key: "Backspace" },
    ]);
    expect(runtime.abandonHumanInput).not.toHaveBeenCalled();
  });
  it("clears a formerly raw held key after an acknowledged repeat becomes a shortcut", async () => {
    const a = await open(); await a.action({ type: "take" });
    await a.action({ type: "input_keyboard", eventType: "keyDown", key: "a", code: "KeyA", text: "a" });
    await a.action({ type: "input_keyboard", eventType: "keyDown", key: "a", code: "KeyA", modifiers: 2 });
    await a.action({ type: "input_keyboard", eventType: "keyUp", key: "a", code: "KeyA", modifiers: 0 });
    await a.action({ type: "release" });
    expect(nativeInput.mock.calls.map(([, options]) => JSON.parse(options.body))).toEqual([
      { action: "input_keyboard", type: "keyDown", key: "a", code: "KeyA", text: "a" }, { action: "press", key: "Control+a" },
    ]);
    expect(runtime.abandonHumanInput).not.toHaveBeenCalled();
  });
  it("still requires restart when a held modifier has not been released after a chord", async () => {
    runtime = new BrowserRuntime(); live = new BrowserLive({ runtime });
    const a = await open(); await a.action({ type: "take" });
    await a.action({ type: "input_keyboard", eventType: "keyDown", key: "Shift", code: "ShiftLeft", modifiers: 8 });
    await a.action({ type: "input_keyboard", eventType: "keyDown", key: "Tab", code: "Tab", modifiers: 8 });
    await a.action({ type: "input_keyboard", eventType: "keyUp", key: "Tab", code: "Tab", modifiers: 8 });
    await a.action({ type: "release" });
    await expect(runtime.withAgentAction("profile-a", async () => true)).rejects.toThrow("Restart");
  });
  it("keeps uncertain discrete key presses behind the existing restart barrier and hides raw failures", async () => {
    runtime = new BrowserRuntime(); live = new BrowserLive({ runtime });
    const a = await open(); await a.action({ type: "take" });
    nativeInput.mockImplementationOnce(async () => Response.json({ success: false, error: "password=private" }));
    await expect(a.action({ type: "input_keyboard", eventType: "keyDown", key: "Enter" })).rejects.toThrow("could not confirm this input");
    expect(JSON.parse(nativeInput.mock.calls[0]![1].body)).toEqual({ action: "press", key: "Enter" });
    await a.action({ type: "release" });
    await expect(runtime.withAgentAction("profile-a", async () => true)).rejects.toThrow("Restart");
  });
  it("releases Shift-only printable keys even when keyUp contains no text", async () => {
    const a = await open(); await a.action({ type: "take" });
    await a.action({ type: "input_keyboard", eventType: "keyDown", key: "A", code: "KeyA", text: "A", modifiers: 8 });
    await a.action({ type: "input_keyboard", eventType: "keyUp", key: "A", code: "KeyA", modifiers: 8 });
    expect(nativeInput.mock.calls.map(([, options]) => JSON.parse(options.body))).toEqual([
      { action: "input_keyboard", type: "keyDown", key: "A", code: "KeyA", text: "A" },
      { action: "input_keyboard", type: "keyUp", key: "A", code: "KeyA" },
    ]);
  });
  it.each(["release", "disconnect"])("requires restart if %s leaves a native key or button held", async (ending) => {
    runtime = new BrowserRuntime(); live = new BrowserLive({ runtime });
    const a = await open(); await a.action({ type: "take" });
    await a.action({ type: "input_keyboard", eventType: "keyDown", key: "Shift", code: "ShiftLeft", modifiers: 8 });
    await a.action({ type: "input_mouse", eventType: "mousePressed", x: 12, y: 20, button: "left" });
    if (ending === "release") await a.action({ type: "release" }); else a.socket.close();
    await expect(runtime.withAgentAction("profile-a", async () => true)).rejects.toThrow("Restart");
    const b = ending === "release" ? a : await open();
    await b.action({ type: "restart" });
    await expect(runtime.withAgentAction("profile-a", async () => true)).resolves.toBe(true);
  });
  it("hands back normally after matching key and mouse releases are confirmed", async () => {
    runtime = new BrowserRuntime(); live = new BrowserLive({ runtime });
    const a = await open(); await a.action({ type: "take" });
    await a.action({ type: "input_keyboard", eventType: "keyDown", key: "Shift", code: "ShiftLeft", modifiers: 8 });
    await a.action({ type: "input_mouse", eventType: "mousePressed", x: 12, y: 20, button: "left" });
    await a.action({ type: "input_keyboard", eventType: "keyUp", key: "Shift", code: "ShiftLeft", modifiers: 0 });
    await a.action({ type: "input_mouse", eventType: "mouseReleased", x: 12, y: 20, button: "left" });
    await a.action({ type: "release" });
    await expect(runtime.withAgentAction("profile-a", async () => true)).resolves.toBe(true);
  });
  it.each(["release", "disconnect"].flatMap((ending) => [
    { ending, name: "pasted text", body: { type: "input_keyboard", eventType: "char", text: "private" } },
    { ending, name: "discrete press", body: { type: "input_keyboard", eventType: "keyDown", key: "Enter" } },
  ]))("does not admit bot work on $ending until native $name is confirmed", async ({ ending, body }) => {
    runtime = new BrowserRuntime(); live = new BrowserLive({ runtime });
    const a = await open(); await a.action({ type: "take" });
    let finish!: (value: Response) => void;
    nativeInput.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const input = a.action(body);
    await vi.waitFor(() => expect(nativeInput).toHaveBeenCalled());
    if (ending === "release") await a.action({ type: "release" }); else a.socket.close();
    await expect(runtime.withAgentAction("profile-a", async () => true)).rejects.toThrow("paused");
    finish(Response.json({ success: true })); await input;
    await expect(runtime.withAgentAction("profile-a", async () => true)).resolves.toBe(true);
  });
  it("restarts only through exclusive recovery and closes all views after native close succeeds", async () => {
    runtime = new BrowserRuntime(); live = new BrowserLive({ runtime });
    const a = await open(); const b = await open({ botId: "bot-b" });
    nativeClose.mockImplementationOnce(async (file, env) => {
      expect(file).toBe("/trusted/agent-browser");
      expect(env.AGENT_BROWSER_SESSION).toBe("profile-a");
      a.socket.close(); b.socket.close();
      await expect(runtime.withAgentAction("profile-a", async () => true)).rejects.toThrow();
      return true;
    });
    await a.action({ type: "restart" });
    expect(a.res.writableEnded).toBe(true); expect(b.res.writableEnded).toBe(true);
    await expect(runtime.withAgentAction("profile-a", async () => true)).resolves.toBe(true);
  });
  it("does not clear uncertain input or other owners when native restart fails", async () => {
    runtime = new BrowserRuntime(); live = new BrowserLive({ runtime });
    const a = await open(); const b = await open({ botId: "bot-b" });
    await a.action({ type: "take" });
    await expect(b.action({ type: "restart" })).rejects.toThrow("could not restart");
    nativeClose.mockResolvedValueOnce(false);
    await expect(a.action({ type: "restart" })).rejects.toThrow("could not restart");
    expect(runtime.heldBy("profile-a")).toBe(a.res.id);
    expect(runtime.canControl("profile-a", a.res.id)).toBe(false);
    await expect(runtime.withAgentAction("profile-a", async () => true)).rejects.toThrow();
    await a.action({ type: "restart" });
    await expect(runtime.withAgentAction("profile-a", async () => true)).resolves.toBe(true);
  });
});
