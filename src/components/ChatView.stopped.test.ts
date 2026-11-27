// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppState, Bot, InstanceInfo, Message } from "@/state/store";

vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/cloud-guest", () => ({ useCanWriteIn: () => true, useReactor: () => "user" }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));

const { ChatView } = await import("./ChatView");
const { BotEditorStore, initialState } = await import("@/state/store");
const { forgetStops, sendStop } = await import("@/lib/stop-turn");
const { t } = await import("@/lib/i18n");

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  forgetStops();
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
const scout = (messages: Message[], busy: boolean): Bot => ({
  id: "scout", threadId: "t", name: "Scout", title: "", description: "", color: "green", notifications: true, unread: false,
  busy, messages, modelSelection: { instanceId: "test", model: "m" },
  tasks: [{ threadId: "t", title: "Poem", createdAt: 1, busy, activity: busy ? "working" : "idle", modelSelection: { instanceId: "test", model: "m" }, approvalMode: "ask" }],
});
const draw = (bot: Bot) => {
  const state: AppState = { ...initialState, connected: true, selectedId: bot.id, bots: [bot], instances };
  const value = { state, dispatch: () => {}, flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  flushSync(() => root.render(createElement(BotEditorStore, { value, children: createElement(ChatView, { bot }) })));
};
const ask: Message = { id: "u1", role: "user", kind: "text", text: "Write a 250 word poem about cheese", at: Date.now() - 2_000 };

it("says the turn stopped after the person's Stop ended it before any answer", async () => {
  sendStop(async () => ({ ok: true }), { type: "interrupt", botId: "scout", threadId: "t" }, () => {});
  await Promise.resolve(); await Promise.resolve();
  draw(scout([ask], true));
  expect(container.textContent).not.toContain(t("chat.turnStoppedByYou"));
  draw(scout([ask], false));
  expect(container.textContent).toContain(t("chat.turnStoppedByYou"));
});

it("says nothing more once the server's own stopped row or an answer is there", async () => {
  sendStop(async () => ({ ok: true }), { type: "interrupt", botId: "scout", threadId: "t" }, () => {});
  await Promise.resolve(); await Promise.resolve();
  draw(scout([ask, { id: "b1", role: "bot", kind: "text", text: "Cheese, oh cheese", at: Date.now() }], false));
  expect(container.textContent).not.toContain(t("chat.turnStoppedByYou"));
});

it("says nothing for a turn nobody stopped here", () => {
  draw(scout([ask], false));
  expect(container.textContent).not.toContain(t("chat.turnStoppedByYou"));
});
