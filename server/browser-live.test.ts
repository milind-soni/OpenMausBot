import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserRuntime } from "./browser-runtime.ts";
import { HOLD_LIMITS } from "./browser/hold.ts";
import { BrowserActionFailedError, BrowserLive, browserRestartRefusal, browserStreamPort, normalizeBrowserLiveMessage, parseBrowserLiveAction } from "./browser-live.ts";
import type { Cdp, CdpListeners } from "./browser-sites.ts";

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
  readonly url: string;
  constructor(url: string) {
    super(); this.url = url; SocketFixture.instances.push(this);
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
    interrupted: vi.fn(() => false),
    withHumanAction: vi.fn(async (_session: string, _owner: string, fn: () => unknown) => fn()),
    watch: vi.fn(() => () => {}),
    onIdleClose: vi.fn(),
    settled: vi.fn(async () => {}),
    working: vi.fn(() => true),
    launchReady: vi.fn(async () => {}),
    launched: vi.fn(async () => {}),
    pageSizes: { resize: vi.fn(async () => {}) },
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

async function open({ botId = "bot-a", session = "profile-a", owner = "admin-a", current = () => true, resume, size }: { botId?: string; session?: string; owner?: string; current?: () => boolean; resume?: string; size?: { width: number; height: number } } = {}) {
  const res = new ResponseFixture();
  await live.open({ botId, session, owner, isCurrent: current, res: res as unknown as ServerResponse, ...(resume ? { resume } : {}), ...(size ? { size } : {}),
    spec: { command: "/trusted/agent-browser", args: ["mcp", "--tools", "core"], env: { AGENT_BROWSER_SESSION: session, AGENT_BROWSER_SOCKET_DIR: "/isolated/socket" } } });
  return { res, socket: SocketFixture.instances.at(-1)!, action: (body: unknown) => live.action({ viewerId: res.id, botId, owner, body }) };
}

describe("restarting a browser bots are using", () => {
  it("is refused while a busy bot still works in it, and allowed when it waits on the person there or the browser no longer answers", () => {
    expect(browserRestartRefusal(false, [])).toBeNull();
    expect(browserRestartRefusal(false, [{ waitingOnBrowser: false }])).toBe("Stop every bot using this profile before restarting its browser.");
    expect(browserRestartRefusal(false, [{ waitingOnBrowser: true }])).toBeNull();
    expect(browserRestartRefusal(false, [{ waitingOnBrowser: true }, { waitingOnBrowser: false }])).not.toBeNull();
    expect(browserRestartRefusal(true, [{ waitingOnBrowser: false }])).toBeNull();
  });
});

describe("browser viewer protocol boundary", () => {
  it.each(["console", "command", "result", "chat", "unknown"])("drops %s messages, including their private payloads", (type) => {
    expect(normalizeBrowserLiveMessage({ type, data: "secret", params: { password: "secret" } })).toBeNull();
  });
  it("projects frames and tab/status fields, never engine extras or raw error messages", () => {
    expect(normalizeBrowserLiveMessage({ ...frame, password: "secret" })).toEqual({ type: "frame", seq: 1, data: "/9j/AAAA", format: "jpeg", metadata: { ...frame.metadata, scrollOffsetX: 0, scrollOffsetY: 0 } });
    expect(normalizeBrowserLiveMessage({ type: "error", message: "secret arguments" })).toEqual({
      type: "error", retryable: true, message: "The browser stream was interrupted.",
    });
    expect(normalizeBrowserLiveMessage({ type: "tabs", tabs: [{ tabId: "t1", title: "Page", url: "https://user:secret@example.com/", active: true, targetId: "private" }] })).toEqual({ type: "tabs", tabs: [{ tabId: "t1", title: "Page", url: "https://example.com/", active: true }] });
    expect(normalizeBrowserLiveMessage({ type: "status", connected: true, engine: "private" })).not.toHaveProperty("engine");
  });
  it("rejects corrupt, oversized and non-image frames, and passes a busy page's frame at the largest size it sizes", () => {
    for (const patch of [{ seq: -1 }, { seq: 1.5 }, { data: "<script>" }, { data: "/9j/" + "A".repeat(4 * 1024 * 1024) }, { metadata: { deviceWidth: 100000, deviceHeight: 100000 } }]) {
      expect(normalizeBrowserLiveMessage({ ...frame, ...patch })).toBeNull();
    }
    // 2,768,256 characters: a 1280x2560 frame of a page of noise from agent-browser 0.37.0.
    expect(normalizeBrowserLiveMessage({ ...frame, data: "/9j/" + "A".repeat(2_768_252), metadata: { ...frame.metadata, deviceWidth: 1280, deviceHeight: 2560 } })).toMatchObject({ type: "frame" });
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
  it("fences a late stream startup when that owner is closed during discovery", async () => {
    let finish!: (value: ReturnType<typeof output>) => void;
    execute.mockImplementationOnce(() => new Promise((resolve) => finish = resolve));
    const opening = open();
    const rejected = expect(opening).rejects.toThrow();
    await expect.poll(() => execute.mock.calls.length).toBe(1);
    live.closeForOwner("admin-a");
    finish(output(ready));
    await rejected;
    expect(SocketFixture.instances).toHaveLength(0);
  });
  it("closes every stream and upstream socket for a revoked owner without touching other owners", async () => {
    const a = await open();
    const b = await open({ botId: "bot-b", session: "profile-b" });
    const other = await open({ owner: "other" });
    live.closeForOwner("admin-a");
    expect(a.res.writableEnded).toBe(true);
    expect(b.res.writableEnded).toBe(true);
    expect(a.socket.readyState).toBe(3);
    expect(b.socket.readyState).toBe(3);
    expect(other.res.writableEnded).toBe(false);
    expect(other.socket.readyState).toBe(1);
  });
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
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
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
  it("waits for the prepared Chrome before the engine may start it, and gives it its identity once it runs", async () => {
    const order: string[] = [];
    vi.mocked(runtime.launchReady).mockImplementation(async () => { order.push("ready"); });
    vi.mocked(runtime.launched).mockImplementation(async () => { order.push("launched"); });
    execute.mockImplementation(async (_command: string, args: string[]) => { order.push(args[0] === "stream" ? `stream ${args[1]}` : args[0]!); return output({ ...ready, connected: false }); });
    await open();
    expect(order).toEqual(["ready", "stream status", "open", "launched"]);
    expect(runtime.launched).toHaveBeenCalledWith("profile-a", expect.objectContaining({ command: "/trusted/agent-browser" }));
  });
  it("tells the viewer why the browser cannot start yet, and starts nothing", async () => {
    vi.mocked(runtime.launchReady).mockRejectedValue(new Error("Getting the browser ready (52 of 182 MB). Try again in a minute."));
    await expect(open()).rejects.toThrow("Getting the browser ready (52 of 182 MB). Try again in a minute.");
    expect(execute).not.toHaveBeenCalled();
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
  it("reports a page that would not open as settled, without the engine's own error, and keeps the view usable", async () => {
    const { action } = await open();
    await action({ type: "take" });
    const failed = Object.assign(new Error("Command failed: agent-browser open https://google/"), {
      code: 1, stdout: JSON.stringify({ success: false, data: null, error: "Navigation failed: net::ERR_NAME_NOT_RESOLVED" }) + "\n", stderr: "",
    });
    execute.mockRejectedValueOnce(failed);
    const refused = action({ type: "navigate", url: "https://google/" });
    await expect(refused).rejects.toMatchObject({ status: 422, settled: true, message: "This page could not be opened. Check the address and try again." });
    await expect(refused).rejects.toBeInstanceOf(BrowserActionFailedError);
    // The engine answered with success:false and exit 0 too.
    execute.mockResolvedValueOnce({ stdout: JSON.stringify({ success: false, error: "element not found" }), stderr: "" });
    await expect(action({ type: "tab-new" })).rejects.toMatchObject({ settled: true, message: "The browser could not do that. Try again." });
    execute.mockResolvedValueOnce(output({ url: "https://duckduckgo.com/?q=google" }));
    await expect(action({ type: "navigate", url: "https://duckduckgo.com/?q=google" })).resolves.toEqual({ ok: true });
  });

  it("still treats a command with no answer (killed, aborted) as interrupted, not settled", async () => {
    const { action } = await open();
    await action({ type: "take" });
    execute.mockRejectedValueOnce(Object.assign(new Error("Command failed"), { code: null, signal: "SIGTERM", stdout: "", stderr: "" }));
    const refused = action({ type: "navigate", url: "https://example.com/" });
    await expect(refused).rejects.not.toHaveProperty("settled");
    await expect(refused).rejects.toMatchObject({ status: 503 });
  });

  it("resets a daemon stuck on a failed launch so reconnecting starts a fresh session (#1383)", async () => {
    const openS = () => live.open({ botId: "a", session: "s", owner: "a", isCurrent: () => true,
      res: new ResponseFixture() as unknown as ServerResponse, spec: { command: "/engine", env: { AGENT_BROWSER_SESSION: "s" } } });
    // A daemon that kept a headed launch config fails the same way forever;
    // the failure is reported retryable and the session is discarded.
    execute.mockRejectedValueOnce(Object.assign(new Error("Command failed"), {
      stderr: "Chrome exited early (exit code: 1) without writing DevToolsActivePort\nMissing X server or $DISPLAY",
    }));
    await expect(openS()).rejects.toThrow("Reconnect to retry");
    expect(nativeClose).toHaveBeenCalledTimes(1);
    expect(nativeClose).toHaveBeenCalledWith("/engine", expect.objectContaining({ AGENT_BROWSER_SESSION: "s" }));
    // The same recognition applies when the engine answers success:false JSON.
    execute.mockResolvedValueOnce({ stdout: JSON.stringify({ success: false, error: "Chrome exited before providing DevTools URL" }), stderr: "" });
    await expect(openS()).rejects.toThrow("Reconnect to retry");
    expect(nativeClose).toHaveBeenCalledTimes(2);
    // A non-launch failure keeps the install guidance and leaves the session alone.
    execute.mockRejectedValueOnce(Object.assign(new Error("spawn /engine ENOENT"), { stderr: "" }));
    await expect(openS()).rejects.toThrow("browser engine is installed");
    expect(nativeClose).toHaveBeenCalledTimes(2);
  });
  it("gates a reconnect on the pending session reset instead of racing the stuck daemon (#1383)", async () => {
    const openS = () => live.open({ botId: "a", session: "s", owner: "a", isCurrent: () => true,
      res: new ResponseFixture() as unknown as ServerResponse, spec: { command: "/engine", env: { AGENT_BROWSER_SESSION: "s" } } });
    let finishReset!: (closed: boolean) => void;
    nativeClose.mockImplementationOnce(() => new Promise((resolve) => { finishReset = resolve; }));
    execute.mockRejectedValueOnce(Object.assign(new Error("Command failed"), { stderr: "Missing X server or $DISPLAY" }));
    await expect(openS()).rejects.toThrow("Reconnect to retry");
    expect(nativeClose).toHaveBeenCalledTimes(1);
    // While teardown is still polling, a reconnect must not issue another
    // command or start a second reset against the same daemon.
    const reconnecting = openS();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(nativeClose).toHaveBeenCalledTimes(1);
    finishReset(true);
    await reconnecting;
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1]?.[1]).toEqual(["stream", "status", "--json", "--no-webmcp"]);
    expect(nativeClose).toHaveBeenCalledTimes(1);
  });
  it("starts a fresh reset when the reconnect probe finds the daemon still stuck (#1383)", async () => {
    const openS = () => live.open({ botId: "a", session: "s", owner: "a", isCurrent: () => true,
      res: new ResponseFixture() as unknown as ServerResponse, spec: { command: "/engine", env: { AGENT_BROWSER_SESSION: "s" } } });
    let finishReset!: (closed: boolean) => void;
    nativeClose.mockImplementationOnce(() => new Promise((resolve) => { finishReset = resolve; }));
    execute.mockRejectedValueOnce(Object.assign(new Error("Command failed"), { stderr: "Missing X server or $DISPLAY" }));
    await expect(openS()).rejects.toThrow("Reconnect to retry");
    const reconnecting = openS();
    // The daemon outlived the first close; the probe fails the same way and
    // schedules another reset instead of reporting a healthy session.
    execute.mockRejectedValueOnce(Object.assign(new Error("Command failed"), { stderr: "Missing X server or $DISPLAY" }));
    nativeClose.mockResolvedValueOnce(true);
    finishReset(false);
    await expect(reconnecting).rejects.toThrow("Reconnect to retry");
    expect(nativeClose).toHaveBeenCalledTimes(2);
  });
  it("has the page fill the panel of the view that asked last, once the bot's call ends, and the standard page when no view is left", async () => {
    const resize = vi.mocked(runtime.pageSizes.resize);
    const first = await open({ size: { width: 400, height: 750 } });
    expect(resize).toHaveBeenLastCalledWith("profile-a", { width: 400, height: 750 }, true);
    expect(execute.mock.calls.map((call) => call[1][0])).not.toContain("set");
    const second = await open({ owner: "admin-b", size: { width: 900, height: 700 } });
    expect(resize).toHaveBeenLastCalledWith("profile-a", { width: 900, height: 700 }, true);
    expect(await first.action({ type: "resize", width: 380, height: 760 })).toEqual({ ok: true });
    expect(resize).toHaveBeenLastCalledWith("profile-a", { width: 380, height: 760 }, false);
    const calls = resize.mock.calls.length;
    expect(await first.action({ type: "resize", width: 380, height: 40 })).toEqual({ ok: true });
    expect(resize).toHaveBeenCalledTimes(calls);
    await expect(first.action({ type: "resize", width: "wide", height: 760 })).rejects.toThrow("Invalid browser action.");
    first.res.destroy();
    expect(resize).toHaveBeenLastCalledWith("profile-a", { width: 900, height: 700 }, false);
    second.res.destroy();
    expect(resize).toHaveBeenLastCalledWith("profile-a", null, false);
  });
  it("leaves the page of the person holding the browser as it is when another view opens or resizes", async () => {
    const resize = vi.mocked(runtime.pageSizes.resize);
    const holder = await open({ size: { width: 1400, height: 900 } });
    await holder.action({ type: "take" });
    const other = await open({ owner: "admin-b", size: { width: 400, height: 750 } });
    expect(resize).toHaveBeenLastCalledWith("profile-a", { width: 1400, height: 900 }, true);
    await other.action({ type: "resize", width: 420, height: 800 });
    expect(resize).toHaveBeenLastCalledWith("profile-a", { width: 1400, height: 900 }, true);
    await holder.action({ type: "resize", width: 1500, height: 900 });
    expect(resize).toHaveBeenLastCalledWith("profile-a", { width: 1500, height: 900 }, false);
  });
  it("still opens the view when sizing the page fails", async () => {
    vi.mocked(runtime.pageSizes.resize).mockRejectedValue(new Error("engine without viewport"));
    const { res } = await open({ size: { width: 400, height: 750 } });
    expect(res.id).toBeTruthy();
    expect(res.events("ready")).toHaveLength(1);
  });
  it("opens no stream socket when the viewer closes while the browser is still starting", async () => {
    let finish!: (value: ReturnType<typeof output>) => void;
    execute.mockReset().mockResolvedValueOnce(output({ ...ready, connected: false })).mockImplementationOnce(() => new Promise((resolve) => finish = resolve));
    const res = new ResponseFixture();
    const opening = live.open({ botId: "a", session: "s", owner: "a", isCurrent: () => true, res: res as unknown as ServerResponse,
      spec: { command: "/engine", env: { AGENT_BROWSER_SESSION: "s", AGENT_BROWSER_HEADLESS: "1" } } });
    const rejected = expect(opening).rejects.toThrow();
    await expect.poll(() => execute.mock.calls.length).toBe(2);
    live.closeForOwner("a");
    finish(output({}));
    await rejected;
    expect(SocketFixture.instances).toHaveLength(0);
  });
  it("lets two frames travel to its view unacknowledged, and the next only on the view's own ACK of a frame it was sent", async () => {
    const { res, socket, action } = await open();
    socket.receive(frame);
    expect(res.events("frame")).toHaveLength(1);
    expect(socket.messages).toEqual([{ type: "ack", seq: 1 }]);
    socket.receive({ ...frame, seq: 2 });
    expect(res.events("frame").map((event) => event.seq)).toEqual([1, 2]);
    expect(socket.messages).toEqual([{ type: "ack", seq: 1 }]);
    await action({ type: "ack", seq: 999 });
    expect(socket.messages).toEqual([{ type: "ack", seq: 1 }]);
    await action({ type: "ack", seq: 1 });
    expect(socket.messages).toEqual([{ type: "ack", seq: 1 }, { type: "ack", seq: 2 }]);
    socket.receive({ ...frame, seq: 3 });
    socket.receive({ ...frame, seq: 4 });
    expect(socket.messages).toHaveLength(2);
    // An ACK of a later frame stands for the ones before it.
    await action({ type: "ack", seq: 3 });
    expect(socket.messages.at(-1)).toEqual({ type: "ack", seq: 4 });
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
  it("tells its view how many inputs one request may carry", async () => {
    const { res } = await open();
    expect(res.events("ready")[0]).toMatchObject({ inputBatch: 64 });
  });
  it("sends a batch of inputs in order in one request, without the moves a later move replaces", async () => {
    const a = await open();
    await a.action({ type: "take" });
    const move = (x: number) => ({ type: "input_mouse", eventType: "mouseMoved", x, y: 10 });
    await a.action({ type: "input_batch", events: [
      move(1), move(2), move(3),
      { type: "input_keyboard", eventType: "keyDown", key: "a", code: "KeyA", text: "a" },
      { type: "input_keyboard", eventType: "keyUp", key: "a", code: "KeyA" },
      move(4), { type: "input_keyboard", eventType: "char", text: "bc" },
    ] });
    const sent = nativeInput.mock.calls.map((call) => JSON.parse(call[1].body));
    expect(sent.map((command) => [command.action, command.type ?? command.subaction, command.x ?? command.key ?? command.text])).toEqual([
      ["input_mouse", "mouseMoved", 3], ["input_keyboard", "keyDown", "a"], ["input_keyboard", "keyUp", "a"],
      ["input_mouse", "mouseMoved", 4], ["keyboard", "insertText", "bc"],
    ]);
  });
  it("goes on with a batch past an input the browser refused, and tells the person", async () => {
    const a = await open();
    await a.action({ type: "take" });
    nativeInput.mockImplementation(async (_url: string, init: { body: string }) => Response.json({ success: !JSON.parse(init.body).text?.includes("b") }));
    await expect(a.action({ type: "input_batch", events: [
      { type: "input_keyboard", eventType: "char", text: "a" },
      { type: "input_keyboard", eventType: "char", text: "b" },
      { type: "input_keyboard", eventType: "char", text: "c" },
    ] })).resolves.toEqual({ ok: true, notice: expect.stringContaining("did not take") });
    expect(nativeInput.mock.calls.map((call) => JSON.parse(call[1].body).text)).toEqual(["a", "b", "b", "c"]);
  });
  it("stops a batch at the first release the browser does not confirm, and sends nothing after it", async () => {
    const a = await open();
    await a.action({ type: "take" });
    await a.action({ type: "input_keyboard", eventType: "keyDown", key: "a", code: "KeyA" });
    nativeInput.mockReset().mockImplementation(async (_url: string, init: { body: string }) => Response.json({ success: JSON.parse(init.body).type !== "keyUp" }));
    await expect(a.action({ type: "input_batch", events: [
      { type: "input_keyboard", eventType: "char", text: "x" },
      { type: "input_keyboard", eventType: "keyUp", key: "a", code: "KeyA" },
      { type: "input_keyboard", eventType: "char", text: "y" },
    ] })).rejects.toThrow();
    expect(nativeInput.mock.calls.map((call) => JSON.parse(call[1].body).text ?? JSON.parse(call[1].body).type)).toEqual(["x", "keyUp", "keyUp"]);
  });
  it.each([
    ["no inputs", []],
    ["too many inputs", Array.from({ length: 65 }, () => ({ type: "input_keyboard", eventType: "char", text: "a" }))],
    ["a command", [{ type: "navigate", url: "https://example.com" }]],
    ["a batch inside a batch", [{ type: "input_batch", events: [{ type: "input_keyboard", eventType: "char", text: "a" }] }]],
    ["a malformed input", [{ type: "input_mouse", eventType: "mouseMoved", x: -1, y: 0 }]],
  ])("refuses a batch with %s", (_name, events) => {
    expect(() => parseBrowserLiveAction({ type: "input_batch", events })).toThrow("Invalid browser action.");
  });
  it("requires the person's own human lease and releases only theirs on disconnect", async () => {
    const a = await open(); const b = await open({ botId: "bot-b", owner: "admin-b" });
    await expect(a.action({ type: "navigate", url: "https://example.com" })).rejects.toThrow("Browser control changed");
    await a.action({ type: "take" });
    await expect(b.action({ type: "take" })).rejects.toThrow("Another window or device controls this browser. Hand control back there");
    await expect(b.action({ type: "back" })).rejects.toThrow("Another window or device controls this browser");
    await b.action({ type: "release" });
    b.socket.close();
    expect(held.get("profile-a")).toBe("admin-a");
    await a.action({ type: "input_keyboard", eventType: "keyDown", key: "a", text: "a" });
    expect(nativeInput.mock.calls[0]?.[0]).toBe("http://127.0.0.1:43210/api/command");
    expect(nativeInput.mock.calls[0]?.[1]).toMatchObject({ method: "POST", redirect: "error", headers: { Origin: "http://127.0.0.1:43210" } });
    expect(JSON.parse(nativeInput.mock.calls[0]?.[1].body)).toEqual({ action: "input_keyboard", type: "keyDown", key: "a", text: "a" });
    expect(a.socket.messages).toHaveLength(0);
    a.socket.close(); expect(held.has("profile-a")).toBe(false);
    expect(execute).toHaveBeenCalledTimes(2); // No close command: logins/browser survive viewers.
  });
  it("withholds login frames/tabs/URLs from another person's views, advances their upstream ACK and restores the newest frame on release", async () => {
    const a = await open(); const b = await open({ botId: "bot-b", owner: "admin-b" });
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
    expect(held.get("profile-a")).toBe("admin-a");
    expect(b.res.events("control").at(-1)).toEqual({ held: true, owned: true, controlling: true });
  });
  it("sends a typed password to the page only: never logged, echoed or sent to another view", async () => {
    const secret = "hunter2-correct-horse";
    const logs = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
    const a = await open(); const b = await open({ botId: "bot-b" });
    await a.action({ type: "take" });
    const reply = await a.action({ type: "input_keyboard", eventType: "char", text: secret });
    expect(reply).toEqual({ ok: true });
    expect(nativeInput.mock.calls.map((call) => JSON.parse(call[1].body))).toEqual([{ action: "keyboard", subaction: "insertText", text: secret }]);
    nativeInput.mockImplementationOnce(async () => Response.json({ success: false, error: `bad input ${secret}` }));
    const failure = await a.action({ type: "input_keyboard", eventType: "char", text: secret }).catch((error: Error) => error);
    expect(String(failure)).not.toContain(secret);
    for (const log of logs) expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    expect([...a.res.chunks, ...b.res.chunks].join("")).not.toContain(secret);
    expect(JSON.stringify([a.socket.messages, b.socket.messages])).not.toContain(secret);
  });
  it("hands back whichever view holds the browser when its sign-in card is answered elsewhere", async () => {
    const a = await open(); const b = await open({ botId: "bot-b" });
    await a.action({ type: "take" });
    live.handBack("profile-b");
    expect(held.get("profile-a")).toBe("admin-a");
    live.handBack("profile-a");
    expect(held.has("profile-a")).toBe(false);
    expect(a.res.events("control").at(-1)).toEqual({ held: false, owned: false, controlling: false });
    expect(b.res.events("control").at(-1)).toEqual({ held: false, owned: false, controlling: false });
    expect(a.res.writableEnded).toBe(false);
    await a.action({ type: "take" });
    expect(held.get("profile-a")).toBe("admin-a");
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
  it("closes the browser a view only watches once it sat unused, first telling the view it closed for good so it does not reconnect", async () => {
    const heard: unknown[] = [];
    const closeBrowser = vi.fn(async () => { heard.push(...a.res.events("error")); a.socket.close(); return true; });
    runtime = new BrowserRuntime({ closeBrowser }); live = new BrowserLive({ runtime });
    const a = await open();
    const b = await open({ session: "profile-b" });
    expect(await runtime.closeIfIdle("profile-a", 10)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(await runtime.closeIfIdle("profile-a", 10)).toBe(true);
    expect(closeBrowser).toHaveBeenCalledWith("profile-a", expect.objectContaining({ command: "/trusted/agent-browser" }));
    expect(heard).toEqual([{ retryable: false, asleep: true, message: expect.stringContaining("sat unused") }]);
    expect(a.res.events("error")).toHaveLength(1);
    expect(a.res.writableEnded).toBe(true);
    expect(b.res.writableEnded).toBe(false);
    expect(b.res.events("error")).toEqual([]);
  });

  it("counts a person's input through the view as use, and never closes a browser they hold", async () => {
    runtime = new BrowserRuntime({ closeBrowser: async () => true }); live = new BrowserLive({ runtime });
    const a = await open();
    await a.action({ type: "take" });
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(await runtime.closeIfIdle("profile-a", 10)).toBe(false);
    await a.action({ type: "input_mouse", eventType: "mouseMoved", x: 5, y: 5 });
    await a.action({ type: "release" });
    expect(await runtime.closeIfIdle("profile-a", 10)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(await runtime.closeIfIdle("profile-a", 10)).toBe(true);
    expect(a.res.writableEnded).toBe(true);
  });
  it("waits out an idle close in progress before starting a view", async () => {
    let finish!: (closed: boolean) => void;
    runtime = new BrowserRuntime({ closeBrowser: () => new Promise<boolean>((resolve) => { finish = resolve; }) }); live = new BrowserLive({ runtime });
    const first = await open();
    first.socket.close();
    await new Promise((resolve) => setTimeout(resolve, 15));
    const closing = runtime.closeIfIdle("profile-a", 10);
    execute.mockClear();
    const opening = open();
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(execute).not.toHaveBeenCalled();
    finish(true);
    expect(await closing).toBe(true);
    await opening;
    expect(execute.mock.calls[0]![1]).toEqual(["stream", "status", "--json", "--no-webmcp"]);
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
  it("restarts the browser for the person when a discrete key press is not confirmed, keeping its profile, and hides raw failures", async () => {
    runtime = new BrowserRuntime(); live = new BrowserLive({ runtime });
    const a = await open(); await a.action({ type: "take" });
    nativeInput.mockImplementationOnce(async () => Response.json({ success: false, error: "password=private" }));
    const failure = await a.action({ type: "input_keyboard", eventType: "keyDown", key: "Enter" }).catch((error: Error) => error);
    expect(failure).toMatchObject({ message: "The page stopped responding, so the browser was restarted. Your sign-ins are kept; open the page again." });
    expect(String(failure)).not.toContain("private");
    expect(JSON.parse(nativeInput.mock.calls[0]![1].body)).toEqual({ action: "press", key: "Enter" });
    expect(nativeClose).toHaveBeenCalledOnce();
    expect(a.res.events("error").at(-1)).toMatchObject({ retryable: true, message: expect.stringContaining("restarted") });
    expect(a.res.writableEnded).toBe(true);
    await expect(runtime.withAgentAction("profile-a", async () => true)).resolves.toBe(true);
  });
  it("points an interrupted browser it could not restart at Restart browser…, never at a take-control button", async () => {
    runtime = new BrowserRuntime(); live = new BrowserLive({ runtime });
    const a = await open(); await a.action({ type: "take" });
    nativeClose.mockResolvedValue(false);
    nativeInput.mockImplementationOnce(async () => Response.json({ success: false }));
    await expect(a.action({ type: "input_keyboard", eventType: "keyDown", key: "Enter" })).rejects.toThrow("could not confirm this input");
    await expect(a.action({ type: "back" })).rejects.toThrow("Choose Restart browser… in the browser menu");
    await a.action({ type: "release" });
    await expect(a.action({ type: "take" })).rejects.toThrow("Choose Restart browser… in the browser menu");
  });
  it("sends a single input event the browser refused once more, then tells the person it did not take it, without a restart", async () => {
    runtime = new BrowserRuntime(); live = new BrowserLive({ runtime });
    const a = await open(); await a.action({ type: "take" });
    const click = { type: "input_mouse", eventType: "mousePressed", x: 10, y: 20, button: "left", clickCount: 1 };
    nativeInput.mockImplementationOnce(async () => Response.json({ success: false }));
    await expect(a.action(click)).resolves.toEqual({ ok: true });
    expect(nativeInput.mock.calls.map(([, init]) => JSON.parse(init.body).type)).toEqual(["mousePressed", "mousePressed"]);
    expect(runtime.interrupted("profile-a")).toBe(false);
    await a.action({ ...click, eventType: "mouseReleased" });
    nativeInput.mockImplementationOnce(async () => Response.json({ success: false })).mockImplementationOnce(async () => Response.json({ success: false }));
    await expect(a.action({ type: "input_keyboard", eventType: "char", text: "ada" })).resolves.toEqual({ ok: true, notice: expect.stringContaining("did not take") });
    expect(runtime.interrupted("profile-a")).toBe(false);
    // A refused key-down never counts as held.
    nativeInput.mockImplementationOnce(async () => Response.json({ success: false })).mockImplementationOnce(async () => Response.json({ success: false }));
    await a.action({ type: "input_keyboard", eventType: "keyDown", key: "a", code: "KeyA" });
    const sent = nativeInput.mock.calls.length;
    await a.action({ type: "input_keyboard", eventType: "keyUp", key: "a", code: "KeyA" });
    expect(nativeInput.mock.calls).toHaveLength(sent);
    expect(nativeClose).not.toHaveBeenCalled();
  });
  it("settles an input or command the browser was slow to take once a read behind it answers, without a restart", async () => {
    runtime = new BrowserRuntime(); live = new BrowserLive({ runtime });
    const a = await open(); await a.action({ type: "take" });
    nativeInput.mockImplementationOnce(async () => { throw new Error("relay timed out"); });
    await expect(a.action({ type: "input_keyboard", eventType: "char", text: "ada" })).rejects.toMatchObject({ settled: true, message: expect.stringContaining("slow to take") });
    expect(JSON.parse(nativeInput.mock.calls[1]![1].body)).toEqual({ action: "stream_status" });
    expect(runtime.interrupted("profile-a")).toBe(false);
    execute.mockRejectedValueOnce(Object.assign(new Error("Command failed"), { killed: true, signal: "SIGKILL", code: null, stdout: "", stderr: "" }));
    await expect(a.action({ type: "reload" })).rejects.toMatchObject({ settled: true, message: expect.stringContaining("slow to take") });
    expect(runtime.interrupted("profile-a")).toBe(false);
    // A slow release is sent once more, so no key is left held for the bot.
    await a.action({ type: "input_keyboard", eventType: "keyDown", key: "a", code: "KeyA" });
    nativeInput.mockImplementationOnce(async () => { throw new Error("relay timed out"); });
    await expect(a.action({ type: "input_keyboard", eventType: "keyUp", key: "a", code: "KeyA" })).resolves.toEqual({ ok: true });
    await a.action({ type: "release" });
    await expect(runtime.withAgentAction("profile-a", async () => true)).resolves.toBe(true);
    // No answer to the read either: the browser is restarted for the person.
    await a.action({ type: "take" });
    nativeInput.mockImplementationOnce(async () => { throw new Error("relay timed out"); }).mockImplementationOnce(async () => { throw new Error("relay timed out"); });
    await expect(a.action({ type: "input_keyboard", eventType: "char", text: "x" })).rejects.toThrow("so the browser was restarted");
    expect(nativeClose).toHaveBeenCalledOnce();
    expect(runtime.interrupted("profile-a")).toBe(false);
  });
  describe("the page's own dialogs", () => {
    const URL = "ws://127.0.0.1:9222/devtools/browser/abc-123";
    function devTools() {
      const sent: Array<{ method: string; params?: Record<string, unknown>; sessionId?: string }> = [];
      let listeners: CdpListeners = {};
      let answered!: () => void;
      const answer = new Promise<void>((resolve) => { answered = resolve; });
      const cdp: Cdp = {
        send: vi.fn(async (method: string, params?: Record<string, unknown>, sessionId?: string) => {
          sent.push({ method, params, sessionId });
          if (method === "Page.handleJavaScriptDialog") { answered(); listeners.event?.({ method: "Page.javascriptDialogClosed", params: {}, sessionId }); }
          return {};
        }),
        close: vi.fn(),
      };
      const url = vi.fn(async () => URL);
      const connect = vi.fn(async (_url: string, _timeout: number, given: CdpListeners) => { listeners = given; return cdp; });
      const emit = (method: string, params: Record<string, unknown>, sessionId?: string) => listeners.event?.({ method, params, sessionId });
      return { sent, cdp, url, connect, emit, answer };
    }
    const confirm = { type: "confirm", message: "Leave this page?", defaultPrompt: "" };

    it("shows the page's question to the view holding the browser, not to another, and its answer lets the input it held through", async () => {
      const tools = devTools();
      live = new BrowserLive({ runtime, devTools: { url: tools.url, connect: tools.connect } });
      const a = await open(); const b = await open({ botId: "bot-b", owner: "admin-b" });
      expect(tools.connect).toHaveBeenCalledOnce();
      expect(tools.connect.mock.calls[0]![0]).toBe(URL);
      expect(tools.sent[0]).toMatchObject({ method: "Target.setAutoAttach", params: { autoAttach: true, flatten: true } });
      tools.emit("Target.attachedToTarget", { sessionId: "page-1", targetInfo: { type: "page" } });
      expect(tools.sent.at(-1)).toEqual({ method: "Page.enable", params: {}, sessionId: "page-1" });
      await a.action({ type: "take" });
      nativeInput.mockImplementation(async () => { await tools.answer; return Response.json({ success: true }); });
      const click = a.action({ type: "input_mouse", eventType: "mouseReleased", x: 5, y: 5, button: "left", clickCount: 1 });
      tools.emit("Page.javascriptDialogOpening", confirm, "page-1");
      expect(a.res.events("control").at(-1)).toMatchObject({ owned: true, dialog: { type: "confirm", message: "Leave this page?", defaultValue: "" } });
      expect(b.res.events("control").at(-1)).not.toHaveProperty("dialog");
      await expect(b.action({ type: "dialog", accept: true })).rejects.toThrow();
      await expect(a.action({ type: "dialog", accept: false })).resolves.toEqual({ ok: true });
      expect(tools.sent.at(-1)).toEqual({ method: "Page.handleJavaScriptDialog", params: { accept: false }, sessionId: "page-1" });
      await expect(click).resolves.toEqual({ ok: true });
      expect(a.res.events("control").at(-1)).not.toHaveProperty("dialog");
      await expect(a.action({ type: "dialog", accept: true })).rejects.toThrow("no longer open");
    });

    it("waits for the person's answer when the browser stops waiting for the input the question holds, and needs no restart", async () => {
      const tools = devTools();
      runtime = new BrowserRuntime(); live = new BrowserLive({ runtime, devTools: { url: tools.url, connect: tools.connect } });
      const a = await open();
      tools.emit("Target.attachedToTarget", { sessionId: "page-1", targetInfo: { type: "page" } });
      await a.action({ type: "take" });
      nativeInput.mockImplementationOnce(async () => { tools.emit("Page.javascriptDialogOpening", { ...confirm, type: "prompt", defaultPrompt: "Ada" }, "page-1"); throw new Error("relay timed out"); });
      const typed = a.action({ type: "input_keyboard", eventType: "keyDown", key: "a", code: "KeyA", text: "a" });
      await vi.waitFor(() => expect(a.res.events("control").at(-1)).toMatchObject({ dialog: { type: "prompt", defaultValue: "Ada" } }));
      await a.action({ type: "dialog", accept: true, promptText: "Grace" });
      expect(tools.sent.at(-1)).toMatchObject({ params: { accept: true, promptText: "Grace" } });
      await expect(typed).resolves.toEqual({ ok: true });
      expect(runtime.interrupted("profile-a")).toBe(false);
      expect(nativeClose).not.toHaveBeenCalled();
    });

    it("watches nothing in the person's own Chrome, and stops watching with the last view", async () => {
      const mine = devTools();
      live = new BrowserLive({ runtime, devTools: { url: mine.url, connect: mine.connect } });
      const res = new ResponseFixture();
      await live.open({ botId: "bot-a", session: "mine", owner: "admin-a", isCurrent: () => true, res: res as unknown as ServerResponse,
        spec: { command: "/trusted/agent-browser", env: { AGENT_BROWSER_SESSION: "mine", AGENT_BROWSER_AUTO_CONNECT: "1" } } });
      expect(mine.url).not.toHaveBeenCalled();
      const tools = devTools();
      live = new BrowserLive({ runtime, devTools: { url: tools.url, connect: tools.connect } });
      const a = await open(); const b = await open({ botId: "bot-b" });
      a.socket.close();
      expect(tools.cdp.close).not.toHaveBeenCalled();
      b.socket.close();
      expect(tools.cdp.close).toHaveBeenCalledOnce();
    });

    it("never connects to a DevTools address off this machine", async () => {
      const tools = devTools();
      tools.url.mockResolvedValue("ws://browser.example.net:9222/devtools/browser/x");
      live = new BrowserLive({ runtime, devTools: { url: tools.url, connect: tools.connect } });
      await open();
      expect(tools.connect).not.toHaveBeenCalled();
    });

    it.each([
      [{ type: "dialog" }], [{ type: "dialog", accept: "yes" }], [{ type: "dialog", accept: true, promptText: "x".repeat(4_097) }],
    ])("refuses a malformed answer %j", (body) => {
      expect(() => parseBrowserLiveAction(body)).toThrow("Invalid browser action.");
    });
  });
  it("tells the panel when a take had to wait for a bot command", async () => {
    runtime = new BrowserRuntime(); live = new BrowserLive({ runtime });
    const a = await open();
    expect(await a.action({ type: "take" })).toEqual({ ok: true, waited: false });
    await a.action({ type: "release" });
    // A frame, not a bot command, held the browser: the person's input stands.
    let finish!: () => void;
    const frame = runtime.previewFrame("profile-a", () => new Promise<boolean>((resolve) => { finish = () => resolve(true); }));
    const discarded = expect(frame).rejects.toThrow("paused");
    const taking = a.action({ type: "take" });
    finish(); await discarded;
    expect(await taking).toEqual({ ok: true, waited: false });
    await a.action({ type: "release" });
    vi.spyOn(runtime, "take").mockResolvedValueOnce(true);
    expect(await a.action({ type: "take" })).toEqual({ ok: true, waited: true });
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
    const a = await open(); const b = await open({ botId: "bot-b", owner: "admin-b" });
    await a.action({ type: "take" });
    await expect(b.action({ type: "restart" })).rejects.toThrow("could not restart");
    nativeClose.mockResolvedValueOnce(false);
    await expect(a.action({ type: "restart" })).rejects.toThrow("could not restart");
    expect(runtime.heldBy("profile-a")).toBe("admin-a");
    expect(runtime.canControl("profile-a", "admin-a")).toBe(false);
    await expect(runtime.withAgentAction("profile-a", async () => true)).rejects.toThrow();
    await a.action({ type: "restart" });
    await expect(runtime.withAgentAction("profile-a", async () => true)).resolves.toBe(true);
  });
});

describe("a person's view whose stream drops while they hold the browser", () => {
  const bodies = () => nativeInput.mock.calls.map(([, init]) => JSON.parse(init.body));
  const botWorks = () => runtime.withAgentAction("profile-a", async () => true);
  beforeEach(() => { runtime = new BrowserRuntime(); live = new BrowserLive({ runtime }); });

  it("keeps their control for the same panel's reconnect, takes its input there, and hands back afterwards", async () => {
    const a = await open(); await a.action({ type: "take" });
    await a.action({ type: "input_keyboard", eventType: "char", text: "person@example.test" });
    // The proxy logs the client's live stream as "context canceled".
    a.res.destroy();
    await expect(botWorks()).rejects.toThrow("paused while a person controls");
    const b = await open({ resume: a.res.id });
    expect(b.res.events("control").at(-1)).toEqual({ held: true, owned: true, controlling: true });
    nativeInput.mockClear();
    await b.action({ type: "input_keyboard", eventType: "char", text: "typed after reconnecting" });
    expect(bodies()).toEqual([{ action: "keyboard", subaction: "insertText", text: "typed after reconnecting" }]);
    await b.action({ type: "release" });
    await expect(botWorks()).resolves.toBe(true);
    expect(runtime.interrupted("profile-a")).toBe(false);
  });

  it("gives the hold to the same person's next view, which can hand it back, though it never named the view that dropped", async () => {
    const phone = await open(); await phone.action({ type: "take" });
    // The phone leaves the browser, or the app is closed: its stream ends.
    phone.res.destroy();
    const reopened = await open();
    expect(reopened.res.events("control").at(-1)).toEqual({ held: true, owned: true, controlling: true });
    await reopened.action({ type: "release" });
    await expect(botWorks()).resolves.toBe(true);
  });

  it("lets go of a key and button it held in the page instead of asking for a restart", async () => {
    const a = await open(); await a.action({ type: "take" });
    // Alt+Tab to another app: Alt went down here, its key-up never reached the server.
    await a.action({ type: "input_keyboard", eventType: "keyDown", key: "Alt", code: "AltLeft", modifiers: 1 });
    await a.action({ type: "input_mouse", eventType: "mousePressed", x: 12, y: 20, button: "left", clickCount: 1 });
    nativeInput.mockClear();
    a.res.destroy();
    await vi.waitFor(() => expect(bodies()).toHaveLength(2));
    expect(bodies()).toEqual([
      { action: "input_keyboard", type: "keyUp", key: "Alt", code: "AltLeft" },
      { action: "input_mouse", type: "mouseReleased", x: 12, y: 20, button: "left", clickCount: 1, modifiers: 0, deltaX: 0, deltaY: 0 },
    ]);
    const b = await open({ resume: a.res.id });
    expect(b.res.events("control").at(-1)).toEqual({ held: true, owned: true, controlling: true });
    await b.action({ type: "release" });
    await expect(botWorks()).resolves.toBe(true);
  });

  it("keeps the restart barrier when the browser does not confirm that release", async () => {
    const a = await open(); await a.action({ type: "take" });
    await a.action({ type: "input_keyboard", eventType: "keyDown", key: "Shift", code: "ShiftLeft", modifiers: 8 });
    nativeInput.mockRejectedValue(new Error("relay closed"));
    a.res.destroy();
    await vi.waitFor(() => expect(runtime.interrupted("profile-a")).toBe(true));
    const b = await open({ resume: a.res.id });
    await expect(b.action({ type: "take" })).rejects.toThrow("Choose Restart browser…");
    await b.action({ type: "release" });
    await expect(botWorks()).rejects.toThrow("Restart");
  });

  it("finishes an input that was on its way before letting go of what it pressed", async () => {
    const a = await open(); await a.action({ type: "take" });
    let finish!: (value: Response) => void;
    nativeInput.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const typing = a.action({ type: "input_keyboard", eventType: "keyDown", key: "m", code: "KeyM", text: "m" });
    await vi.waitFor(() => expect(nativeInput).toHaveBeenCalledOnce());
    a.res.destroy();
    const reopening = open({ resume: a.res.id });
    await Promise.resolve();
    expect(bodies()).toHaveLength(1);
    finish(Response.json({ success: true })); await typing;
    const b = await reopening;
    expect(bodies().at(-1)).toEqual({ action: "input_keyboard", type: "keyUp", key: "m", code: "KeyM" });
    expect(b.res.events("control").at(-1)).toEqual({ held: true, owned: true, controlling: true });
  });

  it("hands back when the sign-in card's Done is pressed before the panel reconnects", async () => {
    const a = await open(); await a.action({ type: "take" });
    a.res.destroy();
    live.handBack("profile-a");
    await expect.poll(() => runtime.heldBy("profile-a")).toBeNull();
    await expect(botWorks()).resolves.toBe(true);
    const b = await open({ resume: a.res.id });
    expect(b.res.events("control").at(-1)).toEqual({ held: false, owned: false, controlling: false });
  });

  it("hands back a late hand-back from the dropped view itself", async () => {
    const a = await open(); await a.action({ type: "take" });
    a.res.destroy();
    await expect(a.action({ type: "release" })).resolves.toEqual({ ok: true });
    await expect.poll(() => runtime.heldBy("profile-a")).toBeNull();
    await expect(a.action({ type: "take" })).rejects.toThrow("no longer available");
  });

  it("hands back by itself when the panel does not come back", async () => {
    vi.useFakeTimers();
    const a = await open(); await a.action({ type: "take" });
    a.res.destroy();
    await vi.advanceTimersByTimeAsync(110_000);
    expect(runtime.heldBy("profile-a")).not.toBeNull();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runtime.heldBy("profile-a")).toBeNull();
    await expect(botWorks()).resolves.toBe(true);
  });

  it("gives the hold to no other person, even one naming the view that dropped", async () => {
    const a = await open(); await a.action({ type: "take" });
    a.res.destroy();
    const stranger = await open({ owner: "other", resume: a.res.id });
    expect(stranger.res.events("control").at(-1)).toEqual({ held: true, owned: false, controlling: false });
    await expect(stranger.action({ type: "take" })).rejects.toThrow("Another window or device controls this browser");
    await expect(stranger.action({ type: "release" })).resolves.toEqual({ ok: true });
    await expect(botWorks()).rejects.toThrow("paused while a person controls");
    const reloaded = await open({ botId: "bot-a" });
    expect(reloaded.res.events("control").at(-1)).toEqual({ held: true, owned: true, controlling: true });
    await expect(reloaded.action({ type: "take" })).resolves.toEqual({ ok: true, waited: false });
    expect(runtime.canControl("profile-a", "admin-a")).toBe(true);
  });

  it("does not keep a hold for a view closed on purpose: a revoked owner, a deleted profile, a changed session", async () => {
    let current = true;
    const a = await open({ current: () => current }); await a.action({ type: "take" });
    current = false;
    a.res.destroy();
    expect(runtime.heldBy("profile-a")).toBeNull();
    const b = await open(); await b.action({ type: "take" });
    live.closeForOwner("admin-a");
    expect(runtime.heldBy("profile-a")).toBeNull();
    const c = await open(); await c.action({ type: "take" });
    c.res.destroy();
    live.closeForSession("profile-a");
    await expect.poll(() => runtime.heldBy("profile-a")).toBeNull();
  });
});

describe("one person's hold, across their views and devices", () => {
  const bodies = () => nativeInput.mock.calls.map(([, init]) => JSON.parse(init.body));
  const botWorks = () => runtime.withAgentAction("profile-a", async () => true);
  const control = (view: { res: ResponseFixture }) => view.res.events("control").at(-1);
  beforeEach(() => { runtime = new BrowserRuntime(); live = new BrowserLive({ runtime }); });

  it("lets their other view see the hold, take it over and hand it back while the first is still open", async () => {
    const phone = await open(); await phone.action({ type: "take" });
    const laptop = await open({ botId: "bot-b" });
    expect(control(laptop)).toEqual({ held: true, owned: true, controlling: false });
    await expect(laptop.action({ type: "input_keyboard", eventType: "char", text: "x" })).rejects.toThrow("Browser control changed");
    expect(await laptop.action({ type: "take" })).toEqual({ ok: true, waited: false });
    expect(control(laptop)).toEqual({ held: true, owned: true, controlling: true });
    expect(control(phone)).toEqual({ held: true, owned: true, controlling: false });
    await expect(phone.action({ type: "input_keyboard", eventType: "char", text: "y" })).rejects.toThrow("Browser control changed");
    await expect(botWorks()).rejects.toThrow("paused while a person controls");
    await phone.action({ type: "release" });
    expect(runtime.heldBy("profile-a")).toBeNull();
    expect(control(laptop)).toEqual({ held: false, owned: false, controlling: false });
    await expect(botWorks()).resolves.toBe(true);
  });

  it("lets go of what the view it was taken from pressed before the new one types", async () => {
    const phone = await open(); await phone.action({ type: "take" });
    await phone.action({ type: "input_keyboard", eventType: "keyDown", key: "Shift", code: "ShiftLeft", modifiers: 8 });
    const laptop = await open({ botId: "bot-b" });
    nativeInput.mockClear();
    await laptop.action({ type: "take" });
    await laptop.action({ type: "input_keyboard", eventType: "char", text: "a" });
    expect(bodies()).toEqual([
      { action: "input_keyboard", type: "keyUp", key: "Shift", code: "ShiftLeft" },
      { action: "keyboard", subaction: "insertText", text: "a" },
    ]);
    expect(runtime.interrupted("profile-a")).toBe(false);
  });

  it("ends a hold its person stopped using, kept or not, while every key they type keeps it", async () => {
    vi.useFakeTimers();
    // A view the person left open, whose stream the server never sees end.
    const phone = await open(); await phone.action({ type: "take" });
    await vi.advanceTimersByTimeAsync(HOLD_LIMITS.idleMs - 10_000);
    await phone.action({ type: "input_keyboard", eventType: "char", text: "still typing" });
    await vi.advanceTimersByTimeAsync(HOLD_LIMITS.idleMs - 10_000);
    expect(runtime.heldBy("profile-a")).toBe("admin-a");
    await expect(botWorks()).rejects.toThrow("paused while a person controls");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(runtime.heldBy("profile-a")).toBeNull();
    expect(control(phone)).toEqual({ held: false, owned: false, controlling: false });
    await expect(botWorks()).resolves.toBe(true);
  });

  it("still refuses another person, from any view", async () => {
    const phone = await open(); await phone.action({ type: "take" });
    phone.res.destroy();
    const someoneElse = await open({ owner: "admin-b" });
    expect(control(someoneElse)).toEqual({ held: true, owned: false, controlling: false });
    await expect(someoneElse.action({ type: "take" })).rejects.toThrow("Another window or device controls this browser");
    await someoneElse.action({ type: "release" });
    await expect(botWorks()).rejects.toThrow("paused while a person controls");
  });
});

describe("opening a view while the bot holds the browser", () => {
  const busy = () => Object.assign(new Error("Command failed: agent-browser stream status --json --no-webmcp"), { killed: true, signal: "SIGKILL", code: null });
  const start = () => {
    const res = new ResponseFixture();
    const opening = live.open({ botId: "bot-a", session: "profile-a", owner: "admin-a", isCurrent: () => true, res: res as unknown as ServerResponse,
      spec: { command: "/engine", env: { AGENT_BROWSER_SESSION: "profile-a" } } });
    return { res, opening };
  };
  const types = (res: ResponseFixture) => res.chunks.map((chunk) => chunk.slice("event: ".length, chunk.indexOf("\n")));

  it("waits in an open event stream and connects as soon as the browser answers", async () => {
    vi.useFakeTimers();
    execute.mockRejectedValueOnce(busy()).mockRejectedValueOnce(busy()).mockResolvedValue(output(ready));
    const { res, opening } = start();
    await vi.advanceTimersByTimeAsync(0);
    expect(res.headers["Content-Type"]).toBe("text/event-stream");
    expect(res.events("waiting")).toEqual([{ reason: "busy" }]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(res.events("waiting")).toHaveLength(2);
    expect(res.events("ready")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2_000);
    await opening;
    expect(res.id).toBeTruthy();
    expect(types(res).slice(0, 3)).toEqual(["waiting", "waiting", "ready"]);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute.mock.calls[0]?.[2]).toMatchObject({ timeout: 10_000, killSignal: "SIGKILL" });
  });

  it("resets an engine that stops answering while nothing works in it, says so, and reconnects to a fresh session (#3728)", async () => {
    vi.mocked(runtime.working).mockReturnValue(false);
    execute.mockRejectedValueOnce(busy());
    const { res, opening } = start();
    await opening;
    expect(res.events("waiting")).toHaveLength(0);
    expect(res.events("error")).toEqual([{ retryable: true, message: expect.stringMatching(/browser stopped responding/) }]);
    expect(nativeClose).toHaveBeenCalledTimes(1);
    expect(nativeClose).toHaveBeenCalledWith("/engine", expect.objectContaining({ AGENT_BROWSER_SESSION: "profile-a" }));
    // The next view waits for that reset, then meets the fresh session.
    const again = start();
    await again.opening;
    expect(again.res.events("ready")).toHaveLength(1);
    expect(nativeClose).toHaveBeenCalledTimes(1);
  });

  it("keeps waiting, and resets nothing, while a bot call still works in the browser", async () => {
    vi.useFakeTimers();
    execute.mockRejectedValueOnce(busy()).mockResolvedValue(output(ready));
    const { res, opening } = start();
    await vi.advanceTimersByTimeAsync(1_000);
    await opening;
    expect(types(res).slice(0, 2)).toEqual(["waiting", "ready"]);
    expect(nativeClose).not.toHaveBeenCalled();
  });

  it("does not show a peer's control changes before it is ready", async () => {
    vi.useFakeTimers();
    const a = await open();
    execute.mockRejectedValueOnce(busy()).mockResolvedValue(output(ready));
    const { res, opening } = start();
    await vi.advanceTimersByTimeAsync(0);
    await a.action({ type: "take" });
    expect(res.events("control")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await opening;
    // The same person's other view has their hold: this one watches it, and may take it over or hand it back.
    expect(res.events("control").at(-1)).toEqual({ held: true, owned: true, controlling: false });
  });

  it("stops waiting, and stops asking the browser, when the viewer leaves", async () => {
    vi.useFakeTimers();
    execute.mockRejectedValue(busy());
    const { res, opening } = start();
    const settled = opening.then(() => "resolved", () => "rejected");
    await vi.advanceTimersByTimeAsync(0);
    expect(res.events("waiting")).toHaveLength(1);
    res.destroy();
    await vi.advanceTimersByTimeAsync(60_000);
    await settled;
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[2].signal.aborted).toBe(true);
    expect(SocketFixture.instances).toHaveLength(0);
  });

  it("gives up after a bounded wait with a reason, not an install hint and no automatic retry", async () => {
    vi.useFakeTimers();
    execute.mockRejectedValue(busy());
    const { res, opening } = start();
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    await opening;
    expect(res.events("error")).toEqual([{ retryable: false, message: "The bot is still using this browser. Reconnect when it has finished." }]);
    expect(res.writableEnded).toBe(true);
    const delays = execute.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(execute).toHaveBeenCalledTimes(delays);
  });

  it("reports a busy browser to a person's action without blaming the installation", async () => {
    const a = await open();
    await a.action({ type: "take" });
    execute.mockRejectedValueOnce(busy());
    nativeInput.mockRejectedValueOnce(new Error("relay timed out"));
    await expect(a.action({ type: "reload" })).rejects.toThrow(/busy with another action/);
    expect(JSON.parse(nativeInput.mock.calls.at(-1)![1].body)).toEqual({ action: "stream_status" });
    execute.mockRejectedValueOnce(Object.assign(new Error("spawn /engine ENOENT"), { code: "ENOENT" }));
    await expect(a.action({ type: "reload" })).rejects.toThrow(/browser engine is installed/);
  });
});
