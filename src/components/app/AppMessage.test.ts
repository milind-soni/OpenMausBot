// @vitest-environment happy-dom
// happy-dom runs no script in the frame, so the View is played by message events from the frame's window.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BotEditorStore, type Message, type useStore } from "@/state/store";
import type { AppDocument, AppPayload } from "../../../shared/app";
import { APP_SAMPLES, MCP_APP_SAMPLES } from "../../../shared/app-samples";
import { botHtmlDocument, mcpAppDocument } from "../../../shared/app-frame/document";
import { createAppPool, type AppPool } from "./app-pool";
import { AppMessage, forgetAppRows } from "./AppMessage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const counter = APP_SAMPLES.counter!;
const excalidraw = MCP_APP_SAMPLES.excalidraw!;

const htmlPayload = (more: Partial<AppPayload> = {}): AppPayload => ({
  v: 1, source: "html", title: counter.title, doc: "d0", rev: 0, bytes: 1234, height: 200, border: true,
  network: { connect: ["https://cdnjs.cloudflare.com"], resources: ["https://cdnjs.cloudflare.com", "https://fonts.googleapis.com"] },
  ...more,
});
const mcpPayload = (more: Partial<AppPayload> = {}): AppPayload => ({
  v: 1, source: "mcp", title: "Create view", doc: "x0", rev: 0, bytes: 432_000, border: true,
  network: { connect: ["https://esm.sh"], resources: ["https://esm.sh"], refused: ["http://localhost:8080", "https://example.com/path"] },
  mcp: { server: "excalidraw", serverTitle: "Excalidraw", tool: "create_view", resourceUri: excalidraw.resourceUri },
  ...more,
});
const row = (app: AppPayload | undefined, id = "a1"): Message => ({ id, role: "bot", kind: "app", at: 1, text: "[App] Coffee counter\nCups of coffee today", app });

