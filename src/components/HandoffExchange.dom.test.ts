// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerFrame } from "../../shared/wire";
import { setLocale } from "@/lib/i18n";
import type { LiveFrameListener } from "@/lib/live-events";
import type { Bot, Message } from "@/state/store";

const fixture = vi.hoisted(() => ({
  dispatch: vi.fn(),
  listeners: new Set<LiveFrameListener>(),
  load: vi.fn(),
}));
const bot = (id: string, name: string, color: string, threadId: string, tasks: Bot["tasks"] = []): Bot => ({
  id, threadId, name, title: "", description: "", notifications: true, color, unread: false, messages: [],
  modelSelection: { instanceId: "fake", model: "test" }, tasks,
} as Bot);
const maestro = bot("maestro", "Maestro", "blue", "maestro-main");
const helper = bot("tool", "Ferramenteiro", "green", "tool-main", [
  { threadId: "tool-main", title: "Main", createdAt: 1 },
  { threadId: "help-1", title: "Check the build", createdAt: 2 },
]);
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, bots: [maestro, helper] }, dispatch: fixture.dispatch }) };
});
vi.mock("@/state/store-select", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store-select")>(),
  useStoreSelector: (select: (state: unknown) => unknown) => select({ bots: [maestro, helper] }),
}));
vi.mock("@/state/message-history", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/message-history")>(), loadFullThread: fixture.load,
}));
vi.mock("@/lib/live-events", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/live-events")>(),
  listenLiveFrames: (listener: LiveFrameListener) => { fixture.listeners.add(listener); return () => fixture.listeners.delete(listener); },
}));
vi.mock("@/lib/thread-preferences", () => ({ useShowThreads: () => true }));
vi.mock("./Avatar", () => ({
  BotAvatar: ({ bot: shown }: { bot: Bot }) => createElement("span", { "data-avatar": shown.id }),
  InitialsAvatar: ({ initials }: { initials: string }) => createElement("span", { "data-avatar": initials }),
}));
import { HandoffExchangeHost } from "./HandoffExchange";
import { ThreadChip } from "./ThreadChip";

const sent = (extra: Partial<Message> = {}): Message => ({
  id: "sent", role: "bot", kind: "activity", at: 1_000,
  tool: { name: "Sent to Ferramenteiro", ok: true },
  from: { botId: "maestro", name: "Maestro", color: "blue" },
  threadRef: { botId: "tool", threadId: "help-1", title: "Check the build" },
  ...extra,
});
const ask: Message = { id: "m1", role: "user", kind: "text", text: "Please check the build", at: 1_000, parentId: null, peerAsk: { botId: "maestro", name: "Maestro" } };
const answer: Message = { id: "m2", role: "bot", kind: "text", text: "Build is green", at: 2_000, parentId: "m1" };

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  setLocale("en");
  fixture.dispatch.mockClear();
  fixture.listeners.clear();
  fixture.load.mockReset();
  if (typeof globalThis.ResizeObserver === "undefined") {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  }
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  flushSync(() => root.unmount());
  document.body.replaceChildren();
});

/** The asker's chat in the main column: a stand-in chat with the hand-off line and a message box. */
const render = (message: Message, shown: Bot = maestro) => flushSync(() => root.render(createElement(HandoffExchangeHost, {
  bot: shown, children: createElement("main", { "data-chat": "" }, createElement(ThreadChip, { message, threadId: shown.threadId }), createElement("textarea")),
})));
const chip = () => host.querySelector<HTMLButtonElement>("[data-thread-chip]")!;
const exchange = () => host.querySelector<HTMLElement>("[data-handoff-exchange]");
const chatShown = () => host.querySelector("[data-chat]") !== null;
const named = (name: string) => exchange()!.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;
const rows = () => Array.from(exchange()!.querySelectorAll("[data-side]")).map((row) => `${row.getAttribute("data-side")}: ${row.textContent}`);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const send = (frame: ServerFrame) => flushSync(() => { for (const listener of fixture.listeners) listener.onFrame(frame); });

async function openLoaded(messages: Message[] = [ask, answer]) {
  fixture.load.mockResolvedValue({ messages, activeLeafId: messages.at(-1)?.id ?? null });
  render(sent());
  flushSync(() => chip().click());
  await settle();
  flushSync(() => {});
}

