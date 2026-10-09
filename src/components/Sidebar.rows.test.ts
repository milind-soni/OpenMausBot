// @vitest-environment happy-dom
// Sidebar rows re-render only when their own bot or thread changes. A store
// event for one bot renders that bot's row and no other; a renamed thread
// renders that thread's row; the list's 30-second clock renders only the
// thread rows whose stamp reads relative ("5 min ago"), not the ones that
// show a fixed date. Counted through a leaf each row draws, which is not
// memoized here, so it renders exactly when its row does: the bot name
// (RenameTitle) for a bot row, the delete confirmation for a thread row.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, InstanceInfo, Message, Task } from "@/state/store";

const renders = vi.hoisted(() => ({ bots: [] as string[], threads: [] as string[] }));
vi.mock("./RenameTitle", () => ({
  RenameTitle: ({ value }: { value: string }) => {
    renders.bots.push(value);
    return createElement("span", null, value);
  },
}));
vi.mock("./ConfirmDialog", async (importOriginal) => ({
  ...await importOriginal<typeof import("./ConfirmDialog")>(),
  // every thread row keeps its (closed) delete confirmation mounted; its
  // body names the thread
  ConfirmDialog: ({ body }: { body?: unknown }) => {
    if (typeof body === "string") renders.threads.push(body);
    return null;
  },
}));
// Threads are an Advanced-mode surface: Simple mode keeps one conversation
// per bot (useShowThreads), so these render as Advanced.
vi.mock("@/lib/interface-mode", async (original) => ({
  ...await original<typeof import("@/lib/interface-mode")>(),
  useAdvancedMode: () => true,
}));
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/cloud-guest", () => ({ useCanWriteIn: () => true }));

const { Sidebar } = await import("./Sidebar");
const { BotEditorStore, initialState, reducer } = await import("@/state/store");
const { setLocale, t } = await import("@/lib/i18n");

const HOUR = 3_600_000;
const NOW = new Date(2026, 9, 4, 12, 0).getTime();

const thread = (threadId: string, title: string, updatedAt: number): Task =>
  ({ threadId, title, createdAt: 1, updatedAt, busy: false, activity: "idle", modelSelection: { instanceId: "test", model: "m" }, approvalMode: "ask" });
const reply = (id: string, parentId: string | undefined, text: string): Message =>
  ({ id, parentId, role: "bot", kind: "text", text, at: NOW - HOUR });
const profile = (id: string, name: string, tasks: Task[], extra: Partial<Bot> = {}): Bot => ({
  id, threadId: tasks[0]!.threadId, name, title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages: [], modelSelection: { instanceId: "test", model: "m" },
  tasks, ...extra,
});

const atlasMessages = [reply("a1", undefined, "Hello"), reply("a2", "a1", "Done with the report.")];
let state: AppState = {
  ...initialState,
  connected: true,
  selectedId: "atlas",
  activeView: "chat",
  bots: [
    profile("atlas", "Atlas", [
      thread("atlas-now", "Report draft", NOW - HOUR),
      thread("atlas-earlier", "Budget check", NOW - 2 * HOUR),
      // a month old: its stamp is a date, so the clock has nothing to change
      thread("atlas-old", "Old notes", NOW - 30 * 24 * HOUR),
    ], { messages: atlasMessages, activeLeafId: "a2" }),
    profile("scout", "Scout", [thread("scout-now", "Scout plan", NOW - HOUR), thread("scout-earlier", "Scout list", NOW - 3 * HOUR)]),
    profile("pepper", "Pepper", [thread("pepper-now", "Pepper notes", NOW - HOUR)]),
  ],
  instances: [{ instanceId: "test", driverKind: "codex", displayName: "Test", snapshot: { state: "available" } } as InstanceInfo],
};
const dispatch = vi.fn();
let root: Root;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
async function draw() {
  const value = { state, dispatch, flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  flushSync(() => root.render(createElement(BotEditorStore, { value, children: createElement(Sidebar, { open: true, onClose: () => {} }) })));
  await settle();
}
const threadTitles = ["Report draft", "Budget check", "Old notes"];
function counted() {
  const bots: Record<string, number> = {};
  for (const name of renders.bots) bots[name] = (bots[name] ?? 0) + 1;
  const threads: Record<string, number> = {};
  for (const body of renders.threads) {
    const title = threadTitles.find((candidate) => body.includes(`“${candidate}”`));
    if (title) threads[title] = (threads[title] ?? 0) + 1;
  }
  return { bots, threads };
}
async function rowRendersAfter(change: () => void | Promise<void>) {
  renders.bots = [];
  renders.threads = [];
  await change();
  await settle();
  return counted();
}
const update = (next: (current: AppState) => AppState) => async () => {
  state = next(state);
  await draw();
};
const bot = (id: string) => state.bots.find((candidate) => candidate.id === id)!;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(NOW);
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  setLocale("en");
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await draw();
  // open Atlas's thread list, as a person would
  const toggle = document.querySelector<HTMLButtonElement>(`button[aria-label="${t("task.expandNamed", { name: "Atlas" })}"]`);
  toggle!.click();
  await settle();
});
afterAll(() => {
  root.unmount();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setLocale("en");
});