const htmlDoc = (rev = 0, html = counter.html): AppDocument => botHtmlDocument({ messageId: "a1", rev, html });
const mcpDoc = (more: Partial<Parameters<typeof mcpAppDocument>[0]> = {}): AppDocument => mcpAppDocument({
  messageId: "a1", rev: 0, html: excalidraw.html, network: { connect: ["https://esm.sh"], resources: ["https://esm.sh"] },
  tool: excalidraw.tool, toolInput: excalidraw.toolInput, toolResult: excalidraw.toolResult,
  can: { serverTools: true, serverResources: true, message: true, openLinks: true, modelContext: true }, ...more,
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fetchMock = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>();
const dispatch = vi.fn();
const flushBotPatches = vi.fn(async () => null);
const store = { state: {}, dispatch, flushBotPatches } as unknown as ReturnType<typeof useStore>;

let host: HTMLDivElement;
let root: Root;
let pool: AppPool;

const view = (message: Message) => createElement(BotEditorStore, {
  value: store,
  children: createElement(AppMessage, { botId: "pepper", botName: "Pepper", threadId: "t1", message, pool }),
});
const mount = async (message: Message) => {
  await act(async () => { root.render(view(message)); });
  await settle();
};
/** Let fetches, pool grants and effects run. */
const settle = () => act(async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); });
const find = <T extends Element = HTMLElement>(selector: string) => host.querySelector<T>(selector);
const button = (label: string) => Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((element) => element.textContent?.trim() === label || element.getAttribute("aria-label") === label);
const frame = () => find<HTMLIFrameElement>("iframe")!;
/** The View speaks: a message event whose source is the frame's window. */
const fromView = (data: unknown) => act(async () => {
  window.dispatchEvent(new MessageEvent("message", { data, source: frame().contentWindow as unknown as MessageEventSource }));
  await new Promise((resolve) => setTimeout(resolve, 0));
});
/** What the host posted to the View. */
let toView: any[] = [];
function listen() {
  toView = [];
  vi.spyOn(frame().contentWindow!, "postMessage").mockImplementation((message: unknown) => { toView.push(message); });
}
async function handshake() {
  listen();
  await fromView({ jsonrpc: "2.0", id: "init", method: "ui/initialize", params: {} });
  await fromView({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
}
/** The person clicks into the frame. */
async function engage() {
  await act(async () => {
    frame().dispatchEvent(new Event("pointerenter"));
    frame().focus();
    window.dispatchEvent(new Event("blur"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
const posts = (match: string) => fetchMock.mock.calls.filter(([path, init]) => path.includes(match) && init?.method === "POST").map(([, init]) => JSON.parse(String(init!.body)));

beforeEach(() => {
  fetchMock.mockReset();
  dispatch.mockReset();
  flushBotPatches.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("ogb", { openExternal: vi.fn(async () => true) });
  // happy-dom's observer never reports: without one, a row counts as in view
  vi.stubGlobal("IntersectionObserver", undefined);
  pool = createAppPool({ limit: 3 });
  forgetAppRows();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the row before its frame runs", () => {
  it("draws its chrome to markup: title, who made it, info and Reload, and a box at its height", () => {
    const markup = renderToStaticMarkup(view(row(htmlPayload())));
    expect(markup).toContain('data-app="a1"');
    expect(markup).toContain("Coffee counter");
    expect(markup).toContain("Page made by Pepper");
    expect(markup).toContain('aria-label="About this app"');
    expect(markup).toContain('aria-label="Reload app"');
    expect(markup).toContain("height:200px");
    expect(markup).not.toContain("<iframe");
  });

  it("names the server an MCP app came from", () => {
    expect(renderToStaticMarkup(view(row(mcpPayload())))).toContain("App from Excalidraw");
  });

  it("reads as its text when there is no payload", () => {
    const markup = renderToStaticMarkup(view(row(undefined)));
    expect(markup).not.toContain("data-app=");
    expect(markup).toContain("Cups of coffee today");
  });

  it("shows its text and why when nothing could be stored", () => {
    const markup = renderToStaticMarkup(view(row(htmlPayload({ doc: "", blocked: "too-large" }))));
    expect(markup).toContain('data-app-state="unavailable"');
    expect(markup).toContain("This app is too large to store");
    expect(markup).toContain("Cups of coffee today");
    expect(markup).not.toContain('aria-label="Reload app"');
  });
});

describe("a bot's page", () => {
  beforeEach(() => {
    fetchMock.mockImplementation(async (path) => /\/app(\?|$)/.test(path) ? json(200, htmlDoc()) : json(202, { ok: true }));
  });

  it("mounts the document it fetched, verbatim, in the sandboxed frame", async () => {
    await mount(row(htmlPayload()));
    expect(fetchMock.mock.calls[0]![0]).toBe(`/api/threads/t1/messages/a1/app?origin=${encodeURIComponent(window.location.origin)}`);
    expect(find("[data-app]")!.getAttribute("data-app-state")).toBe("live");
    expect(frame().getAttribute("sandbox")).toBe("allow-scripts allow-forms");
    expect(frame().hasAttribute("allow")).toBe(false);
    expect(frame().getAttribute("srcdoc")).toBe(htmlDoc().srcdoc);
    expect(pool.live()).toEqual(["t1:a1"]);
  });

  it("lists what the frame may reach, its size, and what is always off", async () => {
    await mount(row(htmlPayload()));
    await act(async () => button("About this app")!.click());
    const info = find("[data-app-info]")!;
    expect(info.textContent).toContain("https://cdnjs.cloudflare.com, https://fonts.googleapis.com");
    expect(info.textContent).toContain("1.2 KB");
    expect(info.textContent).toContain("Camera, microphone, location, clipboard, pop-ups and downloads");
    expect(button("About this app")!.getAttribute("aria-expanded")).toBe("true");
  });

  it("sends mausbot.send as the person's message from this app, only while they use it", async () => {
    await mount(row(htmlPayload()));
    await handshake();
    const ask = { jsonrpc: "2.0", id: "m1", method: "ui/message", params: { role: "user", content: [{ type: "text", text: "I have had 3 cups." }] } };
    await fromView(ask);
    expect(toView.find((message) => message.id === "m1")).toMatchObject({ error: { code: -32000 } });
    expect(posts("/messages")).toEqual([]);
    await engage();
    await fromView({ ...ask, id: "m2" });
    await settle();
    expect(flushBotPatches).toHaveBeenCalledWith("pepper");
    expect(posts("/api/bots/pepper/messages")).toEqual([{ threadId: "t1", sendId: expect.any(String), appMessage: { messageId: "a1", text: "I have had 3 cups." } }]);
    expect(toView.find((message) => message.id === "m2")).toEqual({ jsonrpc: "2.0", id: "m2", result: {} });
  });

  it("keeps what the page says it shows for the model, and follows its height", async () => {
    await mount(row(htmlPayload()));
    await handshake();
    await fromView({ jsonrpc: "2.0", id: "c1", method: "ui/update-model-context", params: { content: [{ type: "text", text: "3 cups" }] } });
    await settle();
    expect(posts("/apps/a1/context")).toEqual([{ threadId: "t1", content: [{ type: "text", text: "3 cups" }] }]);
    await fromView({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 333 } });
    expect(find<HTMLElement>("[data-app-box]")!.style.height).toBe("333px");
    expect(frame().style.height).toBe("333px");
  });

  it("opens a link the person clicked through the desktop's browser", async () => {
    await mount(row(htmlPayload()));
    await handshake();
    await engage();
    await fromView({ jsonrpc: "2.0", id: "l1", method: "ui/open-link", params: { url: "https://example.com/a" } });
    expect((window as unknown as { ogb: { openExternal: ReturnType<typeof vi.fn> } }).ogb.openExternal).toHaveBeenCalledWith("https://example.com/a");
  });

  it("update_html mounts the new page at the same height, after the old one is asked to go", async () => {
    await mount(row(htmlPayload()));
    await handshake();
    await fromView({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 260 } });
    const old = frame();
    const oldView = toView;
    fetchMock.mockImplementation(async (path) => /\/app(\?|$)/.test(path) ? json(200, htmlDoc(1, counter.html.replace("Cups of coffee today", "Cups today"))) : json(202, {}));
    await act(async () => { root.render(view(row(htmlPayload({ doc: "d1", rev: 1 })))); });
    await settle();
    // the old View was asked to tear down; answer it
    const teardown = oldView.find((message) => message.method === "ui/resource-teardown");
    expect(teardown).toBeTruthy();
    await act(async () => {
      window.dispatchEvent(new MessageEvent("message", { data: { jsonrpc: "2.0", id: teardown.id, result: {} }, source: old.contentWindow as unknown as MessageEventSource }));
    });
    await settle();
    expect(frame()).not.toBe(old);
    expect(frame().getAttribute("srcdoc")).toContain("Cups today");
    expect(find<HTMLElement>("[data-app-box]")!.style.height).toBe("260px");
  });

  it("folds to its header when the View asks to be closed, and opens again", async () => {
    await mount(row(htmlPayload()));
    await handshake();
    await fromView({ jsonrpc: "2.0", method: "ui/notifications/request-teardown", params: {} });
    const request = toView.find((message) => message.method === "ui/resource-teardown");
    await fromView({ jsonrpc: "2.0", id: request.id, result: {} });
    await settle();
    expect(find("[data-app]")!.getAttribute("data-app-state")).toBe("collapsed");
    expect(find("iframe")).toBeNull();
    expect(pool.live()).toEqual([]);
    await act(async () => button("Open again")!.click());
    await settle();
    expect(find("[data-app]")!.getAttribute("data-app-state")).toBe("live");
  });

  it("says why when its page is not stored here", async () => {
    fetchMock.mockImplementation(async () => json(404, { error: "This app's page is not stored on this computer." }));
    await mount(row(htmlPayload()));
    expect(find("[data-app]")!.getAttribute("data-app-state")).toBe("unavailable");
    expect(find("[data-app-strip]")!.textContent).toContain("This app's page is not stored on this computer.");
  });

  it("offers to reconnect when the server did not answer", async () => {
    fetchMock.mockImplementation(async () => { throw new TypeError("Failed to fetch"); });
    await mount(row(htmlPayload()));
    expect(find("[data-app-strip]")!.textContent).toContain("Reconnect to use this app");
    fetchMock.mockImplementation(async (path) => /\/app(\?|$)/.test(path) ? json(200, htmlDoc()) : json(202, {}));
    await act(async () => button("Try again")!.click());
    await settle();
    expect(find("[data-app]")!.getAttribute("data-app-state")).toBe("live");
    expect(find("[data-app-strip]")).toBeNull();
  });
});

describe("an MCP app", () => {
  it("hands a write the bot's level declines straight back to the View, with no card of its own", async () => {
    fetchMock.mockImplementation(async (path) => /\/app(\?|$)/.test(path) ? json(200, mcpDoc())
      : json(403, { error: { code: -32000, message: "This bot asks before it changes anything, so its apps can only look." } }));
    await mount(row(mcpPayload()));
    await handshake();
    // the tool's input and result reach the View right after it initialized, once
    expect(toView.filter((message) => message.method === "ui/notifications/tool-input")).toHaveLength(1);
    expect(toView.find((message) => message.method === "ui/notifications/tool-result").params).toMatchObject(excalidraw.toolResult);
    await engage();
    await fromView({ jsonrpc: "2.0", id: "t1", method: "tools/call", params: { name: "export_to_excalidraw", arguments: {} } });
    await settle();
    expect(posts("/rpc")).toHaveLength(1);
    expect(posts("/rpc")[0]).not.toHaveProperty("confirmed");
    expect(toView.find((message) => message.id === "t1")).toMatchObject({ error: { code: -32000 } });
    expect(button("Allow")).toBeFalsy();
    expect(find("[data-app-strip]")).toBeNull();
  });

  it("says sign in again when its server signed the person out", async () => {
    fetchMock.mockImplementation(async (path) => /\/app(\?|$)/.test(path) ? json(200, mcpDoc())
      : json(401, { error: { code: -32000, message: "Sign in to Excalidraw again" }, signIn: { server: "excalidraw" } }));
    await mount(row(mcpPayload()));
    await handshake();
    await fromView({ jsonrpc: "2.0", id: "r1", method: "tools/list", params: {} });
    await settle();
    expect(toView.find((message) => message.id === "r1")).toEqual({ jsonrpc: "2.0", id: "r1", error: { code: -32000, message: "Sign-in needed" } });
    expect(find("[data-app-strip]")!.textContent).toContain("Sign in to Excalidraw again");
    await act(async () => button("Sign in")!.click());
    expect(dispatch).toHaveBeenCalledWith({ type: "togglePlugins", open: true, surface: "mcp" });
  });

  it("draws the document's own reason under a read-only frame", async () => {
    fetchMock.mockImplementation(async () => json(200, mcpDoc({
      can: { serverTools: false, serverResources: false, message: true, openLinks: true, modelContext: true },
      blocked: { reason: "server-removed", text: "Excalidraw is no longer connected" },
    })));
    await mount(row(mcpPayload()));
    expect(find("[data-app]")!.getAttribute("data-app-state")).toBe("live");
    expect(find("[data-app-strip]")!.textContent).toContain("Excalidraw is no longer connected");
  });

  it("draws no card around a view that asked for none", async () => {
    fetchMock.mockImplementation(async () => json(200, mcpDoc()));
    await mount(row(mcpPayload({ border: false })));
    expect(find("[data-app] > div")!.className).not.toContain("rounded-3xl");
  });
});
