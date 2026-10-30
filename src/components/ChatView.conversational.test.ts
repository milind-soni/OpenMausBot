// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, InstanceInfo, Message } from "@/state/store";

vi.mock("./ChatMarkdown", async (importOriginal) => ({
  ...await importOriginal<typeof import("./ChatMarkdown")>(),
  ChatMarkdown: ({ text }: { text: string }) => createElement("p", { "data-md": "" }, text),
}));
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/cloud-guest", () => ({ useCanWriteIn: () => true, useReactor: () => "user" }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));

const { ChatView } = await import("./ChatView");
const { setAdvancedMode } = await import("@/lib/interface-mode");
const { BotEditorStore, initialState } = await import("@/state/store");

const reply = "Found it.\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nWant me to run it?";
const messages: Message[] = [
  { id: "m1", role: "user", kind: "text", text: "where is it", at: 1, quickModel: "Claude Haiku 4.5" },
  { id: "m2", parentId: "m1", role: "bot", kind: "text", text: reply, at: 2 },
];
const profile = (extra: Partial<Bot>): Bot => ({
  id: "pepper", threadId: "pepper-thread", name: "pepper", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages, activeLeafId: "m2", modelSelection: { instanceId: "test", model: "m" },
  tasks: [{ threadId: "pepper-thread", title: "Thread", createdAt: 1, busy: false, activity: "idle", modelSelection: { instanceId: "test", model: "m" }, approvalMode: "ask" }],
  ...extra,
});

let root: Root;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
async function draw(bot: Bot) {
  const state: AppState = {
    ...initialState, connected: true, selectedId: "pepper", bots: [bot],
    instances: [{ instanceId: "test", driverKind: "codex", displayName: "Test", snapshot: { state: "available" } } as InstanceInfo],
    config: { features: {} } as AppState["config"],
  };
  const value = { state, dispatch: vi.fn(), flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  flushSync(() => root.render(createElement(BotEditorStore, { value, children: createElement(ChatView, { bot }) })));
  await settle();
}
const segments = () => [...document.querySelectorAll("[data-reply-segment]")].map((el) => el.textContent);

beforeAll(() => {
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterAll(() => {
  root.unmount();
  vi.unstubAllGlobals();
});

describe("conversational replies", () => {
  it("draws one bubble per message break and keeps the code block whole", async () => {
    await draw(profile({ replyStyle: "conversational" }));
    expect(segments()).toEqual(["Found it.", "```ts\nconst a = 1;\n\nconst b = 2;\n```", "Want me to run it?"]);
    expect(document.querySelectorAll("[data-conversational-reply]")).toHaveLength(1);
  });

  it("names the quick model quietly under the message it answered", async () => {
    await draw(profile({ replyStyle: "conversational" }));
    expect(document.querySelector("[data-quick-model]")?.textContent).toBe("Quick reply with Claude Haiku 4.5");
  });

  it("shows history bubbles at once, each part its own Simple bubble stacked close under the last", async () => {
    await draw(profile({ replyStyle: "conversational" }));
    const bubbles = [...document.querySelectorAll<HTMLElement>("[data-reply-segment]")];
    expect(bubbles).toHaveLength(3);
    expect(bubbles.every((el) => !el.classList.contains("reply-bubble-in"))).toBe(true);
    for (const el of bubbles) expect([...el.classList]).toEqual(expect.arrayContaining(["bg-card", "rounded-[18px]", "px-3", "text-[15px]", "leading-[22px]", "min-w-9"]));
    expect([...bubbles[0]!.classList]).toContain("rounded-es-[6px]");
    expect([...bubbles[1]!.classList]).toEqual(expect.arrayContaining(["rounded-ss-[6px]", "rounded-es-[6px]"]));
    expect([...bubbles[2]!.classList]).toContain("rounded-ss-[6px]");
    expect([...bubbles[2]!.classList]).not.toContain("rounded-es-[6px]");
    expect(document.querySelector("[data-conversational-reply]")!.classList).toContain("gap-1");
  });

  it("plays a reply that arrives while the chat is open in, one bubble after another", async () => {
    root.unmount();
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const later = Date.now() + 60_000;
    const fresh: Message[] = [messages[0]!, { ...messages[1]!, id: "m3", at: later }];
    await draw(profile({ replyStyle: "conversational", messages: fresh, activeLeafId: "m3" }));
    const bubbles = [...document.querySelectorAll<HTMLElement>("[data-reply-segment]")];
    expect(bubbles.map((el) => el.classList.contains("reply-bubble-in"))).toEqual([true, true, true]);
    expect(bubbles.map((el) => el.style.animationDelay)).toEqual(["0ms", "120ms", "240ms"]);
  });

  it("keeps a single bubble for a default bot", async () => {
    await draw(profile({}));
    expect(segments()).toEqual([]);
    expect([...document.querySelectorAll("[data-md]")].map((el) => el.textContent)).toContain(reply);
  });

  it("keeps a reply's Reply and Copy in its … menu in Simple mode, beside the reaction button", async () => {
    await draw(profile({}));
    const row = document.querySelector("[data-mid='m2']")!;
    expect(row.querySelector('[aria-label="Reply to message"]')).toBeNull();
    expect(row.querySelector('[aria-label="Copy message"]')).toBeNull();
    const more = row.querySelector<HTMLButtonElement>('button[aria-label="Message actions"]')!;
    flushSync(() => more.click());
    const items = [...document.querySelectorAll('[role="menu"][aria-label="Message actions"] [role="menuitem"]')].map((item) => item.textContent);
    expect(items.slice(0, 2)).toEqual(["Reply", "Copy message"]);
  });

  it("puts a formatted reply in the bot's bubble in Simple mode, and on the open page in Advanced", async () => {
    const bubbleOf = () => document.querySelector("[data-mid='m2'] [data-chat-bubble]")!;
    await draw(profile({}));
    expect(bubbleOf().getAttribute("data-chat-bubble")).toBe("simple");
    expect([...bubbleOf().classList]).toEqual(expect.arrayContaining(["bg-card", "rounded-[18px]"]));
    setAdvancedMode(true);
    try {
      await draw(profile({}));
      expect(bubbleOf().getAttribute("data-chat-bubble")).toBe("");
      expect(bubbleOf().classList).not.toContain("bg-card");
      expect(bubbleOf().className).toContain("max-w-[min(var(--chat-prose-max),var(--chat-card-pct))]");
    } finally {
      setAdvancedMode(false);
    }
  });
});
