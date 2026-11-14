import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { afterEach, describe, expect, it } from "vitest";

import { APP_HOST_HTML, appHostHash, appHostHashOf, buildAppHostHtml } from "../../scripts/build-app-host.ts";
import type { AppDocument } from "../app.ts";
import { BOT_HTML_CSP, BOT_HTML_NETWORK } from "./csp.ts";
import { startAppHostPage, type AppHostFromNative, type AppHostToNative } from "./host-page.ts";

const DOC: AppDocument = {
  v: 1, messageId: "m1", rev: 0, srcdoc: "<!DOCTYPE html><p>page</p>", csp: BOT_HTML_CSP,
  network: { connect: [...BOT_HTML_NETWORK.connect], resources: [...BOT_HTML_NETWORK.resources] },
  can: { serverTools: false, serverResources: false, message: true, openLinks: true, modelContext: true },
};

const pages: Window[] = [];
afterEach(async () => { for (const page of pages.splice(0)) await page.happyDOM.close(); });

function setup() {
  const win = new Window();
  pages.push(win);
  const toNative: AppHostToNative[] = [];
  const api = startAppHostPage(win as unknown as globalThis.Window, { send: (message) => { toNative.push(structuredClone(message)); } })!;
  const frame = () => win.document.querySelector("iframe")!;
  const fromView: unknown[] = [];
  /** A message the View posts to its parent. */
  const viewSays = (data: unknown) => {
    win.dispatchEvent(new win.MessageEvent("message", { data, source: frame().contentWindow as never }));
  };
  const load = () => {
    api.load({ v: 1, doc: DOC, hostContext: { theme: "light" }, limits: { maxHeight: 400, height: 220 }, hostVersion: "1.4.0" });
    const view = frame().contentWindow!;
    view.postMessage = ((data: unknown) => { fromView.push(structuredClone(data)); }) as never;
  };
  const tick = () => new Promise((done) => setTimeout(done, 0));
  return { win, api, frame, toNative, fromView, viewSays, load, tick };
}

describe("app-host.html", () => {
  it("is what the build script makes, and carries the hash of its body on its first line", async () => {
    const committed = readFileSync(APP_HOST_HTML, "utf8");
    expect(committed, "run: node --experimental-strip-types scripts/build-app-host.ts").toBe(await buildAppHostHtml());
    const hash = appHostHashOf(committed);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(appHostHash(committed.slice(committed.indexOf("\n") + 1))).toBe(hash);
    // One script, no policy of its own, and nothing that could reach the network.
    expect(committed.match(/<script/g)).toHaveLength(1);
    expect(committed).not.toMatch(/Content-Security-Policy|https?:\/\/(?!www\.w3\.org)/);
  });
});

