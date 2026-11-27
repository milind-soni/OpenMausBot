// @vitest-environment happy-dom
// A saved app in its own window: the app and its slim header only, and Go to chat hands the chat to the main window.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { botHtmlDocument } from "../shared/app-frame/document";
import type { LocalApp } from "../shared/local-apps";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => vi.fn());
vi.mock("@/state/api", () => ({ api, ApiError: class extends Error { status = 0; } }));

const { LocalAppWindow } = await import("./local-app-window");
const { resetLocalApps } = await import("@/lib/local-apps");

const APP: LocalApp = { id: "la_board0000000000000", name: "Sales board", botId: "mira", bot: { name: "Mira", color: "blue" }, threadId: "sales", messageId: "m1",
  versions: [{ rev: 0, at: 1 }], rev: 0, createdAt: 1, updatedAt: 1, manifest: { name: "Sales board" }, chat: true };

let root: Root;
let host: HTMLElement;
beforeEach(() => {
  api.mockReset();
  api.mockImplementation(async (path: string) => (path === "/api/local-apps" ? { apps: [APP] } : botHtmlDocument({ messageId: "m1", rev: 0, html: "<p>board</p>" })));
  resetLocalApps();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const show = async () => {
  await act(async () => root.render(createElement(LocalAppWindow, { id: APP.id })));
  await act(async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); });
};

describe("an app's own window", () => {
  it("shows only the app, sandboxed, under its name, with nothing to go back to", async () => {
    await show();
    expect(host.querySelector("h1")?.textContent).toBe("Sales board");
    expect(host.querySelector("iframe")?.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
    expect(host.querySelector("button[aria-label='Back to apps']")).toBeNull();
    expect(document.title).toContain("Sales board");
  });

  it("hands Go to chat to the main window as a chat link", async () => {
    const openChat = vi.fn(async () => true);
    vi.stubGlobal("ogb", { localApps: { openWindow: vi.fn(), openChat } });
    await show();
    const go = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Go to chat"))!;
    act(() => go.click());
    expect(openChat).toHaveBeenCalledWith("openmausbot://thread/sales?bot=mira");
  });

  it("offers no chat outside the desktop app", async () => {
    await show();
    expect([...host.querySelectorAll("button")].some((button) => button.textContent?.includes("Go to chat"))).toBe(false);
  });
});
