// Ported from pingdotgg/t3code@00cdceb1 packages/client-runtime/src/preview/serverBrowserStream.test.ts (MIT License,
// Copyright (c) 2026 T3 Tools Inc.), with OpenMausBot's routes, its watching viewer's resize and its own messages.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { browserStreamAccess, createPreviewStreamClient, type PreviewStreamControl, type PreviewStreamEvents } from "./browser-stream-client";

class FakeSocket extends EventTarget {
  static readonly OPEN = 1;
  static current: FakeSocket;
  readyState = 1;
  binaryType = "";
  readonly sent: string[] = [];
  readonly url: string;
  constructor(url: string) {
    super();
    this.url = url;
    FakeSocket.current = this;
  }
  send(value: string) {
    this.sent.push(value);
  }
  close() {
    this.readyState = 3;
  }
  message(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
  control(value: PreviewStreamControl) {
    this.message(JSON.stringify({ type: "control", ...value }));
  }
  closeWith(code: number, reason = "", opened = true) {
    if (opened) this.dispatchEvent(new Event("open"));
    this.dispatchEvent(Object.assign(new Event("close"), { code, reason }));
  }
}

const access = browserStreamAccess("pepper", { protocol: "http:", host: "omb.test" });
const target = { access, maxWidth: 800, maxHeight: 600 };
const events = (more: Partial<PreviewStreamEvents> = {}): PreviewStreamEvents => ({
  onFrame: vi.fn(),
  onViewport: vi.fn(),
  onConnectedChange: vi.fn(),
  onUnauthorized: vi.fn(),
  ...more,
});
const agent: PreviewStreamControl = { canOperate: true, controller: "agent", generation: 1, dialog: null };

beforeEach(() => vi.stubGlobal("WebSocket", FakeSocket));
afterEach(() => vi.unstubAllGlobals());

describe("preview stream control", () => {
  const connect = () => {
    const onFrame = vi.fn();
    const onControl = vi.fn();
    const client = createPreviewStreamClient(target, events({ onFrame, onControl }));
    return { client, socket: FakeSocket.current, onFrame, onControl };
  };

  it("opens the bot's stream with its frame cap and panel size, and marks passive viewers", () => {
    const { client, socket } = connect();
    expect(socket.url).toBe("ws://omb.test/api/bots/pepper/browser/stream?maxWidth=800&maxHeight=600");
    client.stop();
    createPreviewStreamClient({ ...target, width: 1600, height: 1000 }, events()).stop();
    expect(new URL(FakeSocket.current.url).searchParams.get("width")).toBe("1600");
    expect(new URL(FakeSocket.current.url).searchParams.get("height")).toBe("1000");
    createPreviewStreamClient({ ...target, interactive: false }, events()).stop();
    expect(new URL(FakeSocket.current.url).searchParams.get("interactive")).toBe("false");
    expect(browserStreamAccess("a b", { protocol: "https:", host: "cloud.test" }).wsBase).toBe("wss://cloud.test/api/bots/a%20b/browser");
  });

  it("does not navigate before ownership is granted, but sizes the page for a viewer that may operate, as soon as it may", () => {
    const { client, socket } = connect();
    expect(client.send({ type: "resize", width: 390, height: 844 })).toBe(false);
    expect(client.send({ type: "navigate", url: "http://example.test" })).toBe(false);
    socket.control(agent);
    expect(client.send({ type: "resize", width: 390, height: 844 })).toBe(true);
    expect(client.send({ type: "takeControl" })).toBe(true);
    expect(client.send({ type: "text", text: "premature" })).toBe(false);
    socket.control({ ...agent, controller: "you", generation: 2 });
    expect(client.send({ type: "text", text: "owned" })).toBe(true);
    expect(socket.sent.map((entry) => JSON.parse(entry))).toEqual([
      { type: "resize", width: 390, height: 844 },
      { type: "resize", width: 390, height: 844 },
      { type: "takeControl" },
      { type: "text", text: "owned" },
    ]);
    client.stop();
  });

  it("raises a watcher's frame cap in place, and sends a size or cap asked for while the socket opened once it may", () => {
    const { client, socket } = connect();
    expect(client.send({ type: "resize", width: 1200, height: 900 })).toBe(false);
    expect(client.send({ type: "frameCap", maxWidth: 2400, maxHeight: 1800 })).toBe(false);
    socket.control(agent);
    expect(socket.sent.map((entry) => JSON.parse(entry))).toEqual([
      { type: "frameCap", maxWidth: 2400, maxHeight: 1800 },
      { type: "resize", width: 1200, height: 900 },
    ]);
    expect(client.send({ type: "frameCap", maxWidth: 3200, maxHeight: 2000 })).toBe(true);
    socket.control({ ...agent, generation: 2 });
    expect(socket.sent).toHaveLength(3);
    client.stop();
  });

  it("does not grant control from malformed dialog metadata", () => {
    const { client, socket, onControl } = connect();
    socket.message(JSON.stringify({ type: "control", ...agent, controller: "you", dialog: { type: "prompt", message: 42, defaultValue: "" } }));
    expect(onControl).not.toHaveBeenCalled();
    expect(client.send({ type: "reload" })).toBe(false);
    client.stop();
  });

  it("lets a viewer that only watches wake a browser that closed unused, and passes on that it slept and woke", () => {
    const onMessage = vi.fn();
    const client = createPreviewStreamClient(target, events({ onMessage }));
    const socket = FakeSocket.current;
    socket.control({ ...agent, controller: "unclaimed" });
    socket.message(JSON.stringify({ type: "asleep" }));
    expect(client.send({ type: "wake" })).toBe(true);
    expect(client.send({ type: "reload" })).toBe(false);
    socket.message(JSON.stringify({ type: "awake" }));
    expect(socket.sent).toEqual(['{"type":"wake"}']);
    expect(onMessage.mock.calls.map(([message]) => message.type)).toEqual(["asleep", "awake"]);
    socket.control({ ...agent, canOperate: false });
    expect(client.send({ type: "wake" })).toBe(false);
    client.stop();
  });

  it("keeps read-only frames flowing while refusing takeover and every mutation", () => {
    const { client, socket, onFrame } = connect();
    socket.control({ ...agent, canOperate: false });
    const frame = new ArrayBuffer(3);
    socket.message(frame);
    expect(onFrame).toHaveBeenCalledWith(frame);
    expect(client.send({ type: "takeControl" })).toBe(false);
    expect(client.send({ type: "resize", width: 390, height: 844 })).toBe(false);
    expect(client.send({ type: "reload" })).toBe(false);
    expect(socket.sent).toEqual(['{"type":"ack"}']);
    client.stop();
  });

  it("revokes input immediately on release and exposes pending dialog state", () => {
    const { client, socket, onControl } = connect();
    const owned = { ...agent, controller: "you" as const, dialog: { type: "prompt", message: "Name?", defaultValue: "initial" } };
    socket.control(owned);
    expect(onControl).toHaveBeenLastCalledWith(owned);
    expect(client.send({ type: "dialog", accept: true, promptText: "answer" })).toBe(true);
    expect(client.send({ type: "releaseControl" })).toBe(true);
    socket.control({ ...agent, generation: 2 });
    expect(client.send({ type: "text", text: "late input" })).toBe(false);
    expect(client.send({ type: "dialog", accept: false })).toBe(false);
    client.stop();
  });
});

describe("preview stream downloads, uploads and messages", () => {
  it("offers a download at the bot's download route", () => {
    const onDownload = vi.fn();
    createPreviewStreamClient(target, events({ onDownload }));
    FakeSocket.current.message(JSON.stringify({ type: "download", id: "d1", fileName: "a b.csv", sizeBytes: 3 }));
    expect(onDownload).toHaveBeenCalledExactlyOnceWith({ fileName: "a b.csv", sizeBytes: 3, url: "http://omb.test/api/bots/pepper/browser/download/d1" });
  });

  it("offers the page's file picker with the upload route that answers it, until it closes", () => {
    const onFileChooser = vi.fn();
    createPreviewStreamClient(target, events({ onFileChooser }));
    FakeSocket.current.message(JSON.stringify({ type: "fileChooser", id: "c1", multiple: true, accept: ".txt" }));
    expect(onFileChooser).toHaveBeenLastCalledWith({ multiple: true, accept: ".txt", uploadUrl: "http://omb.test/api/bots/pepper/browser/upload?chooser=c1", credentials: true });
    FakeSocket.current.message(JSON.stringify({ type: "fileChooserClosed", id: "other" }));
    expect(onFileChooser).toHaveBeenCalledOnce();
    FakeSocket.current.message(JSON.stringify({ type: "fileChooserClosed", id: "c1" }));
    expect(onFileChooser).toHaveBeenLastCalledWith(null);
  });

  it("reports where the agent moves and clicks, ignoring malformed points", () => {
    const onPointer = vi.fn();
    createPreviewStreamClient(target, events({ onPointer }));
    FakeSocket.current.message(JSON.stringify({ type: "pointer", phase: "drag", x: 1, y: 2, sequence: 1 }));
    FakeSocket.current.message(JSON.stringify({ type: "pointer", phase: "click", x: 140, y: 50, sequence: 2 }));
    expect(onPointer).toHaveBeenCalledExactlyOnceWith({ phase: "click", x: 140, y: 50, sequence: 2 });
  });

  it("passes the browser's own messages on: tabs, addresses, lists, cursors and the viewport's zoom", () => {
    const onMessage = vi.fn();
    const onViewport = vi.fn();
    createPreviewStreamClient(target, events({ onMessage, onViewport }));
    const tabs = { type: "tabs", tabs: [{ tabId: "t1", title: "A", url: "https://a.test/", active: true }] };
    FakeSocket.current.message(JSON.stringify(tabs));
    FakeSocket.current.message(JSON.stringify({ type: "viewport", width: 1280, height: 800, zoom: 1.25, setting: { mode: "fill" } }));
    FakeSocket.current.message(JSON.stringify({ type: "cursor", shape: "pointer" }));
    expect(onMessage.mock.calls.map(([message]) => message.type)).toEqual(["tabs", "viewport", "cursor"]);
    expect(onMessage).toHaveBeenCalledWith(tabs);
    expect(onViewport).toHaveBeenCalledWith({ width: 1280, height: 800 });
  });

  it("stops on a gone browser or a host that needs setup, and treats a refused upgrade as unauthorized", () => {
    const onGone = vi.fn();
    const onHostSetup = vi.fn();
    const onUnauthorized = vi.fn();
    createPreviewStreamClient(target, events({ onGone }));
    FakeSocket.current.closeWith(4404, "gone");
    expect(onGone).toHaveBeenCalledOnce();
    createPreviewStreamClient(target, events({ onHostSetup }));
    FakeSocket.current.closeWith(4503, JSON.stringify({ need: "libraries", command: "sudo openmausbot browser setup" }));
    expect(onHostSetup).toHaveBeenCalledWith({ need: "libraries", command: "sudo openmausbot browser setup" });
    createPreviewStreamClient(target, events({ onUnauthorized }));
    FakeSocket.current.closeWith(1006, "", false);
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it("reconnects after the browser restarted, with the newest size and frame cap the viewer asked for", () => {
    vi.useFakeTimers();
    const onConnectedChange = vi.fn();
    const client = createPreviewStreamClient({ ...target, width: 1600, height: 1000 }, events({ onConnectedChange }));
    const first = FakeSocket.current;
    first.control(agent);
    client.send({ type: "resize", width: 1200, height: 900 });
    client.send({ type: "frameCap", maxWidth: 3024, maxHeight: 1800 });
    first.closeWith(1012, "reconnect");
    expect(onConnectedChange.mock.calls).toEqual([[true], [false]]);
    vi.advanceTimersByTime(500);
    expect(FakeSocket.current).not.toBe(first);
    expect(Object.fromEntries(new URL(FakeSocket.current.url).searchParams)).toEqual({ maxWidth: "3024", maxHeight: "1800", width: "1200", height: "900" });
    vi.useRealTimers();
  });
});
