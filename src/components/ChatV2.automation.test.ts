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
vi.mock("@/lib/cloud-guest", () => ({ useCanWriteIn: () => true, useCloudGuest: () => false, useReactor: () => "user" }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));

const { ChatV2 } = await import("./chat-v2/ChatV2");
const { BotEditorStore, initialState } = await import("@/state/store");

const at = (minute: number) => new Date(2026, 9, 21, 9, minute).getTime();
const line = (runId: string, extra: Partial<NonNullable<Message["automation"]>> = {}): NonNullable<Message["automation"]> => ({
  routineId: "inbox", runId, name: "Inbox brief", trigger: "schedule", executionThreadId: `${runId}-thread`, scheduledFor: at(0), ...extra,
});
const transcript = (tail: Message[]): Message[] => [
  { id: "m1", parentId: null, role: "user", kind: "text", text: "Draft the weekly update.", at: at(1) },
  { id: "m2", parentId: "m1", role: "bot", kind: "text", text: "Here is the draft.", at: at(2), turnId: "t1", turnTerminal: true },
  ...tail,
];
const pepper = (messages: Message[]): Bot => ({
  id: "pepper", threadId: "main", name: "Pepper", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages, activeLeafId: messages.at(-1)!.id, modelSelection: { instanceId: "test", model: "m" },
  tasks: [
    { threadId: "main", title: "Chat", createdAt: 1, busy: false, activity: "idle", modelSelection: { instanceId: "test", model: "m" }, approvalMode: "ask" },
    { threadId: "run-1-thread", title: "Inbox brief · Oct 21", createdAt: 2, busy: false, activity: "idle", routineRunId: "run-1", modelSelection: { instanceId: "test", model: "m" }, approvalMode: "ask" },
  ],
});

const dispatch = vi.fn();
let root: Root;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
async function draw(messages: Message[]) {
  const bot = pepper(messages);
  const state: AppState = {
    ...initialState, connected: true, selectedId: "pepper", bots: [bot],
    instances: [{ instanceId: "test", driverKind: "codex", displayName: "Test", snapshot: { state: "available" } } as InstanceInfo],
  };
  const value = { state, dispatch, flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  const chat = createElement(ChatV2, { profile: bot });
  flushSync(() => root.render(createElement(BotEditorStore, { value, children: chat })));
  await settle();
}
const caption = (runId: string) => document.querySelector<HTMLElement>(`[data-automation-caption="${runId}"]`);
beforeAll(() => {
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  const saved = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
    removeItem: (key: string) => saved.delete(key),
  });
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterAll(() => {
  root.unmount();
  vi.unstubAllGlobals();
});

describe("an automation's line in the chat", () => {
  it("labels an automation report in Chat V2 without linking to a hidden execution", async () => {
    await draw(transcript([{ id: "r1", parentId: "m2", role: "bot", kind: "text", text: "Inbox checked.", at: at(3), automation: line("hidden") }]));
    const label = caption("hidden");
    expect(label?.textContent).toContain("Inbox brief");
    expect(label?.querySelector("button")).toBeNull();
    expect(document.querySelector('[data-mid="r1"]')?.textContent).toContain("Inbox checked.");
  });

});
