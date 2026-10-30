// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
const { t } = await import("@/lib/i18n");

const line = (id: string, parentId: string | undefined, fields: Partial<Message>): Message =>
  ({ id, parentId, role: "bot", kind: "text", at: Date.UTC(2026, 9, 21, 9, Number(id.slice(1))), ...fields });
const messages: Message[] = [
  line("m1", undefined, { role: "user", text: "Draft an email to Sam." }),
  line("m2", "m1", { text: "Shall I send it?", reactions: [{ emoji: "👍", by: "user", at: 1 }] }),
  line("m3", "m2", { role: "user", text: "👍", reaction: "👍", replyToId: "m2" }),
  line("m4", "m3", { text: "Sent it to Sam." }),
];
const pepper: Bot = {
  id: "pepper", threadId: "pepper-thread", name: "Pepper", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages, activeLeafId: "m4", modelSelection: { instanceId: "test", model: "m" },
  tasks: [{ threadId: "pepper-thread", title: "Thread", createdAt: 1, busy: false, activity: "idle", modelSelection: { instanceId: "test", model: "m" }, approvalMode: "ask" }],
};
const state: AppState = {
  ...initialState,
  connected: true,
  selectedId: "pepper",
  bots: [pepper],
  instances: [{ instanceId: "test", driverKind: "codex", displayName: "Test", snapshot: { state: "available" } } as InstanceInfo],
};

let root: Root;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeAll(async () => {
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const value = { state, dispatch: vi.fn(), flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  flushSync(() => root.render(createElement(BotEditorStore, { value, children: createElement(ChatView, { bot: pepper }) })));
  await settle();
});
afterAll(() => {
  root.unmount();
  vi.unstubAllGlobals();
});

describe("a 👍 that answered a bot's question, in the chat", () => {
  it("shows on the question as the person's reaction, and its own line draws no bubble", () => {
    expect(document.querySelector('[data-mid="m3"]')).toBeNull();
    const chips = document.querySelector('[data-mid="m2"] [role="group"]');
    expect(chips?.getAttribute("aria-label")).toBe(t("chat.reactions"));
    expect(chips?.querySelector("button")?.getAttribute("aria-label")).toBe("Thumbs up: yes, go ahead: You");
  });

  it("leaves the person's last typed message as the one ArrowUp edits", async () => {
    const composer = document.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${t("composer.placeholder.bot", { name: "Pepper" })}"]`)!;
    expect(composer.value).toBe("");
    flushSync(() => composer.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })));
    await settle();
    const editors = [...document.querySelectorAll<HTMLTextAreaElement>("textarea")].filter((area) => area !== composer);
    expect(editors.map((area) => area.value)).toEqual(["Draft an email to Sam."]);
  });
});
