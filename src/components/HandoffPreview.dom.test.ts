// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const streams = vi.hoisted(() => ({ started: 0, stopped: 0 }));
vi.mock("@/lib/browser-stream-client", async (original) => ({
  ...await original<typeof import("@/lib/browser-stream-client")>(),
  createPreviewStreamClient: () => { streams.started += 1; return { send: () => true, stop: () => { streams.stopped += 1; } }; },
  createPreviewFramePainter: () => ({ paint: () => undefined, stop: () => undefined }),
}));

import { initialState, StoreContext, type AppState, type Bot } from "@/state/store";
import { HandoffPreview } from "./HandoffPreview";

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  streams.started = 0; streams.stopped = 0;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

const bot = { id: "scout", name: "Scout", threadId: "t1", messages: [], tasks: [] } as unknown as Bot;
async function show(state: Partial<AppState>) {
  const value = { state: { ...initialState, bots: [bot], config: { browserEngine: { engine: "chrome" } }, ...state } as AppState, dispatch: vi.fn(), flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  await act(async () => root.render(createElement(StoreContext.Provider, { value },
    createElement(HandoffPreview, { botId: "scout", threadId: "t1", place: "browser", label: "Take over", onOpen: () => undefined }))));
}

it("watches the bot's browser at card width, with one stream of its own", async () => {
  await show({});
  expect(streams.started).toBe(1);
  expect(container.querySelector("canvas")).not.toBeNull();
});

it("opens no second stream while the Browser panel shows this bot, and stops its own when the panel opens", async () => {
  await show({ computerOpen: true, selectedId: "scout" });
  expect(streams.started).toBe(0);
  expect(container.textContent).toContain("Showing in the Browser panel");
  await show({});
  expect(streams.started).toBe(1);
  await show({ computerOpen: true, selectedId: "scout" });
  expect(streams.stopped).toBe(1);
  expect(container.querySelector("canvas")).not.toBeNull();
});
