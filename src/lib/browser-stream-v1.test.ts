import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PreviewStreamEvents } from "./browser-stream-client";
import { browserFrameSize, createLiveInputQueue, createLiveStreamClient, jpegSize, liveAction, liveControl } from "./browser-stream-v1";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

/** A 2x1 baseline JPEG's start: SOI, then SOF0 carrying height 1 and width 2. */
const JPEG_2X1 = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x02, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

class FixtureEventSource {
  static instances: FixtureEventSource[] = [];
  listeners = new Map<string, Array<(event: Event) => void>>();
  close = vi.fn();
  constructor(readonly url: string) { FixtureEventSource.instances.push(this); }
  addEventListener(name: string, listener: (event: Event) => void) {
    this.listeners.set(name, [...this.listeners.get(name) ?? [], listener]);
  }
  emit(name: string, data: unknown) {
    for (const listener of this.listeners.get(name) ?? []) listener(new MessageEvent(name, { data: JSON.stringify(data) }));
  }
  fail(data?: unknown) {
    for (const listener of this.listeners.get("error") ?? []) listener(data === undefined ? new Event("error") : new MessageEvent("error", { data: JSON.stringify(data) }));
  }
}

const events = (more: Partial<PreviewStreamEvents> = {}): PreviewStreamEvents => ({
  onFrame: vi.fn(), onViewport: vi.fn(), onConnectedChange: vi.fn(), onUnauthorized: vi.fn(), ...more,
});

