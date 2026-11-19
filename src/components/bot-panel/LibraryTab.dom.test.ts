// @vitest-environment happy-dom
import { act, createElement, Fragment, useReducer } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { Action, AppState, Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({ store: null as null | { state: AppState; dispatch: (action: Action) => void } }));
vi.mock("@/state/store", async (importOriginal) => ({ ...await importOriginal<typeof import("@/state/store")>(), useStore: () => fixture.store! }));
vi.mock("../app/AppFrame", async () => {
  const { createElement: h } = await import("react");
  return { AppFrame: (props: { botId: string; threadId: string; doc: { srcdoc: string } }) => h("div", { "data-frame": `${props.botId}/${props.threadId}` }, props.doc.srcdoc) };
});

const { reducer, initialState } = await import("@/state/store");
const { setAdvancedMode } = await import("@/lib/interface-mode");
const { LibraryTab } = await import("./LibraryTab");
const { WebPanelPage } = await import("../WebPanelPage");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const bot = {
  id: "scout", threadId: "t-plan", name: "Scout", title: "", description: "", color: "green", unread: false, messages: [],
  modelSelection: { instanceId: "x", model: "x" },
  tasks: [{ threadId: "t-plan", title: "Planning" }, { threadId: "t-week", title: "Weekly numbers" }],
} as unknown as Bot;
const fetched: string[] = [];
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let host: HTMLDivElement;
let root: Root;

function App() {
  const [state, dispatch] = useReducer(reducer, { ...initialState, bots: [bot], selectedId: bot.id, settingsOpen: true });
  fixture.store = { state, dispatch };
  return createElement(Fragment, null, createElement(LibraryTab, { bot, onOpen: () => {} }), state.activeView === "web-panel" ? createElement(WebPanelPage) : null);
}

beforeEach(() => {
  fetched.length = 0;
  setAdvancedMode(true);
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const path = new URL(input, "http://x").pathname;
    fetched.push(path);
    if (path === "/api/bots/scout/library") {
      return reply(200, { apps: [{ threadId: "t-week", messageId: "m-board", title: "Board" }, { threadId: "t-plan", messageId: "m-sales", title: "Sales" }], pages: [] });
    }
    if (path === "/api/threads/t-week/messages/m-board/app") return reply(200, { srcdoc: "board page", can: {} });
    return reply(404, { error: "not here" });
  }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const settle = () => act(async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); });
const button = (text: string) => [...host.querySelectorAll("button")].find((candidate) => candidate.textContent === text)!;

it("lists pages the bot made in another conversation and opens one full size, to pin or to find in its chat", async () => {
  act(() => root.render(createElement(App)));
  await settle();

  const rows = [...host.querySelectorAll('[data-panel-row="app"]')].map((row) => row.textContent);
  expect(rows).toEqual(["BoardWeekly numbers", "SalesPlanning"]);
  expect(host.textContent).not.toContain("From this conversation");

  await act(async () => host.querySelector<HTMLButtonElement>('[data-panel-row="app"]')!.click());
  await settle();
  expect(fixture.store!.state.activeView).toBe("web-panel");
  expect(fetched).toContain("/api/threads/t-week/messages/m-board/app");
  expect(host.querySelector("h1")?.textContent).toBe("Board");
  expect(host.querySelector("[data-frame]")?.textContent).toBe("board page");

  act(() => button("Pin to sidebar").click());
  expect(button("Unpin").getAttribute("aria-pressed")).toBe("true");
  expect(fixture.store!.state.activeView).toBe("web-panel");

  act(() => button("Open in chat").click());
  expect(fixture.store!.state.activeView).toBe("chat");
  expect(fixture.store!.state.focusMessage).toMatchObject({ threadId: "t-week", messageId: "m-board" });
});
