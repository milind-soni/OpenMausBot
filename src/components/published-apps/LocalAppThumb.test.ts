// @vitest-environment happy-dom
// A saved app's card picture: its own page, small, sandboxed and out of reach; its mark until then and on failure.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LocalApp } from "../../../shared/local-apps";
import { botHtmlDocument } from "../../../shared/app-frame/document";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => vi.fn());
vi.mock("@/state/api", () => ({ api, ApiError: class extends Error { status = 0; } }));
const { LocalAppThumb } = await import("./LocalAppThumb");

const app = (id: string): LocalApp => ({ id, name: "Sales board", botId: "mira", bot: { name: "Mira", color: "blue" }, threadId: "t", messageId: "m",
  versions: [{ rev: 0, at: 1 }], rev: 0, createdAt: 1, updatedAt: 1, manifest: { name: "Sales board" }, chat: true });

let root: Root;
let host: HTMLElement;
let seen: ((entries: Array<{ isIntersecting: boolean }>) => void) | null;
beforeEach(() => {
  api.mockReset();
  seen = null;
  vi.stubGlobal("IntersectionObserver", class { constructor(cb: typeof seen) { seen = cb; } observe() {} disconnect() {} });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const show = async (id: string) => {
  await act(async () => root.render(createElement(LocalAppThumb, { app: app(id) })));
};
const settle = () => act(async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); });
const thumb = () => host.querySelector<HTMLElement>("[data-local-app-thumb]")!;

describe("a saved app's card picture", () => {
  it("shows the app's mark, and fetches nothing until the card is on screen", async () => {
    await show("la_thumb000000000001");
    expect(thumb().dataset.localAppThumb).toBe("mark");
    expect(thumb().textContent).toBe("S");
    expect(api).not.toHaveBeenCalled();
    expect(host.querySelector("iframe")).toBeNull();
  });

  it("draws the page in a frame with the chat's sandbox that takes no pointer, keyboard or focus", async () => {
    api.mockResolvedValue(botHtmlDocument({ messageId: "m", rev: 0, html: "<p>board</p>" }));
    await show("la_thumb000000000002");
    await act(async () => seen!([{ isIntersecting: true }]));
    await settle();
    const frame = host.querySelector("iframe")!;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
    expect(frame.getAttribute("tabindex")).toBe("-1");
    expect(frame.getAttribute("aria-hidden")).toBe("true");
    expect(frame.hasAttribute("inert")).toBe(true);
    expect(frame.className).toContain("pointer-events-none");
    expect(frame.getAttribute("srcdoc")).toContain("<p>board</p>");
    expect(api.mock.calls[0]![0]).toContain("/api/local-apps/la_thumb000000000002/app?");
  });

  it("keeps the mark when the page can't be fetched, and while the person saves data", async () => {
    api.mockRejectedValue(new Error("offline"));
    await show("la_thumb000000000003");
    await act(async () => seen!([{ isIntersecting: true }]));
    await settle();
    expect(host.querySelector("iframe")).toBeNull();
    expect(thumb().dataset.localAppThumb).toBe("mark");
    act(() => root.unmount());
    root = createRoot(host);
    vi.stubGlobal("navigator", { ...navigator, connection: { saveData: true } });
    seen = null;
    await show("la_thumb000000000004");
    expect(seen).toBeNull();
  });

  it("answers nothing the page asks: no data, state or message reaches a server", async () => {
    api.mockResolvedValue(botHtmlDocument({ messageId: "m", rev: 0, html: "<p>board</p>", uses: ["data", "state"] }));
    await show("la_thumb000000000005");
    await act(async () => seen!([{ isIntersecting: true }]));
    await settle();
    const frame = host.querySelector("iframe")!;
    const posted: unknown[] = [];
    vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation((message: unknown) => { posted.push(message); });
    for (const data of [{ jsonrpc: "2.0", id: "init", method: "ui/initialize", params: {} },
      { jsonrpc: "2.0", id: "q", method: "mausbot/data/query", params: { sql: "SELECT 1" } },
      { jsonrpc: "2.0", id: "s", method: "mausbot/state/set", params: { key: "a", value: 1 } },
      { jsonrpc: "2.0", id: "m", method: "ui/message", params: { role: "user", content: [{ type: "text", text: "hi" }] } }]) {
      await act(async () => { window.dispatchEvent(new MessageEvent("message", { data, source: frame.contentWindow as unknown as MessageEventSource })); });
    }
    await settle();
    expect(posted).toEqual([]);
    expect(api).toHaveBeenCalledTimes(1);
  });
});

