// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppState, Bot, InstanceInfo } from "@/state/store";

vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/cloud-guest", () => ({ useCanWriteIn: () => true, useReactor: () => "user" }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));

const { ChatView } = await import("./ChatView");
const { BotEditorStore, initialState, reducer } = await import("@/state/store");

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  root.unmount();
  container.remove();
  vi.unstubAllGlobals();
});

const instances = [{ instanceId: "test", driverKind: "codex", displayName: "Test", snapshot: { state: "available" } } as InstanceInfo];
const draw = (state: AppState) => {
  const value = { state, dispatch: () => {}, flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  flushSync(() => root.render(createElement(BotEditorStore, { value, children: createElement(ChatView, { bot: state.bots.find((bot) => bot.id === state.selectedId)! }) })));
};

it("opens a bot whose conversation the server did not name instead of going blank", () => {
  const scout = {
    id: "scout", name: "Scout", title: "", description: "", color: "green", notifications: true, unread: false,
    modelSelection: { instanceId: "test", model: "m" }, messages: [], tasks: [],
  } as unknown as Bot;
  expect(() => draw({ ...initialState, connected: true, selectedId: "scout", bots: [scout], instances, unreadDivider: null })).not.toThrow();
  expect(container.querySelector("[data-chathead-identity]")).not.toBeNull();
});

it("opens a bot that joined without a transcript", () => {
  const added = reducer({ ...initialState, instances }, {
    type: "botAdded",
    bot: { id: "mausbot", threadId: "own", name: "MausBot", title: "", description: "", color: "green", notifications: true, unread: false, modelSelection: { instanceId: "test", model: "m" } } as Bot,
  });
  expect(added.bots[0]!.messages).toEqual([]);
  expect(() => draw({ ...added, connected: true })).not.toThrow();
});

it("opens a member's first load when the server sent a bot without its transcript", () => {
  const hydrated = reducer({ ...initialState, instances }, {
    type: "hydrate",
    bots: [{ id: "pickle", name: "Pickle", title: "", description: "", color: "green", notifications: true, unread: false, modelSelection: { instanceId: "test", model: "m" }, tasks: [] } as unknown as Bot],
    groups: [], computerControl: {},
  } as Parameters<typeof reducer>[1]);
  expect(hydrated.bots[0]!.messages).toEqual([]);
  expect(() => draw({ ...hydrated, connected: true })).not.toThrow();
});