describe("a teammate's hand-off line", () => {
  it("is a chip with the helper's face and name that opens the exchange in place of the chat, with no pop-up", () => {
    fixture.load.mockReturnValue(new Promise(() => {}));
    render(sent());
    expect(chip().textContent).toBe("Ferramenteiro");
    expect(chip().getAttribute("aria-label")).toBe("Open exchange with Ferramenteiro");
    expect(chip().querySelector("[data-avatar=tool]")).not.toBeNull();
    flushSync(() => chip().click());
    expect(fixture.dispatch).not.toHaveBeenCalled();
    expect(fixture.load).toHaveBeenCalledWith("help-1");
    expect(chatShown()).toBe(false);
    expect(exchange()!.parentElement).toBe(host);
    expect(document.querySelector("[role=dialog]")).toBeNull();
    const pill = exchange()!.querySelector("[role=group]")!;
    expect(pill.getAttribute("aria-label")).toBe("Bot exchange between Maestro and Ferramenteiro");
    expect(pill.textContent).toBe("MaestroFerramenteiro");
    expect(exchange()!.textContent).toContain("Loading the conversation…");
  });

  it("shows the two bots' lines as plain bubbles, adds lines as they come in, and has no message box", async () => {
    await openLoaded();
    expect(rows()).toEqual(["asker: MaestroPlease check the build", "helper: FerramenteiroBuild is green"]);
    expect(exchange()!.querySelector("textarea")).toBeNull();
    expect(exchange()!.textContent).not.toMatch(/Read-only|Talk to|Open full thread|messages/);

    send({ kind: "message", threadId: "other", message: { id: "x", role: "bot", kind: "text", text: "Elsewhere", at: 3_000 } } as ServerFrame);
    send({ kind: "message", threadId: "help-1", message: { id: "m3", role: "bot", kind: "text", text: "Lint passes too", at: 3_000, parentId: "m2" } } as ServerFrame);
    expect(rows()).toEqual(["asker: MaestroPlease check the build", "helper: FerramenteiroBuild is green", "helper: Lint passes too"]);
    expect(exchange()!.textContent).not.toContain("Elsewhere");
  });

  it("keeps the newest line in sight as lines come in, unless the person scrolled up", async () => {
    await openLoaded();
    const list = exchange()!.querySelector<HTMLElement>(".glass-scroller")!;
    Object.defineProperty(list, "scrollHeight", { configurable: true, value: 900 });
    Object.defineProperty(list, "clientHeight", { configurable: true, value: 300 });
    send({ kind: "message", threadId: "help-1", message: { id: "m3", role: "bot", kind: "text", text: "More", at: 3_000, parentId: "m2" } } as ServerFrame);
    expect(list.scrollTop).toBe(900);
    list.scrollTop = 100;
    list.dispatchEvent(new Event("scroll"));
    Object.defineProperty(list, "scrollHeight", { configurable: true, value: 1_200 });
    send({ kind: "message", threadId: "help-1", message: { id: "m4", role: "bot", kind: "text", text: "Even more", at: 4_000, parentId: "m3" } } as ServerFrame);
    expect(list.scrollTop).toBe(100);
  });

  it("Back to the asker and the Back chevron both return to the chat", async () => {
    await openLoaded();
    flushSync(() => named("Back to Maestro").click());
    expect(exchange()).toBeNull();
    expect(chatShown()).toBe(true);
    flushSync(() => chip().click());
    flushSync(() => named("Back").click());
    expect(exchange()).toBeNull();
    expect(chatShown()).toBe(true);
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("closes when the column moves to another chat, and stays closed on coming back", async () => {
    await openLoaded();
    render(sent(), { ...maestro, threadId: "maestro-other" });
    expect(exchange()).toBeNull();
    render(sent());
    expect(exchange()).toBeNull();
    expect(chatShown()).toBe(true);
  });

  it("says so when the conversation can't load, and can try again", async () => {
    fixture.load.mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ messages: [ask], activeLeafId: "m1" });
    render(sent());
    flushSync(() => chip().click());
    await settle();
    flushSync(() => {});
    expect(exchange()!.textContent).toContain("Couldn't load the conversation.");
    flushSync(() => Array.from(exchange()!.querySelectorAll("button")).find((item) => item.textContent === "Try again")!.click());
    await settle();
    flushSync(() => {});
    expect(rows()).toEqual(["asker: MaestroPlease check the build"]);
  });

  it("keeps opening the thread for a line the person sent directly, the helper's main chat, or a thread it no longer has", () => {
    for (const message of [sent({ sentDirectly: { name: "Ferramenteiro" } }), sent({ threadRef: { botId: "tool", threadId: "tool-main", title: "Main" } }),
      sent({ threadRef: { botId: "tool", threadId: "gone", title: "Old" } })]) {
      fixture.dispatch.mockClear();
      render(message);
      expect(chip().hasAttribute("data-exchange-chip")).toBe(false);
      flushSync(() => chip().click());
      expect(exchange()).toBeNull();
      expect(fixture.dispatch).toHaveBeenCalled();
    }
  });

  it("opens the thread as before where no chat column hosts the exchange", () => {
    flushSync(() => root.render(createElement(ThreadChip, { message: sent(), threadId: "maestro-main" })));
    expect(chip().hasAttribute("data-exchange-chip")).toBe(false);
    flushSync(() => chip().click());
    expect(fixture.dispatch).toHaveBeenCalled();
  });
});
