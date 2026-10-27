// @vitest-environment happy-dom
// Set me up is drawn under a new bot's greeting in the chat itself, and goes once the person has written.
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

const greeting: Message = { id: "g1", role: "bot", kind: "text", at: new Date(2026, 9, 3, 9, 0).getTime(), text: "Hi, I'm Pepper. What would you like me to do?", setupOffer: true };
const profile = (extra: Partial<Bot> = {}): Bot => ({
  id: "pepper", threadId: "pepper-thread", name: "Pepper", title: "", description: "", soul: "", color: "green",
  notifications: true, unread: false, busy: false, messages: [greeting], activeLeafId: "g1", modelSelection: { instanceId: "test", model: "m" },
  tasks: [{ threadId: "pepper-thread", title: "Thread", createdAt: 1, busy: false, activity: "idle", modelSelection: { instanceId: "test", model: "m" }, approvalMode: "ask" }],
  ...extra,
});

const sent: Array<{ url: string; init?: RequestInit }> = [];
let root: Root;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
async function draw(bot: Bot) {
  const state: AppState = {
    ...initialState, connected: true, selectedId: bot.id, bots: [bot],
    instances: [{ instanceId: "test", driverKind: "codex", displayName: "Test", snapshot: { state: "available" }, capabilities: { agentsMcp: true } } as InstanceInfo],
  };
  const value = { state, dispatch: vi.fn(), flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  flushSync(() => root.render(createElement(BotEditorStore, { value, children: createElement(ChatView, { bot }) })));
  await settle();
}
const button = () => document.querySelector<HTMLButtonElement>('[data-mid="g1"] [data-setup-offer]');

beforeAll(() => {
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    sent.push({ url: String(url), init });
    return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }));
  });
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterAll(() => {
  root.unmount();
  vi.unstubAllGlobals();
});

describe("Set me up in the chat", () => {
  it("is drawn under a blank bot's greeting and sends the press for this conversation", async () => {
    await draw(profile());
    expect(button()?.textContent).toBe("Set me up");
    sent.length = 0;
    flushSync(() => button()!.click());
    await settle();
    const press = sent.find((call) => call.url.endsWith("/api/bots/pepper/setup-request"));
    expect(press?.init).toMatchObject({ method: "POST", body: JSON.stringify({ threadId: "pepper-thread" }) });
  });

  it("is gone once the person has written, and never shown for a bot with instructions", async () => {
    const said: Message = { id: "u1", parentId: "g1", role: "user", kind: "text", at: greeting.at + 1, text: "hello" };
    await draw(profile({ messages: [greeting, said], activeLeafId: "u1" }));
    expect(document.querySelector("[data-setup-offer]")).toBeNull();
    await draw(profile({ soul: "Only water the garden." }));
    expect(document.querySelector("[data-setup-offer]")).toBeNull();
  });
});
