// @vitest-environment happy-dom
// happy-dom runs no script in the frame, so the View is played by message events whose source is its window.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { APP_SAMPLES } from "../../../shared/app-samples";
import { botHtmlDocument } from "../../../shared/app-frame/document";
import { APP_FRAME_SANDBOX, createAppIframe, mountAppFrame, trackAppEngagement, type AppFrameAdapter } from "./app-frame-host";

const doc = botHtmlDocument({ messageId: "m1", rev: 0, html: APP_SAMPLES.counter!.html });

function adapter(): AppFrameAdapter & { [key: string]: ReturnType<typeof vi.fn> } {
  return {
    callRpc: vi.fn(async () => ({})),
    sendMessage: vi.fn(async () => {}),
    openLink: vi.fn(async () => {}),
    setContext: vi.fn(async () => {}),
    resize: vi.fn(),
    teardownRequested: vi.fn(),
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});
afterEach(() => {
  container.remove();
  vi.restoreAllMocks();
});

describe("the frame element", () => {
  it("is sandboxed with exactly allow-scripts allow-forms and has no allow attribute", () => {
    const iframe = createAppIframe(document, "Coffee counter", 200, "dark");
    expect(APP_FRAME_SANDBOX).toBe("allow-scripts allow-forms");
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
    expect(iframe.hasAttribute("allow")).toBe(false);
    expect(iframe.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(iframe.getAttribute("title")).toBe("Coffee counter");
    expect(iframe.style.height).toBe("200px");
    expect(iframe.style.colorScheme).toBe("dark");
    for (const token of ["allow-same-origin", "allow-popups", "allow-top-navigation", "allow-modals"]) {
      expect(iframe.getAttribute("sandbox")).not.toContain(token);
    }
  });

  it("gets the document's srcdoc verbatim, and only after the router listens", () => {
    const listening = vi.spyOn(window, "addEventListener");
    const host = mountAppFrame({ container, doc, title: "Coffee counter", height: 200, hostContext: { theme: "light" }, hostVersion: "test", adapter: adapter() });
    const iframe = container.querySelector("iframe")!;
    expect(iframe).toBe(host.iframe);
    expect(iframe.getAttribute("srcdoc")).toBe(doc.srcdoc);
    expect(iframe.srcdoc.startsWith('<!DOCTYPE html><meta http-equiv="Content-Security-Policy" content="')).toBe(true);
    expect(listening).toHaveBeenCalledWith("message", expect.any(Function));
    host.destroy();
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("follows a skin change: the frame's color scheme becomes the new theme", () => {
    // A View that adopts the dark theme inside a frame still marked light gets
    // an opaque canvas from Chromium (the schemes differ), a dark slab on the
    // card instead of the card showing through.
    const host = mountAppFrame({ container, doc, title: "Coffee counter", height: 200, hostContext: { theme: "light" }, hostVersion: "test", adapter: adapter() });
    expect(host.iframe.style.colorScheme).toBe("light");
    host.contextChanged({ theme: "dark" });
    expect(host.iframe.style.colorScheme).toBe("dark");
    // a change that is not a theme leaves it alone
    host.contextChanged({ containerDimensions: { width: 600, maxHeight: 500 } });
    expect(host.iframe.style.colorScheme).toBe("dark");
    host.contextChanged({ theme: "light" });
    expect(host.iframe.style.colorScheme).toBe("light");
    host.destroy();
  });
});

describe("the bridge on the desktop", () => {
  it("answers ui/initialize from the frame's own window, and nothing from any other", () => {
    const host = mountAppFrame({ container, doc, title: "Coffee counter", height: 200, hostContext: { theme: "dark" }, hostVersion: "9.9.9", adapter: adapter() });
    const view = host.iframe.contentWindow!;
    const posted = vi.spyOn(view, "postMessage");
    const request = { jsonrpc: "2.0", id: 1, method: "ui/initialize", params: { protocolVersion: "2026-01-26", appInfo: { name: "x", version: "1" }, appCapabilities: {} } };
    // another window: dropped without an answer
    window.dispatchEvent(new MessageEvent("message", { data: request, source: window }));
    expect(posted).not.toHaveBeenCalled();
    window.dispatchEvent(new MessageEvent("message", { data: request, source: view as unknown as MessageEventSource }));
    expect(posted).toHaveBeenCalledTimes(1);
    const [answer, target] = posted.mock.calls[0]! as [any, string];
    expect(target).toBe("*");
    expect(answer).toMatchObject({ jsonrpc: "2.0", id: 1, result: { hostInfo: { name: "mausbot", version: "9.9.9" }, hostContext: { theme: "dark" } } });
    // a bot's page has no server tools
    expect(answer.result.hostCapabilities.serverTools).toBeUndefined();
    expect(answer.result.hostCapabilities.sandbox).toEqual({ permissions: {}, csp: { connectDomains: doc.network.connect, resourceDomains: doc.network.resources } });
    host.destroy();
  });

  it("sizes the frame from size-changed, and asks the View before tearing down", async () => {
    const calls = adapter();
    const host = mountAppFrame({ container, doc, title: "Coffee counter", height: 200, hostContext: { containerDimensions: { width: 600, maxHeight: 500 } }, hostVersion: "1", adapter: calls });
    const view = host.iframe.contentWindow!;
    const posted = vi.spyOn(view, "postMessage");
    const send = (data: unknown) => window.dispatchEvent(new MessageEvent("message", { data, source: view as unknown as MessageEventSource }));
    send({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: {} });
    send({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
    send({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 9000 } });
    expect(calls.resize).toHaveBeenLastCalledWith(500);
    expect(host.iframe.style.height).toBe("500px");
    const done = host.teardown();
    const request = posted.mock.calls.map(([message]) => message as any).find((message) => message.method === "ui/resource-teardown");
    expect(request).toBeTruthy();
    send({ jsonrpc: "2.0", id: request.id, result: {} });
    await done;
    expect(container.querySelector("iframe")).toBeNull();
  });
});

describe("a row leaving the page", () => {
  type Movable = { moveBefore?: (node: Node, child: Node | null) => void };
  const proto = HTMLElement.prototype as unknown as Movable;
  const original = proto.moveBefore;
  afterEach(() => {
    if (original) proto.moveBefore = original;
    else delete proto.moveBefore;
    document.getElementById("omb-app-frames-leaving")?.remove();
  });

  function initialized() {
    const calls = adapter();
    const host = mountAppFrame({ container, doc, title: "Coffee counter", height: 200, hostContext: {}, hostVersion: "1", adapter: calls });
    const view = host.iframe.contentWindow!;
    const posted = vi.spyOn(view, "postMessage");
    const send = (data: unknown) => window.dispatchEvent(new MessageEvent("message", { data, source: view as unknown as MessageEventSource }));
    send({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: {} });
    send({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
    const teardownRequest = () => posted.mock.calls.map(([message]) => message as any).find((message) => message.method === "ui/resource-teardown");
    return { host, calls, send, teardownRequest };
  }

  /** Chromium's state-keeping move. happy-dom has none, and re-inserting a
   * frame there gives it a new window, so the stub records the move and
   * leaves the frame (and its window) where it is. */
  function stubMove() {
    const moves: Array<{ place: HTMLElement; node: Node }> = [];
    proto.moveBefore = function (this: HTMLElement, node: Node) { moves.push({ place: this, node }); };
    return moves;
  }

  it("moves the running frame somewhere hidden, asks the View to tear down, and removes it once it answers", async () => {
    const moves = stubMove();
    const { host, calls, send, teardownRequest } = initialized();
    const iframe = host.iframe;
    const width = iframe.style.width;
    host.retire();
    const place = document.getElementById("omb-app-frames-leaving")!;
    expect(moves).toEqual([{ place, node: iframe }]);
    expect(iframe.style.width).not.toBe(width);
    expect(place.getAttribute("aria-hidden")).toBe("true");
    expect(place.hasAttribute("inert")).toBe(true);
    // the View is asked, and is not engaged while it closes
    const request = teardownRequest();
    expect(request).toBeTruthy();
    expect(host.engaged()).toBe(false);
    // a size it reports while closing is not the row's any more
    send({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 300 } });
    expect(calls.resize).not.toHaveBeenCalled();
    send({ jsonrpc: "2.0", id: request.id, result: {} });
    await tick();
    expect(iframe.isConnected).toBe(false);
  });

  it("removes a frame whose View never answers after a second", async () => {
    stubMove();
    vi.useFakeTimers();
    try {
      const { host, teardownRequest } = initialized();
      host.retire();
      expect(teardownRequest()).toBeTruthy();
      expect(host.iframe.isConnected).toBe(true);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(host.iframe.isConnected).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes the frame at once where a frame cannot move without reloading, still asking the View", () => {
    delete proto.moveBefore;
    const { host, teardownRequest } = initialized();
    host.retire();
    expect(teardownRequest()).toBeTruthy();
    expect(host.iframe.isConnected).toBe(false);
    expect(document.getElementById("omb-app-frames-leaving")).toBeNull();
  });
});

describe("engagement", () => {
  function setup() {
    const iframe = createAppIframe(document, "App", 100);
    container.appendChild(iframe);
    const engagement = trackAppEngagement(iframe);
    return { iframe, engagement };
  }

  it("is off until focus enters the frame while the pointer is over it", async () => {
    const { iframe, engagement } = setup();
    expect(engagement.engaged()).toBe(false);
    // focus moves into the frame with the pointer elsewhere: not engaged
    iframe.focus();
    window.dispatchEvent(new Event("blur"));
    await tick();
    expect(document.activeElement).toBe(iframe);
    expect(engagement.engaged()).toBe(false);
    // the pointer over it, focus entering again: engaged
    window.dispatchEvent(new Event("focus"));
    iframe.dispatchEvent(new Event("pointerenter"));
    window.dispatchEvent(new Event("blur"));
    await tick();
    expect(engagement.engaged()).toBe(true);
    // focus back in the app: not any more
    window.dispatchEvent(new Event("focus"));
    expect(engagement.engaged()).toBe(false);
    engagement.dispose();
  });

  it("counts focus that entered by Tab, and ends when focus leaves the frame", async () => {
    const { iframe, engagement } = setup();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    iframe.focus();
    iframe.dispatchEvent(new Event("focus"));
    await tick();
    expect(engagement.engaged()).toBe(true);
    const other = document.createElement("button");
    container.appendChild(other);
    other.focus();
    expect(engagement.engaged()).toBe(false);
    engagement.dispose();
  });

  it("counts focus that entered where the pointer was last seen at the frame's edge (a frame in its own process)", async () => {
    const { iframe, engagement } = setup();
    vi.spyOn(iframe, "getBoundingClientRect").mockReturnValue({ left: 100, top: 200, right: 700, bottom: 400, width: 600, height: 200, x: 100, y: 200, toJSON() {} } as DOMRect);
    const move = (x: number, y: number) => document.dispatchEvent(Object.assign(new Event("pointermove", { bubbles: true }), { clientX: x, clientY: y }));
    // last seen far above the frame: focus entering it is not the person's
    move(300, 20);
    iframe.focus();
    window.dispatchEvent(new Event("blur"));
    await tick();
    expect(engagement.engaged()).toBe(false);
    // last seen at its top edge, on the way in: it is
    window.dispatchEvent(new Event("focus"));
    move(300, 198);
    window.dispatchEvent(new Event("blur"));
    await tick();
    expect(engagement.engaged()).toBe(true);
    // the pointer left the window since: not any more
    window.dispatchEvent(new Event("focus"));
    document.documentElement.dispatchEvent(new Event("mouseleave"));
    window.dispatchEvent(new Event("blur"));
    await tick();
    expect(engagement.engaged()).toBe(false);
    engagement.dispose();
  });

  it("a frame that takes focus by itself while the pointer is away is not engaged", async () => {
    const { iframe, engagement } = setup();
    iframe.dispatchEvent(new Event("pointerenter"));
    iframe.dispatchEvent(new Event("pointerleave"));
    iframe.focus();
    iframe.dispatchEvent(new Event("focus"));
    await tick();
    expect(engagement.engaged()).toBe(false);
    engagement.dispose();
  });
});