describe("sidebar rows", () => {
  it("draws every bot row and the open thread list", () => {
    for (const id of ["atlas", "scout", "pepper"]) expect(document.querySelector(`[data-sidebar-bot-row="${id}"]`)).not.toBeNull();
    for (const id of ["atlas-now", "atlas-earlier", "atlas-old"]) expect(document.querySelector(`[data-sidebar-thread-row="${id}"]`)).not.toBeNull();
    expect(document.body.textContent).toContain(t("task.updated.hours", { count: 1 }));
  });

  it("renders no row for a store event no row shows", async () => {
    expect(await rowRendersAfter(update((current) => reducer(current, { type: "toggleSettings", open: true }))))
      .toEqual({ bots: {}, threads: {} });
  });

  it("renders only the row of the bot that changed", async () => {
    expect(await rowRendersAfter(update((current) => reducer(current, { type: "botPatched", bot: { ...bot("scout"), busy: true } }))))
      .toEqual({ bots: { Scout: 1 }, threads: {} });
  });

  it("renders only that bot's row and its thread for a new message", async () => {
    const message = { ...reply("a3", "a2", "One more thing."), at: NOW };
    const changed = await rowRendersAfter(update((current) => reducer(current, { type: "messageAdded", threadId: "atlas-now", message })));
    expect(changed).toEqual({ bots: { Atlas: 1 }, threads: { "Report draft": 1 } });
    expect(document.querySelector('[data-sidebar-thread-row="atlas-now"]')?.textContent).toContain(t("task.updated.justNow"));
  });

  it("renders only the renamed thread's row among the threads", async () => {
    threadTitles[1] = "Budget review";
    expect(await rowRendersAfter(update((current) => reducer(current, { type: "renameTask", botId: "atlas", threadId: "atlas-earlier", title: "Budget review" }))))
      .toEqual({ bots: { Atlas: 1 }, threads: { "Budget review": 1 } });
  });

  it("re-renders only the thread rows with a relative stamp on the clock's tick", async () => {
    const changed = await rowRendersAfter(() => { vi.advanceTimersByTime(30_000); });
    expect(changed).toEqual({ bots: {}, threads: { "Report draft": 1, "Budget review": 1 } });
  });

  it("moves the selection with exactly the two rows it changes", async () => {
    const changed = await rowRendersAfter(update((current) => reducer(current, { type: "select", id: "scout" })));
    expect(changed.bots).toEqual({ Atlas: 1, Scout: 1 });
    expect(document.querySelector('[data-sidebar-bot-row="scout"]')?.getAttribute("aria-current")).toBe("page");
    expect(document.querySelector('[data-sidebar-thread-row="atlas-now"]')?.getAttribute("aria-current")).toBeNull();
  });

  it("re-renders every row when the app language changes", async () => {
    try {
      setLocale("de");
      const changed = await rowRendersAfter(draw);
      expect(changed.bots).toEqual({ Atlas: 1, Scout: 1, Pepper: 1 });
      expect(Object.keys(changed.threads)).toHaveLength(3);
      expect(document.querySelector('[data-sidebar-thread-row="atlas-earlier"]')?.textContent).toContain("vor 2 Std.");
    } finally {
      setLocale("en");
      await draw();
    }
  });
});
