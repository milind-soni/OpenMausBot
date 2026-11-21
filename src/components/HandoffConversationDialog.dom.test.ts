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
let composer: HTMLTextAreaElement;

beforeEach(() => {
  setLocale("en");
  fixture.dispatch.mockClear();
  fixture.listeners.clear();
  fixture.load.mockReset();
  composer = document.createElement("textarea");
  const shell = document.createElement("div");
  shell.dataset.tour = "composer";
  shell.append(composer);
  host = document.createElement("div");
  document.body.append(shell, host);
  root = createRoot(host);
});

afterEach(() => {
  flushSync(() => root.unmount());
  document.body.replaceChildren();
});

const render = (message: Message) => flushSync(() => root.render(createElement(ThreadChip, { message, threadId: "maestro-main" })));
const chip = () => host.querySelector<HTMLButtonElement>("[data-thread-chip]")!;
const dialog = () => document.querySelector<HTMLElement>("[role=dialog]");
const button = (text: string) => Array.from(dialog()!.querySelectorAll("button")).find((item) => item.textContent === text)!;
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
  it("opens the two bots' conversation over this chat instead of leaving it", async () => {
    fixture.load.mockReturnValue(new Promise(() => {}));
    render(sent());
    expect(chip().textContent).toContain("View conversation");
    flushSync(() => chip().click());
    expect(fixture.dispatch).not.toHaveBeenCalled();
    expect(fixture.load).toHaveBeenCalledWith("help-1");
    expect(dialog()!.parentElement!.parentElement).toBe(document.body);
    expect(dialog()!.textContent).toContain("Maestro⇄Ferramenteiro");
    expect(dialog()!.textContent).toContain("Check the build");
    expect(dialog()!.textContent).toContain("Loading the conversation…");
    expect(dialog()!.textContent).not.toContain("No messages yet.");
  });

  it("shows who said what, read-only, and adds lines as they come in", async () => {
    await openLoaded();
    const lines = () => Array.from(dialog()!.querySelectorAll("[data-side]")).map((row) => `${row.getAttribute("data-side")}: ${row.textContent}`);
    expect(lines()).toEqual([expect.stringMatching(/^asker: Maestro.*Please check the build/), expect.stringMatching(/^helper: Ferramenteiro.*Build is green/)]);
    expect(dialog()!.textContent).toContain("Conversation between bots · 2 messages");
    expect(dialog()!.textContent).toContain("Maestro asked Ferramenteiro for help");
    expect(dialog()!.textContent).toContain("Read-only. To change course, talk to Maestro.");
    expect(dialog()!.querySelector("textarea")).toBeNull();

    send({ kind: "message", threadId: "other", message: { id: "x", role: "bot", kind: "text", text: "Elsewhere", at: 3_000 } } as ServerFrame);
    send({ kind: "message", threadId: "help-1", message: { id: "m3", role: "bot", kind: "text", text: "Lint passes too", at: 3_000, parentId: "m2" } } as ServerFrame);
    expect(lines()).toHaveLength(3);
    expect(dialog()!.textContent).toContain("Lint passes too");
    expect(dialog()!.textContent).not.toContain("Elsewhere");
    expect(dialog()!.textContent).toContain("Conversation between bots · 3 messages");
  });

  it("keeps the newest line in sight as lines come in, unless the person scrolled up", async () => {
    await openLoaded();
    const list = dialog()!.querySelector<HTMLElement>("[aria-live]")!;
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

  it("in a standing work thread, starts this hand-off at the asker's line nearest it", async () => {
    const older: Message = { ...ask, id: "m0", text: "Old request", at: 100, peerAsk: { botId: "maestro", name: "Maestro" } };
    const reply: Message = { ...answer, id: "m01", text: "Old answer", at: 200, parentId: "m0" };
    const now: Message = { ...ask, text: "@Ferramenteiro\nPlease check the build", at: 990, parentId: "m01" };
    await openLoaded([older, reply, now, answer]);
    expect(dialog()!.querySelector("header")!.textContent).toContain("Please check the build");
    const list = dialog()!.querySelector("[aria-live]")!.textContent!;
    expect(list.indexOf("Old answer")).toBeLessThan(list.indexOf("Maestro asked Ferramenteiro for help"));
    expect(list.indexOf("Maestro asked Ferramenteiro for help")).toBeLessThan(list.indexOf("Please check the build"));
  });

  it("Talk to the asker closes the pop-up and puts the cursor in this chat's message box", async () => {
    await openLoaded();
    flushSync(() => button("Talk to Maestro").click());
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(composer);
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("Escape closes it; Open full thread still goes to the thread", async () => {
    await openLoaded();
    flushSync(() => dialog()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(dialog()).toBeNull();
    flushSync(() => chip().click());
    flushSync(() => button("Open full thread").click());
    expect(dialog()).toBeNull();
    expect(fixture.dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: "select", id: "tool" },
      { type: "switchTask", botId: "tool", threadId: "help-1" },
      { type: "revealThread", threadId: "help-1" },
    ]);
  });

  it("says so when the conversation can't load, and can try again", async () => {
    fixture.load.mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ messages: [ask], activeLeafId: "m1" });
    render(sent());
    flushSync(() => chip().click());
    await settle();
    flushSync(() => {});
    expect(dialog()!.textContent).toContain("Couldn't load the conversation.");
    flushSync(() => button("Try again").click());
    await settle();
    flushSync(() => {});
    expect(dialog()!.textContent).toContain("Please check the build");
  });

  it("keeps opening the thread for a line the person sent directly, the helper's main chat, or a thread it no longer has", () => {
    for (const message of [sent({ sentDirectly: { name: "Ferramenteiro" } }), sent({ threadRef: { botId: "tool", threadId: "tool-main", title: "Main" } }),
      sent({ threadRef: { botId: "tool", threadId: "gone", title: "Old" } })]) {
      fixture.dispatch.mockClear();
      render(message);
      expect(chip().textContent).not.toContain("View conversation");
      flushSync(() => chip().click());
      expect(dialog()).toBeNull();
      expect(fixture.dispatch).toHaveBeenCalled();
    }
  });
});