describe("the host page", () => {
  it("says ready, and holds the app in a frame sandboxed exactly as rule 1 says", () => {
    const page = setup();
    expect(page.toNative).toEqual([{ v: 1, type: "ready" }]);
    page.load();
    const frame = page.frame();
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
    expect(frame.hasAttribute("allow")).toBe(false);
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.getAttribute("srcdoc")).toBe(DOC.srcdoc);
    expect(frame.style.height).toBe("220px");
    expect(page.win.document.querySelectorAll("iframe")).toHaveLength(1);
    // A second load replaces the frame.
    page.load();
    expect(page.win.document.querySelectorAll("iframe")).toHaveLength(1);
  });

  it("runs the bridge: initialize, initialized, size, and a message that waits for native's reply", async () => {
    const page = setup();
    page.load();
    page.viewSays({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: { protocolVersion: "2026-01-26" } });
    await page.tick();
    expect(page.fromView[0]).toMatchObject({ id: 1, result: { hostInfo: { name: "mausbot", version: "1.4.0" }, hostContext: { theme: "light" } } });
    page.viewSays({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
    expect(page.toNative.at(-1)).toEqual({ v: 1, type: "initialized" });
    page.viewSays({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 900 } });
    expect(page.toNative.at(-1)).toEqual({ v: 1, type: "size", height: 400 });
    expect(page.frame().style.height).toBe("400px");

    // Not engaged: refused in the page, native never hears of it.
    page.viewSays({ jsonrpc: "2.0", id: 2, method: "ui/message", params: { role: "user", content: [{ type: "text", text: "hi" }] } });
    await page.tick();
    expect(page.fromView.at(-1)).toMatchObject({ id: 2, error: { code: -32000 } });
    expect(page.toNative.filter((message) => message.type === "call")).toEqual([]);

    page.api.engaged(Date.now());
    page.viewSays({ jsonrpc: "2.0", id: 3, method: "ui/message", params: { role: "user", content: [{ type: "text", text: "hi" }] } });
    await page.tick();
    const call = page.toNative.at(-1) as Extract<AppHostToNative, { type: "call" }>;
    expect(call).toMatchObject({ v: 1, type: "call", op: "message", params: { text: "hi" } });
    page.api.reply(call.callId, { result: {} });
    await page.tick();
    expect(page.fromView.at(-1)).toEqual({ jsonrpc: "2.0", id: 3, result: {} });
  });

  it("passes native's refusal to the View, and a teardown request and teardown to native", async () => {
    const page = setup();
    page.load();
    page.viewSays({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: {} });
    page.viewSays({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
    page.api.engaged(Date.now());
    page.viewSays({ jsonrpc: "2.0", id: 2, method: "ui/open-link", params: { url: "https://example.com" } });
    await page.tick();
    const call = page.toNative.at(-1) as Extract<AppHostToNative, { type: "call" }>;
    expect(call).toMatchObject({ op: "open-link", params: { url: "https://example.com/" } });
    page.api.reply(call.callId, { error: { code: -32000, message: "Offline" } });
    await page.tick();
    expect(page.fromView.at(-1)).toEqual({ jsonrpc: "2.0", id: 2, error: { code: -32000, message: "Offline" } });

    page.viewSays({ jsonrpc: "2.0", method: "ui/notifications/request-teardown" });
    expect(page.toNative.at(-1)).toEqual({ v: 1, type: "teardown-request" });
    const done = page.api.teardown();
    const ask = page.fromView.at(-1) as { id: string; method: string };
    expect(ask.method).toBe("ui/resource-teardown");
    page.viewSays({ jsonrpc: "2.0", id: ask.id, result: {} });
    await done;
    expect(page.toNative.at(-1)).toEqual({ v: 1, type: "torn-down" });
    expect(page.win.document.querySelector("iframe")).toBeNull();
  });

  it("ignores a message from any window but the frame's", async () => {
    const page = setup();
    page.load();
    page.win.dispatchEvent(new page.win.MessageEvent("message", { data: { jsonrpc: "2.0", id: 1, method: "ui/initialize" }, source: page.win as never }));
    await page.tick();
    expect(page.fromView).toEqual([]);
  });

  it("speaks JSON to Android's injected object, and leaves that object in place", async () => {
    const win = new Window();
    pages.push(win);
    const sent: string[] = [];
    const injected: { postMessage(message: string): void; onmessage?: ((event: { data: unknown }) => void) | null } = {
      postMessage: (message) => { sent.push(message); },
    };
    (win as unknown as { appHost: unknown }).appHost = injected;
    const api = startAppHostPage(win as unknown as globalThis.Window);
    expect(api).not.toBeNull();
    expect((win as unknown as { appHost: unknown }).appHost).toBe(injected);
    expect((win as unknown as { mausbotAppHost: unknown }).mausbotAppHost).toBe(api);
    expect(JSON.parse(sent[0]!)).toEqual({ v: 1, type: "ready" });
    const native = (message: AppHostFromNative) => injected.onmessage!({ data: JSON.stringify(message) });
    native({ v: 1, call: "load", args: [{ v: 1, doc: DOC, hostContext: {} }] });
    expect(win.document.querySelector("iframe")?.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
    injected.onmessage!({ data: "not json" });
    injected.onmessage!({ data: JSON.stringify({ v: 2, call: "teardown" }) });
    expect(win.document.querySelector("iframe")).not.toBeNull();
    native({ v: 1, call: "teardown" });
    await expect.poll(() => win.document.querySelector("iframe")).toBeNull();
    expect(JSON.parse(sent.at(-1)!)).toEqual({ v: 1, type: "torn-down" });
  });

  it("uses iOS's message handler when there is one, and stays idle with no native side at all", () => {
    const win = new Window();
    pages.push(win);
    const sent: unknown[] = [];
    (win as unknown as { webkit: unknown }).webkit = { messageHandlers: { appHost: { postMessage: (message: unknown) => sent.push(message) } } };
    const api = startAppHostPage(win as unknown as globalThis.Window);
    expect(sent).toEqual([{ v: 1, type: "ready" }]);
    expect((win as unknown as { appHost: unknown }).appHost).toBe(api);
    const bare = new Window();
    pages.push(bare);
    expect(startAppHostPage(bare as unknown as globalThis.Window)).toBeNull();
  });
});
