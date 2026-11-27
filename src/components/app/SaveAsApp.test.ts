// @vitest-environment happy-dom
// Save as app in a page's toolbar: one click saves it under the page's title, and then it opens the app.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BotEditorStore, type Message, type useStore } from "@/state/store";
import { resetLocalApps, useOpenLocalApp } from "@/lib/local-apps";
import type { AppPayload } from "../../../shared/app";
import { botHtmlDocument } from "../../../shared/app-frame/document";
import type { LocalApp } from "../../../shared/local-apps";
import { createAppPool } from "./app-pool";
import { AppMessage, forgetAppRows } from "./AppMessage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const payload: AppPayload = { v: 1, source: "html", title: "Sales board", doc: "d0", rev: 0, bytes: 900, border: true, network: { connect: [], resources: [] } };
const row = (app: AppPayload = payload): Message => ({ id: "a1", role: "bot", kind: "app", at: 1, text: "[App] Sales board", app });
const SAVED: LocalApp = { id: "la_board0000000000000", name: "Sales board", botId: "pepper", bot: null, threadId: "t1", messageId: "a1", versions: [{ rev: 0, at: 1 }], rev: 0,
  createdAt: 1, updatedAt: 1, manifest: { name: "Sales board" }, chat: true };

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fetchMock = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>();
const dispatch = vi.fn();
const store = { state: {}, dispatch, flushBotPatches: vi.fn(async () => null) } as unknown as ReturnType<typeof useStore>;
let listed: LocalApp[];
let saveAnswer: () => Response;
let host: HTMLDivElement;
let root: Root;

function Opened() {
  return createElement("output", { "data-open": useOpenLocalApp() ?? "" });
}
const render = async (message: Message, room = false) => {
  await act(async () => {
    root.render(createElement(BotEditorStore, { value: store, children: [
      createElement(AppMessage, { key: "row", botId: "pepper", botName: "Pepper", threadId: "t1", message, pool: createAppPool({ limit: 3 }), room }),
      createElement(Opened, { key: "open" }),
    ] }));
  });
  await settle();
};
const settle = () => act(async () => { for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); });
const saveButton = () => host.querySelector<HTMLButtonElement>("[data-page-save-app]");

beforeEach(() => {
  listed = [];
  saveAnswer = () => json(201, { app: SAVED });
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (path, init) => {
    const url = new URL(path, "http://omb.test");
    if (url.pathname === "/api/local-apps" && init?.method === "POST") return saveAnswer();
    if (url.pathname === "/api/local-apps") return json(200, { apps: listed });
    return json(200, botHtmlDocument({ messageId: "a1", rev: 0, html: "<p>board</p>" }));
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("IntersectionObserver", undefined);
  dispatch.mockReset();
  forgetAppRows();
  resetLocalApps([]);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("Save as app", () => {
  it("saves the page with no questions, then reads Saved · Open and opens the app", async () => {
    await render(row());
    expect(saveButton()?.textContent).toBe("Save as app");
    await act(async () => saveButton()!.click());
    await settle();
    const post = fetchMock.mock.calls.find(([path, init]) => path.endsWith("/api/local-apps") && init?.method === "POST")!;
    expect(JSON.parse(String(post[1]!.body))).toEqual({ botId: "pepper", threadId: "t1", messageId: "a1" });
    expect(saveButton()?.textContent).toBe("Saved · Open");
    expect(document.querySelector("[role=dialog], [role=alertdialog]")).toBeNull();
    await act(async () => saveButton()!.click());
    expect(dispatch).toHaveBeenCalledWith({ type: "showPublishedApps" });
    expect(host.querySelector("[data-open]")?.getAttribute("data-open")).toBe(SAVED.id);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("knows a page that is already saved", async () => {
    resetLocalApps([SAVED]);
    await render(row());
    expect(saveButton()?.textContent).toBe("Saved · Open");
  });

  it("says so when the page couldn't be saved", async () => {
    saveAnswer = () => json(409, { error: "This page isn't stored, so it can't be saved as an app." });
    await render(row());
    await act(async () => saveButton()!.click());
    await settle();
    expect(host.querySelector("[data-page-save-app-failed]")?.textContent).toBe("This page couldn't be saved as an app. Try again.");
    expect(saveButton()?.textContent).toBe("Save as app");
  });

  it("is not offered in a room or for an app from an MCP server", async () => {
    await render(row(), true);
    expect(saveButton()).toBeNull();
    await render(row({ ...payload, source: "mcp", mcp: { server: "basic", tool: "get-time", resourceUri: "ui://basic/view" } }));
    expect(saveButton()).toBeNull();
  });
});
