// @vitest-environment happy-dom
// The New divider in an open chat: it sits above the first message that came
// in while the person was away, stays there while more stream in, and fades
// once they write back. None of it re-renders a row.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Action, AppState, Bot, InstanceInfo, Message } from "@/state/store";

const renders = vi.hoisted(() => ({ botText: 0 }));
vi.mock("./ChatMarkdown", async (importOriginal) => ({
  ...await importOriginal<typeof import("./ChatMarkdown")>(),
  ChatMarkdown: ({ text }: { text: string }) => {
    renders.botText++;
    return createElement("p", null, text);
  },
}));
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/cloud-guest", () => ({ useCanWriteIn: () => true }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));

const { ChatView } = await import("./ChatView");
const { BotEditorStore, initialState, reducer } = await import("@/state/store");
const { UNREAD_DIVIDER_FADE_MS, UNREAD_DIVIDER_LINGER_MS } = await import("@/lib/unread-divider");
const { t } = await import("@/lib/i18n");

const at = (minute: number) => new Date(2026, 9, 8, 9, minute).getTime();
const line = (id: string, role: Message["role"], minute: number, parentId?: string): Message =>
  ({ id, role, kind: "text", text: `${id} text`, at: at(minute), parentId });
const read = [line("u1", "user", 1), line("b2", "bot", 2, "u1"), line("u3", "user", 3, "b2")];
const away = [line("b4", "bot", 4, "u3"), line("b5", "bot", 5, "b4")];

const profile = (id: string, messages: Message[], unread: boolean): Bot => ({
  id, threadId: `${id}-thread`, name: id, title: "", description: "", color: "green",
  notifications: true, unread, busy: false, messages, activeLeafId: messages.at(-1)?.id,
  modelSelection: { instanceId: "test", model: "m" },
  tasks: [{ threadId: `${id}-thread`, title: "Thread", createdAt: 1, busy: false, activity: "idle", unread, modelSelection: { instanceId: "test", model: "m" }, approvalMode: "ask" }],
});

let state: AppState;
const dispatched: Action[] = [];
const dispatch = (action: Action) => { dispatched.push(action); };
let root: Root;
async function draw() {
  const value = { state, dispatch, flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  const children = createElement(ChatView, { bot: state.bots.find((bot) => bot.id === state.selectedId)! });
  flushSync(() => root.render(createElement(BotEditorStore, { value, children })));
  await vi.advanceTimersByTimeAsync(0);
}
async function apply(action: Action) {
  renders.botText = 0;
  state = reducer(state, action);
  await draw();
  return renders.botText;
}
const divider = () => document.querySelector<HTMLElement>('[role="separator"][data-unread-divider]');
/** The row right under the divider. */
const rowUnder = () => divider()?.closest("[data-mid]")?.getAttribute("data-mid") ?? null;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date(2026, 9, 8, 10, 0));
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  state = {
    ...initialState,
    connected: true,
    selectedId: "scout",
    bots: [profile("pepper", [...read, ...away], true), profile("scout", [line("s1", "user", 1)], false)],
    instances: [{ instanceId: "test", driverKind: "codex", displayName: "Test", snapshot: { state: "available" } } as InstanceInfo],
  };
  await draw();
});
afterAll(() => {
  root.unmount();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the New divider in a chat", () => {
  it("is not drawn in a conversation that was read", () => {
    expect(divider()).toBeNull();
  });

  it("opens above the first message that came in while away", async () => {
    await apply({ type: "select", id: "pepper" });
    expect(divider()?.getAttribute("aria-label")).toBe(t("chat.newMessagesAria"));
    expect(divider()?.textContent).toBe(t("chat.newMessages"));
    expect(rowUnder()).toBe("b4");
  });

  it("holds still while more streams in", async () => {
    // the new row, and the answer before it handing Regenerate on
    expect(await apply({ type: "messageAdded", threadId: "pepper-thread", message: line("b6", "bot", 6, "b5") })).toBe(2);
    expect(rowUnder()).toBe("b4");
    await vi.advanceTimersByTimeAsync(UNREAD_DIVIDER_LINGER_MS + UNREAD_DIVIDER_FADE_MS);
    expect(divider()?.className).not.toContain("opacity-0");
  });

  it("fades a moment after the person writes back, then is done", async () => {
    await apply({ type: "messageAdded", threadId: "pepper-thread", message: line("u7", "user", 7, "b6") });
    expect(divider()?.className).not.toContain("opacity-0");
    renders.botText = 0;
    await vi.advanceTimersByTimeAsync(UNREAD_DIVIDER_LINGER_MS);
    // and the render that timer asked for
    await vi.advanceTimersByTimeAsync(0);
    expect(divider()?.className).toContain("opacity-0");
    expect(divider()?.className).toContain("grid-rows-[0fr]");
    expect(renders.botText).toBe(0);
    expect(dispatched.some((action) => action.type === "unreadDividerDone")).toBe(false);
    await vi.advanceTimersByTimeAsync(UNREAD_DIVIDER_FADE_MS);
    const done = dispatched.find((action) => action.type === "unreadDividerDone")!;
    expect(done).toEqual({ type: "unreadDividerDone", threadId: "pepper-thread" });
    expect(await apply(done)).toBe(0);
    expect(divider()).toBeNull();
  });

  it("is not drawn when the open conversation was already read", async () => {
    await apply({ type: "select", id: "scout" });
    await apply({ type: "select", id: "pepper" });
    expect(divider()).toBeNull();
  });
});
