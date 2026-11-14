// @vitest-environment happy-dom
import { act, createElement, type Dispatch } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { initialState, StoreProvider, useStore, type Action, type BotAnnouncement } from "./store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const bot: BotAnnouncement = {
  id: "bot", threadId: "thread", name: "Chaos", title: "", description: "", notifications: true, unread: false, color: "green",
  modelSelection: { instanceId: "fake", model: "m" }, tasks: [],
};
afterEach(() => { initialState.bots = []; vi.useRealTimers(); vi.unstubAllGlobals(); });

it("saves an Instructions edit at once when the page is left before the save's pause ends", async () => {
  vi.useFakeTimers();
  initialState.bots = [{ ...bot, messages: [] }];
  const patches: string[] = [];
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (path, init) => {
    if (path === "/api/bots/bot" && init?.method === "PATCH") patches.push(String(init.body));
    return new Response(JSON.stringify(path === "/api/bots/bot" ? { bot } : {}));
  }));
  let dispatch!: Dispatch<Action>;
  function Capture() { dispatch = useStore().dispatch; return null; }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(StoreProvider, null, createElement(Capture))));
  act(() => dispatch({ type: "updateBot", botId: "bot", patch: { soul: "chaos instructions v3." } }));
  window.dispatchEvent(new Event("pagehide"));
  await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });
  expect(patches.map((body) => JSON.parse(body).soul)).toEqual(["chaos instructions v3."]);
  act(() => root.unmount());
});

it("sends only the leaving page's save as keepalive, so ordinary saves never use up the browser's keepalive budget", async () => {
  vi.useFakeTimers();
  initialState.bots = [{ ...bot, messages: [] }];
  const keepalive: Array<boolean | undefined> = [];
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (path, init) => {
    if (path === "/api/bots/bot" && init?.method === "PATCH") keepalive.push(init.keepalive);
    return new Response(JSON.stringify(path === "/api/bots/bot" ? { bot } : {}));
  }));
  let dispatch!: Dispatch<Action>;
  function Capture() { dispatch = useStore().dispatch; return null; }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(StoreProvider, null, createElement(Capture))));
  act(() => dispatch({ type: "updateBot", botId: "bot", patch: { soul: "v1" } }));
  await act(async () => { await vi.advanceTimersByTimeAsync(450); });
  act(() => dispatch({ type: "updateBot", botId: "bot", patch: { soul: "v2" } }));
  window.dispatchEvent(new Event("pagehide"));
  await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });
  expect(keepalive.map(Boolean)).toEqual([false, true]);
  act(() => root.unmount());
});