beforeEach(() => {
  FixtureEventSource.instances = [];
  vi.stubGlobal("EventSource", FixtureEventSource);
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("the v1 view of one conversation's browser", () => {
  it("asks for that conversation's browser on a Team Cloud, and for the bot's own browser elsewhere", () => {
    createLiveStreamClient("scout", events(), vi.fn(), { viewer: "" }, { threadId: "ada-chat" });
    createLiveStreamClient("scout", events(), vi.fn(), { viewer: "v-1" }, { threadId: "ada-chat" });
    createLiveStreamClient("scout", events(), vi.fn());
    expect(FixtureEventSource.instances.map((source) => source.url)).toEqual([
      "/api/bots/scout/browser/live?threadId=ada-chat",
      "/api/bots/scout/browser/live?resume=v-1&threadId=ada-chat",
      "/api/bots/scout/browser/live",
    ]);
  });
});

describe("the v1 view in the stream's words", () => {
  it("turns v2 input into the frozen v1 actions, within their limits", () => {
    expect(liveAction({ type: "mouse", action: "down", x: -4, y: 9000, button: "left", buttons: 1, clickCount: 7, modifiers: 2 }))
      .toEqual({ type: "input_mouse", eventType: "mousePressed", x: 0, y: 8192, button: "left", clickCount: 3, modifiers: 2 });
    expect(liveAction({ type: "wheel", x: 5, y: 6, deltaX: 0, deltaY: 50_000, modifiers: 0 }))
      .toEqual({ type: "input_mouse", eventType: "mouseWheel", x: 5, y: 6, button: "none", deltaX: 0, deltaY: 10_000, modifiers: 0 });
    expect(liveAction({ type: "key", action: "down", key: "Enter", code: "Enter", keyCode: 13, text: "\r", modifiers: 0 }))
      .toEqual({ type: "input_keyboard", eventType: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 0, text: "\r" });
    const text = liveAction({ type: "text", text: "x".repeat(5_000) }) as Array<{ text: string }>;
    expect(text.map((chunk) => chunk.text.length)).toEqual([4_096, 904]);
    expect(liveAction({ type: "history", delta: -1 })).toEqual({ type: "back" });
    expect(liveAction({ type: "history", delta: 1 })).toEqual({ type: "forward" });
    expect(liveAction({ type: "navigate", url: "https://example.com/" })).toEqual({ type: "navigate", url: "https://example.com/" });
    expect(liveAction({ type: "tabNew" })).toEqual({ type: "tab-new" });
    expect(liveAction({ type: "tabSelect", tabId: "t2" })).toEqual({ type: "tab-select", tabId: "t2" });
    expect(liveAction({ type: "tabClose", tabId: "t2" })).toEqual({ type: "tab-close", tabId: "t2" });
    expect(liveAction({ type: "restart" })).toEqual({ type: "restart" });
    for (const unsupported of [{ type: "resize", width: 1, height: 1 }, { type: "zoom", factor: 2 }, { type: "probe", x: 1, y: 1 }, { type: "selectChoose", id: "s", index: 0 }] as const) {
      expect(liveAction(unsupported)).toBeNull();
    }
  });

  it("names who holds the browser as v2 does, and that the person holds it from another view of theirs", () => {
    expect(liveControl({ held: true, owned: true, controlling: true }, 3)).toEqual({ canOperate: true, controller: "you", generation: 3, dialog: null, owned: true });
    expect(liveControl({ held: true, owned: true, controlling: false }, 1)).toMatchObject({ controller: "agent", owned: true });
    expect(liveControl({ held: true, owned: false }, 1).controller).toBe("another-viewer");
    expect(liveControl({ held: true, owned: false }, 1)).not.toHaveProperty("owned");
    expect(liveControl({ held: false }, 1).controller).toBe("unclaimed");
    expect(liveControl({ held: true, owned: true, controlling: true, dialog: { type: "confirm", message: "Leave?", defaultValue: "" } }, 1).dialog)
      .toEqual({ type: "confirm", message: "Leave?", defaultValue: "" });
    expect(liveControl({ held: true, owned: true, dialog: { type: "confirm", message: 7 } }, 1).dialog).toBeNull();
  });

  it("reads a frame's size from its JPEG, and the page's from the metadata unless that describes the window", () => {
    expect(jpegSize(JPEG_2X1)).toEqual({ width: 2, height: 1 });
    expect(jpegSize(new Uint8Array([0x00, 0x01]))).toBeNull();
    expect(browserFrameSize(1280, 720, 1280, 720)).toEqual({ width: 1280, height: 720 });
    expect(browserFrameSize(1280, 577, 1280, 720)).toEqual({ width: 1280, height: 577 });
  });
});

describe("the v1 live client", () => {
  function open() {
    const post = vi.fn<(body: Record<string, unknown>, viewerId: string) => Promise<unknown>>().mockResolvedValue({ ok: true });
    const handlers = events({ onMessage: vi.fn(), onControl: vi.fn(), onGone: vi.fn() });
    const client = createLiveStreamClient("pepper", handlers, post);
    const source = FixtureEventSource.instances.at(-1)!;
    return { client, post, handlers, source };
  }

  it("connects to the bot's live view, shows its frames and acknowledges each one", () => {
    const { post, handlers, source } = open();
    expect(source.url).toBe("/api/bots/pepper/browser/live");
    source.emit("ready", { viewerId: "v1" });
    expect(handlers.onConnectedChange).toHaveBeenCalledWith(true);
    source.emit("frame", { seq: 7, data: base64(JPEG_2X1), metadata: { deviceWidth: 2, deviceHeight: 1 } });
    expect(handlers.onViewport).toHaveBeenCalledWith({ width: 2, height: 1 });
    expect(new Uint8Array(vi.mocked(handlers.onFrame).mock.calls[0]![0])).toEqual(JPEG_2X1);
    expect(post).toHaveBeenCalledWith({ type: "ack", seq: 7 }, "v1");
    source.emit("tabs", { tabs: [{ tabId: "t1", title: "A", url: "https://a.test/", active: true }] });
    source.emit("url", { url: "https://a.test/next" });
    expect(handlers.onMessage).toHaveBeenCalledWith({ type: "tabs", tabs: [{ tabId: "t1", title: "A", url: "https://a.test/", active: true }] });
    expect(handlers.onMessage).toHaveBeenCalledWith({ type: "url", url: "https://a.test/next" });
  });

  it("opens at the panel's size and sends each new size to its view while it only watches, the newest once the last is answered", async () => {
    const post = vi.fn<(body: Record<string, unknown>, viewerId: string) => Promise<unknown>>().mockResolvedValue({ ok: true });
    const client = createLiveStreamClient("pepper", events(), post, { viewer: "" }, {}, { width: 365.4, height: 686 });
    const source = FixtureEventSource.instances.at(-1)!;
    expect(source.url).toBe("/api/bots/pepper/browser/live?width=365&height=686");
    expect(client.send({ type: "resize", width: 400, height: 700 })).toBe(true);
    expect(post).not.toHaveBeenCalled();
    source.emit("ready", { viewerId: "v1" });
    expect(post).toHaveBeenLastCalledWith({ type: "resize", width: 400, height: 700 }, "v1");
    source.emit("control", { held: false, owned: false, controlling: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const answer = deferred();
    post.mockReturnValueOnce(answer.promise.then(() => ({ ok: true })));
    client.send({ type: "resize", width: 420, height: 700 });
    client.send({ type: "resize", width: 440, height: 700 });
    client.send({ type: "resize", width: 460, height: 720 });
    expect(post.mock.calls.filter(([body]) => body.type === "resize")).toHaveLength(2);
    answer.resolve();
    await vi.waitFor(() => expect(post).toHaveBeenLastCalledWith({ type: "resize", width: 460, height: 720 }, "v1"));
    expect(post.mock.calls.filter(([body]) => body.type === "resize")).toHaveLength(3);
  });

  it("keeps going when a server without resizing refuses a size", async () => {
    const post = vi.fn<(body: Record<string, unknown>, viewerId: string) => Promise<unknown>>()
      .mockImplementation(async (body) => { if (body.type === "resize") throw Object.assign(new Error("Invalid browser action."), { status: 400 }); return { ok: true }; });
    const handlers = events({ onMessage: vi.fn(), onGone: vi.fn() });
    const client = createLiveStreamClient("pepper", handlers, post, { viewer: "" }, {}, { width: 365, height: 686 });
    const source = FixtureEventSource.instances.at(-1)!;
    source.emit("ready", { viewerId: "v1" });
    source.emit("control", { held: true, owned: true, controlling: true });
    client.send({ type: "resize", width: 500, height: 700 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    client.transport.send({ type: "text", text: "hi" });
    await client.transport.settle();
    expect(post).toHaveBeenLastCalledWith({ type: "input_keyboard", eventType: "char", text: "hi" }, "v1");
    expect(handlers.onMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "notice" }));
    expect(handlers.onGone).not.toHaveBeenCalled();
  });

  it("takes control with a POST, then sends input in order while it controls", async () => {
    const { client, post, handlers, source } = open();
    source.emit("ready", { viewerId: "v1" });
    source.emit("control", { held: false, owned: false, controlling: false });
    post.mockResolvedValueOnce({ ok: true, waited: true });
    await expect(client.transport.take()).resolves.toEqual({ waited: true });
    expect(post).toHaveBeenCalledWith({ type: "take" }, "v1");
    source.emit("control", { held: true, owned: true, controlling: true });
    expect(handlers.onControl).toHaveBeenLastCalledWith(expect.objectContaining({ controller: "you" }));
    client.transport.send({ type: "mouse", action: "down", x: 1, y: 2, button: "left", buttons: 1, clickCount: 1, modifiers: 0 });
    client.transport.send({ type: "text", text: "hi" });
    await client.transport.settle();
    expect(post.mock.calls.slice(1).map(([body]) => body.type)).toEqual(["input_mouse", "input_keyboard"]);
    await client.transport.release();
    expect(post).toHaveBeenLastCalledWith({ type: "release" }, "v1");
  });

  it("batches the input queued behind a request only for a server that said it takes batches", async () => {
    for (const [ready, batched] of [[{ viewerId: "v1", inputBatch: 64 }, true], [{ viewerId: "v1" }, false]] as const) {
      const { client, post, source } = open();
      source.emit("ready", ready);
      source.emit("control", { held: true, owned: true, controlling: true });
      const first = deferred();
      post.mockImplementationOnce(() => first.promise.then(() => ({ ok: true })));
      for (const key of ["a", "b", "c"]) {
        client.transport.send({ type: "key", action: "down", key, code: `Key${key.toUpperCase()}`, keyCode: 65, text: key, modifiers: 0 });
        client.transport.send({ type: "key", action: "up", key, code: `Key${key.toUpperCase()}`, keyCode: 65, modifiers: 0 });
      }
      first.resolve();
      await client.transport.settle();
      expect(post.mock.calls.map(([body]) => body.type)).toEqual(batched ? ["input_keyboard", "input_batch"] : Array(6).fill("input_keyboard"));
      client.stop();
    }
  });

  it("shows the page's question as it opens and closes, and sends the answer past input the question holds", async () => {
    const { client, post, handlers, source } = open();
    source.emit("ready", { viewerId: "v1", inputBatch: 64 });
    source.emit("control", { held: true, owned: true, controlling: true });
    const dialog = { type: "confirm", message: "Leave this page?", defaultValue: "" };
    source.emit("control", { held: true, owned: true, controlling: true, dialog });
    expect(handlers.onControl).toHaveBeenLastCalledWith(expect.objectContaining({ controller: "you", dialog }));
    const held = deferred();
    post.mockImplementationOnce(() => held.promise.then(() => ({ ok: true })));
    client.transport.send({ type: "mouse", action: "up", x: 1, y: 2, button: "left", buttons: 0, clickCount: 1, modifiers: 0 });
    client.transport.send({ type: "text", text: "after" });
    expect(client.send({ type: "dialog", accept: true })).toBe(true);
    expect(post).toHaveBeenLastCalledWith({ type: "dialog", accept: true }, "v1");
    held.resolve();
    await client.transport.settle();
    source.emit("control", { held: true, owned: true, controlling: true });
    expect(handlers.onControl).toHaveBeenLastCalledWith(expect.objectContaining({ controller: "you", dialog: null }));
  });

  it("shows a reply's notice for input the page did not take, and keeps sending", async () => {
    const { client, post, handlers, source } = open();
    source.emit("ready", { viewerId: "v1" });
    source.emit("control", { held: true, owned: true, controlling: true });
    post.mockResolvedValueOnce({ ok: true, notice: "The page did not take some of your input." });
    client.transport.send({ type: "text", text: "a" });
    client.transport.send({ type: "text", text: "b" });
    await client.transport.settle();
    expect(handlers.onMessage).toHaveBeenCalledWith({ type: "notice", message: "The page did not take some of your input." });
    expect(post.mock.calls.map(([body]) => body.text)).toEqual(["a", "b"]);
    expect(client.transport.stopped()).toBe(false);
  });

  it("reconnects a dropped view a few times without replaying input, then stops", () => {
    vi.useFakeTimers();
    const { client, post, handlers, source } = open();
    source.emit("ready", { viewerId: "v1" });
    source.fail();
    expect(handlers.onConnectedChange).toHaveBeenLastCalledWith(false);
    client.transport.send({ type: "text", text: "lost" });
    for (const delay of [1_000, 2_000, 4_000, 8_000, 15_000]) {
      vi.advanceTimersByTime(delay);
      FixtureEventSource.instances.at(-1)!.emit("ready", { viewerId: "again" });
      FixtureEventSource.instances.at(-1)!.fail();
    }
    expect(FixtureEventSource.instances).toHaveLength(6);
    expect(handlers.onGone).toHaveBeenCalledOnce();
    expect(post.mock.calls.some(([body]) => body.type === "input_keyboard")).toBe(false);
  });

  it("does not retry the server's terminal refusal, and shows its reason", () => {
    const { handlers, source } = open();
    source.fail({ retryable: false, message: "Too many browser views are open." });
    expect(FixtureEventSource.instances).toHaveLength(1);
    expect(handlers.onMessage).toHaveBeenCalledWith({ type: "notice", message: "Too many browser views are open." });
    expect(handlers.onGone).toHaveBeenCalledOnce();
  });
});

describe("a v1 live view whose stream dropped", () => {
  const interrupted = (source: FixtureEventSource) => source.fail();
  let page: EventTarget;
  let shown: EventTarget & { visibilityState: string };
  beforeEach(() => {
    vi.useFakeTimers();
    page = new EventTarget();
    shown = Object.assign(new EventTarget(), { visibilityState: "visible" });
    vi.stubGlobal("window", page);
    vi.stubGlobal("document", shown);
  });
  function open(resume = { viewer: "" }) {
    const post = vi.fn<(body: Record<string, unknown>, viewerId: string) => Promise<unknown>>().mockResolvedValue({ ok: true });
    const handlers = events({ onMessage: vi.fn(), onControl: vi.fn(), onGone: vi.fn() });
    const client = createLiveStreamClient("pepper", handlers, post, resume);
    return { client, post, handlers, resume };
  }
  const latest = () => FixtureEventSource.instances.at(-1)!;

  it("asks to carry on with the view it had until a new one is ready", () => {
    const { client } = open();
    expect(latest().url).toBe("/api/bots/pepper/browser/live");
    latest().emit("ready", { viewerId: "old-viewer" });
    interrupted(latest());
    vi.advanceTimersByTime(1_000);
    expect(latest().url).toBe("/api/bots/pepper/browser/live?resume=old-viewer");
    interrupted(latest());
    vi.advanceTimersByTime(2_000);
    expect(latest().url).toBe("/api/bots/pepper/browser/live?resume=old-viewer");
    latest().emit("ready", { viewerId: "new-viewer" });
    latest().emit("heartbeat", {});
    interrupted(latest());
    vi.advanceTimersByTime(1_000);
    expect(latest().url).toBe("/api/bots/pepper/browser/live?resume=new-viewer");
    latest().emit("ready", { viewerId: "newest-viewer" });
    client.stop();
  });

  it("hands the view it had to the panel's next client, as Reconnect does", () => {
    const resume = { viewer: "" };
    const first = open(resume);
    latest().emit("ready", { viewerId: "old-viewer" });
    first.client.stop();
    const second = open(resume);
    expect(latest().url).toBe("/api/bots/pepper/browser/live?resume=old-viewer");
    latest().emit("ready", { viewerId: "new-viewer" });
    expect(resume.viewer).toBe("");
    second.client.stop();
  });

  it("reconnects at once when the window is focused again after its retries ran out", () => {
    const { client, handlers } = open();
    latest().emit("ready", { viewerId: "old-viewer" });
    for (const delay of [1_000, 2_000, 4_000, 8_000, 15_000]) {
      interrupted(latest());
      vi.advanceTimersByTime(delay);
    }
    interrupted(latest());
    vi.advanceTimersByTime(60_000);
    expect(FixtureEventSource.instances).toHaveLength(6);
    expect(handlers.onGone).toHaveBeenCalledOnce();
    shown.visibilityState = "hidden"; shown.dispatchEvent(new Event("visibilitychange"));
    expect(FixtureEventSource.instances).toHaveLength(6);
    shown.visibilityState = "visible"; page.dispatchEvent(new Event("focus"));
    expect(FixtureEventSource.instances).toHaveLength(7);
    expect(latest().url).toBe("/api/bots/pepper/browser/live?resume=old-viewer");
    latest().emit("ready", { viewerId: "back-viewer" });
    expect(handlers.onConnectedChange).toHaveBeenLastCalledWith(true);
    client.stop();
  });

  it("retries a waiting reconnect at once when the network comes back", () => {
    const { client } = open();
    interrupted(latest());
    expect(FixtureEventSource.instances).toHaveLength(1);
    page.dispatchEvent(new Event("online"));
    expect(FixtureEventSource.instances).toHaveLength(2);
    vi.advanceTimersByTime(1_000);
    expect(FixtureEventSource.instances).toHaveLength(2);
    client.stop();
  });

  it("stops for good when its browser closed unused, without a notice, and does not start it again on focus", () => {
    const { client, handlers } = open();
    latest().emit("ready", { viewerId: "v1" });
    latest().fail({ type: "error", retryable: false, asleep: true, message: "This browser closed after it sat unused, to save memory." });
    vi.advanceTimersByTime(30_000);
    page.dispatchEvent(new Event("focus"));
    expect(FixtureEventSource.instances).toHaveLength(1);
    expect(handlers.onMessage).toHaveBeenCalledExactlyOnceWith({ type: "asleep" });
    expect(handlers.onGone).toHaveBeenCalledOnce();
    client.stop();
  });

  it("does not retry a refusal for good on focus", () => {
    const { client } = open();
    latest().fail({ message: "Browser access is disabled" });
    page.dispatchEvent(new Event("focus"));
    shown.dispatchEvent(new Event("visibilitychange"));
    expect(FixtureEventSource.instances).toHaveLength(1);
    client.stop();
  });

  it("treats a stream that went silent as dropped", () => {
    const { client, handlers } = open();
    const source = latest();
    source.emit("ready", { viewerId: "quiet-viewer" });
    vi.advanceTimersByTime(20_000);
    source.emit("heartbeat", {});
    vi.advanceTimersByTime(24_000);
    expect(source.close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(6_000);
    expect(source.close).toHaveBeenCalledOnce();
    expect(handlers.onConnectedChange).toHaveBeenLastCalledWith(false);
    vi.advanceTimersByTime(1_000);
    expect(latest().url).toBe("/api/bots/pepper/browser/live?resume=quiet-viewer");
    client.stop();
  });

  it("reconnects at once when the window comes back to a silent stream", () => {
    const { client } = open();
    const source = latest();
    source.emit("ready", { viewerId: "quiet-viewer" });
    vi.advanceTimersByTime(26_000);
    expect(source.close).not.toHaveBeenCalled();
    page.dispatchEvent(new Event("focus"));
    expect(source.close).toHaveBeenCalledOnce();
    expect(FixtureEventSource.instances).toHaveLength(2);
    client.stop();
  });

  it("reconnects when the server no longer has the view its input went to", async () => {
    const { client, post, handlers } = open();
    const source = latest();
    source.emit("ready", { viewerId: "gone-viewer" });
    source.emit("control", { held: true, owned: true, controlling: true });
    post.mockRejectedValueOnce(Object.assign(new Error("This browser view is no longer available. Reopen the browser panel."), { status: 404 }));
    client.transport.send({ type: "mouse", action: "down", x: 4, y: 5, button: "left", buttons: 1, clickCount: 1, modifiers: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(source.close).toHaveBeenCalledOnce();
    expect(handlers.onMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "notice" }));
    vi.advanceTimersByTime(1_000);
    expect(latest().url).toBe("/api/bots/pepper/browser/live?resume=gone-viewer");
    client.stop();
  });

  it("keeps its hold after reconnecting: input and Hand back go to the new view", async () => {
    const { client, post } = open();
    latest().emit("ready", { viewerId: "old-viewer" });
    interrupted(latest());
    vi.advanceTimersByTime(1_000);
    latest().emit("ready", { viewerId: "new-viewer" });
    latest().emit("control", { held: true, owned: true, controlling: true });
    client.transport.send({ type: "mouse", action: "down", x: 4, y: 5, button: "left", buttons: 1, clickCount: 1, modifiers: 0 });
    await client.transport.settle();
    await client.transport.release();
    expect(post.mock.calls.filter(([body]) => body.type !== "ack").map(([body, viewer]) => [body.type, viewer])).toEqual([
      ["input_mouse", "new-viewer"], ["release", "new-viewer"],
    ]);
    client.stop();
  });

  it("stops listening to the window once stopped", () => {
    const { client } = open();
    interrupted(latest());
    client.stop();
    page.dispatchEvent(new Event("focus"));
    vi.advanceTimersByTime(60_000);
    expect(FixtureEventSource.instances).toHaveLength(1);
  });
});

describe("the v1 input queue", () => {
  const move = (x: number) => ({ type: "input_mouse", eventType: "mouseMoved", x, y: 10 });
  const wheel = (deltaY: number) => ({ type: "input_mouse", eventType: "mouseWheel", x: 10, y: 10, deltaY });
  const key = (eventType: string, value = "a") => ({ type: "input_keyboard", eventType, key: value });
  const up = { type: "input_mouse", eventType: "mouseReleased", button: "left" };

  it("coalesces adjacent movement and scroll without crossing keyboard/button boundaries", async () => {
    const first = deferred();
    const send = vi.fn<(body: Record<string, unknown>) => Promise<void>>().mockResolvedValue();
    send.mockImplementationOnce(() => first.promise);
    const queue = createLiveInputQueue(send, vi.fn());
    queue.enqueue(key("keyDown"));
    queue.enqueue(move(1)); queue.enqueue(move(2)); queue.enqueue(move(3));
    queue.enqueue(key("keyUp"));
    queue.enqueue(wheel(10)); queue.enqueue(wheel(20));
    queue.enqueue(up);
    expect(send).toHaveBeenCalledTimes(1);
    first.resolve();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(5));
    expect(send.mock.calls.map(([body]) => body)).toEqual([key("keyDown"), move(3), key("keyUp"), { ...wheel(30), deltaX: 0 }, up]);
    await queue.drain();
  });

  it("drains key/button releases but discards queued movement on hand-back", async () => {
    const first = deferred();
    const send = vi.fn<(body: Record<string, unknown>) => Promise<void>>().mockResolvedValue();
    send.mockImplementationOnce(() => first.promise);
    const queue = createLiveInputQueue(send, vi.fn());
    queue.enqueue(key("keyDown")); queue.enqueue(move(12)); queue.enqueue(wheel(100));
    queue.enqueue(key("keyUp")); queue.enqueue(up);
    let drained = false;
    const finished = queue.drain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    first.resolve(); await finished;
    expect(send.mock.calls.map(([body]) => body)).toEqual([key("keyDown"), key("keyUp"), up]);
  });

  it("invalidates old unsent input and ignores old errors after reconnect", async () => {
    let fail!: (cause: Error) => void;
    const first = new Promise<void>((_, reject) => { fail = reject; });
    const send = vi.fn<(body: Record<string, unknown>) => Promise<void>>().mockResolvedValue();
    send.mockImplementationOnce(() => first);
    const onError = vi.fn();
    const queue = createLiveInputQueue(send, onError);
    queue.enqueue(key("keyDown", "old")); queue.enqueue(key("keyUp", "old"));
    queue.clear(); queue.enqueue(key("keyDown", "new"));
    fail(new Error("old viewer closed")); await queue.drain();
    expect(send.mock.calls.map(([body]) => body.key)).toEqual(["old", "new"]);
    expect(onError).not.toHaveBeenCalled();
  });

  it("halts overflowing presses while keeping releases and toolbar actions", async () => {
    const first = deferred();
    const send = vi.fn<(body: Record<string, unknown>) => Promise<void>>().mockResolvedValue();
    send.mockImplementationOnce(() => first.promise);
    const onError = vi.fn();
    const queue = createLiveInputQueue(send, onError);
    queue.enqueue(key("keyDown", "held")); queue.enqueue(key("keyUp", "held"));
    for (let n = 0; n < 40; n++) queue.enqueue(key("keyDown", String(n)));
    queue.enqueue(up);
    queue.enqueue({ type: "reload" });
    expect(onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: expect.stringContaining("Reconnect the view before typing again") }));
    first.resolve(); await queue.drain();
    expect(send.mock.calls.map(([body]) => body)).toEqual([key("keyDown", "held"), key("keyUp", "held"), up, { type: "reload" }]);
    queue.clear(); queue.enqueue(key("keyDown", "after reconnect")); await queue.drain();
    expect(send).toHaveBeenLastCalledWith(key("keyDown", "after reconnect"));
  });

  it("sends every input queued behind a request in the next one where the server takes batches, and commands alone", async () => {
    const first = deferred();
    const send = vi.fn<(body: Record<string, unknown>) => Promise<void>>().mockResolvedValue();
    send.mockImplementationOnce(() => first.promise);
    const queue = createLiveInputQueue(send, vi.fn(), () => 64);
    queue.enqueue(key("keyDown", "a"));
    queue.enqueue(key("keyUp", "a")); queue.enqueue(key("keyDown", "b")); queue.enqueue(move(1)); queue.enqueue(move(2)); queue.enqueue(key("keyUp", "b"));
    queue.enqueue({ type: "reload" });
    queue.enqueue(key("keyDown", "c"));
    first.resolve(); await queue.settle();
    expect(send.mock.calls.map(([body]) => body)).toEqual([
      key("keyDown", "a"),
      { type: "input_batch", events: [key("keyUp", "a"), key("keyDown", "b"), move(2), key("keyUp", "b")] },
      { type: "reload" },
      key("keyDown", "c"),
    ]);
  });

  it("keeps a batch to the limit the server gave and under the size it reads", async () => {
    const send = vi.fn<(body: Record<string, unknown>) => Promise<void>>().mockResolvedValue();
    for (const [limit, inputs] of [[3, Array.from({ length: 6 }, (_, n) => key("keyDown", String(n)))], [64, Array.from({ length: 10 }, () => ({ type: "input_keyboard", eventType: "char", text: "x".repeat(4_000) }))]] as const) {
      send.mockClear();
      const first = deferred();
      send.mockImplementationOnce(() => first.promise);
      const queue = createLiveInputQueue(send, vi.fn(), () => limit);
      queue.enqueue(key("keyDown", "first"));
      for (const input of inputs) queue.enqueue(input);
      first.resolve(); await queue.settle();
      const sizes = send.mock.calls.slice(1).map(([body]) => (body.events as unknown[] | undefined)?.length ?? 1);
      expect(Math.max(...sizes)).toBeLessThanOrEqual(limit);
      expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(inputs.length);
      expect(Math.max(...send.mock.calls.map(([body]) => JSON.stringify(body).length))).toBeLessThan(32_768);
    }
  });

  it("still sends the releases of a batch that failed, so nothing stays held, and no presses", async () => {
    const onError = vi.fn();
    const send = vi.fn<(body: Record<string, unknown>) => Promise<void>>().mockResolvedValue();
    const first = deferred();
    send.mockImplementationOnce(() => first.promise).mockRejectedValueOnce(new Error("could not confirm"));
    const queue = createLiveInputQueue(send, onError, () => 64);
    queue.enqueue(key("keyDown", "a"));
    queue.enqueue(key("keyDown", "shift")); queue.enqueue(key("keyDown", "b")); queue.enqueue(key("keyUp", "b")); queue.enqueue(up); queue.enqueue(key("keyUp", "shift"));
    first.resolve(); await queue.settle();
    expect(send.mock.calls.slice(2).map(([body]) => body)).toEqual([key("keyUp", "b"), up, key("keyUp", "shift")]);
    expect(onError).toHaveBeenCalledOnce();
  });

  it("does not replay queued presses after a transport failure", async () => {
    const onError = vi.fn();
    const send = vi.fn<(body: Record<string, unknown>) => Promise<void>>().mockRejectedValueOnce(new Error("uncertain input")).mockResolvedValue();
    const queue = createLiveInputQueue(send, onError);
    queue.enqueue(key("keyDown")); queue.enqueue(key("keyDown", "b")); queue.enqueue(key("keyUp"));
    await queue.drain();
    expect(send.mock.calls.map(([body]) => body)).toEqual([key("keyDown"), key("keyUp")]);
    expect(onError).toHaveBeenCalledOnce();
  });
});
