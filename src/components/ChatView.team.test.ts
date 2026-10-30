// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppState, Bot, InstanceInfo, Message } from "@/state/store";

const viewer = vi.hoisted(() => ({ reactor: "p_ada" }));
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/cloud-guest", () => ({ useCanWriteIn: () => true, useReactor: () => viewer.reactor }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));

const { ChatView } = await import("./ChatView");
const { setColorUserBubbles } = await import("@/lib/user-bubble-preference");
const { BotEditorStore, initialState } = await import("@/state/store");
const { t } = await import("@/lib/i18n");

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
const team = { id: "team-acme", name: "Acme" };
const line = (id: string, sender: { name: string; id: string }, text: string): Message => ({ id, role: "user", kind: "text", at: 1, text, sender });
const luna = (messages: Message[], extra: Partial<Bot> = {}): Bot => ({
  id: "luna", threadId: "main", name: "Luna", title: "", description: "", color: "green", notifications: true, unread: false,
  busy: false, messages, modelSelection: { instanceId: "test", model: "m" },
  tasks: [{ threadId: "main", title: "Main", createdAt: 1, busy: false, activity: "idle", modelSelection: { instanceId: "test", model: "m" }, approvalMode: "ask" }],
  ...extra,
});
const draw = (bot: Bot) => {
  const state: AppState = { ...initialState, connected: true, selectedId: bot.id, bots: [bot], instances, config: { team } as AppState["config"] };
  const value = { state, dispatch: () => {}, flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  flushSync(() => root.render(createElement(BotEditorStore, { value, children: createElement(ChatView, { bot }) })));
};
const row = (text: string) => [...container.querySelectorAll<HTMLElement>("[data-message-row]")].find((element) => element.textContent?.includes(text))!;

it("shows a teammate's line in a shared chat as theirs, with their name, and only the viewer's own in their bubble", () => {
  setColorUserBubbles(true);
  draw(luna([line("o1", { name: "Olive", id: "p_olive" }, "plant is memory-Fernando"), line("a1", { name: "Ada", id: "p_ada" }, "noted")]));
  const olive = row("plant is memory-Fernando");
  expect(olive.textContent).toContain("Olive");
  expect(olive.querySelector("[data-chat-bubble]")!.className).not.toContain("user-bubble-colored");
  const own = row("noted");
  expect(own.textContent).not.toContain("Ada");
  expect(own.querySelector("[data-chat-bubble]")!.className).toContain("user-bubble-colored");
});

it("says a member's own MausBot is theirs, not everyone's", () => {
  draw(luna([], { defaultBot: { person: "ada@acme.test" } } as Partial<Bot>));
  expect(container.textContent).not.toContain(t("team.sharedHeader", { team: "Acme" }));
  expect(container.textContent).toContain(t("team.ownHelperHeader"));
});
