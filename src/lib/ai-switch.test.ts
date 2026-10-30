// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Action, Bot, Message } from "@/state/store";
import type { RuntimeEvent } from "../../shared/runtime-events";

const api = vi.hoisted(() => vi.fn());
vi.mock("@/state/api", () => ({ api, ApiError: Error }));

const { requestAiSwitch, resetAiSwitch, useAiSwitch, useAiSwitchKeeper, useAiSwitchRow, AI_SWITCH_SETTLE_MS } = await import("./ai-switch");
const { forgetStops, noteRuntimeTurn } = await import("./stop-turn");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const asked: Message = { id: "ask-1", at: 1, role: "user", kind: "text", text: "Plan my week" };
const bot = (busy: boolean, messages: Message[] = [asked]): Bot => ({
  id: "bot-1", threadId: "thread-1", name: "Maus", title: "", description: "", notifications: true, color: "green", unread: false, busy,
  modelSelection: { instanceId: "opencodeGo", model: "free" }, messages,
  tasks: [{ threadId: "thread-1", title: "Chat", createdAt: 1, busy }],
} as unknown as Bot);
const intent = { botId: "bot-1", threadId: "thread-1", turnId: "turn-1", requestMessageId: "ask-1", place: "header" as const };
const toClaude: Action = { type: "setModel", botId: "bot-1", threadId: "thread-1", selection: { instanceId: "claude", model: "opus" } };
const resend = (text = "Plan my week"): Action => ({ type: "editMessage", botId: "bot-1", threadId: "thread-1", messageId: "ask-1", text });
const frame = (type: string, turnId: string) => ({ type, turnId, threadId: "thread-1" }) as RuntimeEvent;
/** What the server answers a saved switch with, and the store hears. */
const saved = (threadId = "thread-1") => ({ id: "bot-1", threadId, modelSelection: { instanceId: "claude", model: "opus" } });
const switched = (threadId = "thread-1"): Action => ({ type: "botPatched", bot: saved(threadId) as never });
const busyRefusal = () => Object.assign(new Error("the bot is working — stop it before changing models"), { status: 409 });
let stopAnswer: unknown;
let saveAnswers: Array<() => Promise<unknown>>;
const saves = () => api.mock.calls.filter(([path]) => String(path).includes("/tasks/"));

let host: HTMLDivElement;
let root: Root;
let seen: { bot: Bot; dispatch: (action: Action) => void } | null;
let store: ReturnType<typeof vi.fn<(action: Action) => void>>;

/** Stands in for a model picker: the hook's bot and dispatch are what the picker uses. */
function Picker(props: { bot: Bot; contained?: boolean; threadId?: string; setOpen?: (open: boolean) => void }) {
  seen = useAiSwitch({ bot: props.bot, threadId: props.threadId ?? "thread-1", contained: props.contained ?? false, dispatch: store, setOpen: props.setOpen ?? vi.fn() });
  return null;
}
/** Stands in for the rescue row on screen. */
function Row(props: { live?: boolean }) {
  useAiSwitchRow({ threadId: "thread-1", turnId: "turn-1", live: props.live ?? true });
  return null;
}
/** Stands in for the app, which carries a pick through whatever is on screen. */
function Keeper(props: { bot: Bot }) {
  useAiSwitchKeeper({ bots: [props.bot], dispatch: store });
  return null;
}
const show = (...children: ReturnType<typeof createElement>[]) => act(() => root.render(createElement("div", null, ...children)));
const settle = async (ms = AI_SWITCH_SETTLE_MS) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
/** Opens the switch on a silent turn, with the row on screen, and picks Claude. */
async function pickClaude(outcome?: string) {
  stopAnswer = outcome ? { ok: true, outcome } : { ok: true };
  noteRuntimeTurn(frame("turn.started", "turn-1"));
  show(createElement(Picker, { bot: bot(true) }), createElement(Row), createElement(Keeper, { bot: bot(true) }));
  act(() => requestAiSwitch(intent));
  act(() => seen!.dispatch(toClaude));
  await settle(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  api.mockReset();
  stopAnswer = { ok: true };
  saveAnswers = [];
  api.mockImplementation((path: string) => {
    if (path.endsWith("/interrupt")) return Promise.resolve(stopAnswer);
    const threadId = path.split("/tasks/")[1]!;
    return saveAnswers.shift()?.() ?? Promise.resolve({ bot: saved(threadId) });
  });
  store = vi.fn<(action: Action) => void>();
  seen = null;
  forgetStops();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  resetAiSwitch();
  vi.useRealTimers();
});

describe("Switch AI", () => {
  it("opens only the picker it names, once, and lets it open while the turn runs", () => {
    const header = vi.fn();
    const panel = vi.fn();
    show(createElement(Picker, { bot: bot(true), setOpen: header }), createElement(Picker, { bot: bot(true), contained: true, setOpen: panel }));
    act(() => requestAiSwitch(intent));
    expect(header).toHaveBeenCalledWith(true);
    expect(panel).not.toHaveBeenCalled();
    show(createElement(Picker, { bot: bot(true), setOpen: header }));
    expect(header).toHaveBeenCalledTimes(1);
    expect(api).not.toHaveBeenCalled();
  });

  it("leaves another thread's picker alone", () => {
    const other = vi.fn();
    show(createElement(Picker, { bot: bot(true), threadId: "thread-2", setOpen: other }));
    act(() => requestAiSwitch(intent));
    expect(other).not.toHaveBeenCalled();
    expect(seen!.bot.busy).toBe(true);
  });

  it("stops that exact turn only when another AI is picked, then switches and asks again once it has ended", async () => {
    await pickClaude();
    expect(api).toHaveBeenCalledWith("/api/bots/bot-1/interrupt", { method: "POST", body: JSON.stringify({ threadId: "thread-1", turnId: "turn-1" }) });
    // The server refuses a model change mid-turn: nothing is sent until the stopped turn has ended.
    await settle();
    expect(store).not.toHaveBeenCalled();
    noteRuntimeTurn(frame("turn.completed", "turn-1"));
    show(createElement(Row), createElement(Keeper, { bot: bot(false) }));
    await settle();
    expect(store.mock.calls).toEqual([[switched()], [resend()]]);
    expect(saves()).toEqual([["/api/bots/bot-1/tasks/thread-1", { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "opus" } }) }]]);
  });

  it("counts the idle wait from the chat going idle, whatever else of the bot changes meanwhile", async () => {
    await pickClaude();
    show(createElement(Row), createElement(Keeper, { bot: bot(false) }));
    await settle(AI_SWITCH_SETTLE_MS - 200);
    // Another conversation of the same bot streams: a new bot object, the same idle chat.
    show(createElement(Row), createElement(Keeper, { bot: { ...bot(false), unread: true } as Bot }));
    await settle(200);
    expect(store.mock.calls).toEqual([[switched()], [resend()]]);
  });

  it("keeps the switch through a turn that started just before it, and lands it at the next idle", async () => {
    saveAnswers.push(() => Promise.reject(busyRefusal()));
    await pickClaude();
    show(createElement(Row), createElement(Keeper, { bot: bot(false) }));
    await settle();
    expect(saves()).toHaveLength(1);
    expect(store).not.toHaveBeenCalled();
    show(createElement(Row), createElement(Keeper, { bot: bot(true) }));
    await settle();
    show(createElement(Row), createElement(Keeper, { bot: bot(false) }));
    await settle();
    expect(saves()).toHaveLength(2);
    expect(store.mock.calls[0]).toEqual([switched()]);
  });

  it("keeps a switch in each chat it was picked in", async () => {
    stopAnswer = { ok: true };
    const two = { ...bot(true), threadId: "thread-2", tasks: [{ threadId: "thread-1", title: "A", createdAt: 1, busy: true }, { threadId: "thread-2", title: "B", createdAt: 2, busy: true }] } as unknown as Bot;
    show(createElement(Picker, { bot: two, threadId: "thread-1" }), createElement(Keeper, { bot: two }));
    act(() => requestAiSwitch(intent));
    act(() => seen!.dispatch(toClaude));
    show(createElement(Picker, { bot: two, threadId: "thread-2" }), createElement(Keeper, { bot: two }));
    act(() => requestAiSwitch({ ...intent, threadId: "thread-2", turnId: "turn-9" }));
    act(() => seen!.dispatch({ ...toClaude, threadId: "thread-2" } as Action));
    await settle(0);
    const idle = { ...two, busy: false, tasks: [{ threadId: "thread-1", title: "A", createdAt: 1, busy: false }, { threadId: "thread-2", title: "B", createdAt: 2, busy: false }] } as unknown as Bot;
    show(createElement(Keeper, { bot: idle }));
    await settle();
    expect(saves().map(([path]) => path)).toEqual(["/api/bots/bot-1/tasks/thread-1", "/api/bots/bot-1/tasks/thread-2"]);
  });

  it("switches without asking again when the turn was already over", async () => {
    await pickClaude("already-stopped");
    show(createElement(Row), createElement(Keeper, { bot: bot(false) }));
    await settle();
    expect(store.mock.calls).toEqual([[switched()]]);
  });

  it("waits for the chat to stay idle, so the next queued turn's start is never taken for the end", async () => {
    await pickClaude();
    show(createElement(Row), createElement(Keeper, { bot: bot(false) }));
    await settle(AI_SWITCH_SETTLE_MS - 1);
    show(createElement(Row), createElement(Keeper, { bot: bot(true) }));
    await settle();
    expect(store).not.toHaveBeenCalled();
  });

  it("switches without asking again when a message queued during the silence ran after the stop", async () => {
    await pickClaude();
    const queued: Message = { id: "queued-1", at: 2, role: "user", kind: "text", text: "Also book a dentist" };
    show(createElement(Row), createElement(Keeper, { bot: bot(false, [asked, queued]) }));
    await settle();
    expect(store.mock.calls).toEqual([[switched()]]);
  });

  it("switches without asking again when another turn ran since the stop", async () => {
    await pickClaude();
    noteRuntimeTurn(frame("turn.completed", "turn-1"));
    noteRuntimeTurn(frame("turn.started", "turn-2"));
    noteRuntimeTurn(frame("turn.completed", "turn-2"));
    show(createElement(Row), createElement(Keeper, { bot: bot(false) }));
    await settle();
    expect(store.mock.calls).toEqual([[switched()]]);
  });

  it("keeps the switch when the person leaves the chat, and only the resend goes with the row", async () => {
    await pickClaude();
    show(createElement(Keeper, { bot: bot(true) }));
    show(createElement(Keeper, { bot: bot(false) }));
    await settle();
    expect(store.mock.calls).toEqual([[switched()]]);
  });

  it("keeps a pick already made when Switch AI is pressed again", async () => {
    await pickClaude();
    act(() => requestAiSwitch({ ...intent, place: "panel" }));
    show(createElement(Row), createElement(Keeper, { bot: bot(false) }));
    await settle();
    expect(store.mock.calls).toEqual([[switched()], [resend()]]);
  });

  it("sends again a message whose images ride in its own words", async () => {
    const withImage = { ...asked, text: 'Plan my week\n\n<attached-image path="/tmp/week.png" name="week.png" />' };
    await pickClaude();
    show(createElement(Row), createElement(Keeper, { bot: bot(false, [withImage]) }));
    await settle();
    expect(store.mock.calls).toEqual([[switched()], [resend(withImage.text)]]);
  });

  it.each([
    ["attachments", { attachments: [{ kind: "audio", path: "/tmp/note.webm", mime: "audio/webm" }] }],
    ["parts of a page it pointed at", { pointed: [{ messageId: "app-1", label: "Header" }] }],
    ["data it was sent with", { dataContext: { kind: "sheet" } }],
    ["the app that sent it", { fromApp: { messageId: "app-1", title: "Booking" } }],
  ])("switches without asking again for a message with %s, which a resend would lose", async (_label, extra) => {
    await pickClaude();
    show(createElement(Row), createElement(Keeper, { bot: bot(false, [{ ...asked, ...extra } as Message]) }));
    await settle();
    expect(store.mock.calls).toEqual([[switched()]]);
  });

  it("drops a change to the same AI while the turn runs, and passes other actions through", () => {
    show(createElement(Picker, { bot: bot(true) }));
    act(() => requestAiSwitch(intent));
    act(() => seen!.dispatch({ type: "setModel", botId: "bot-1", threadId: "thread-1", selection: { instanceId: "opencodeGo", model: "free", effort: "high" } }));
    act(() => seen!.dispatch({ type: "toggleAppSettings", open: true, section: "engines" }));
    expect(api).not.toHaveBeenCalled();
    expect(store.mock.calls).toEqual([[{ type: "toggleAppSettings", open: true, section: "engines" }]]);
  });

  it("hands the picker back to the running turn once the row's turn is over or the row is gone", () => {
    show(createElement(Picker, { bot: bot(true) }), createElement(Row));
    act(() => requestAiSwitch(intent));
    expect(seen!.bot.busy).toBe(false);
    show(createElement(Picker, { bot: bot(true) }), createElement(Row, { live: false }));
    expect(seen!.bot.busy).toBe(true);
    act(() => requestAiSwitch(intent));
    show(createElement(Picker, { bot: bot(true) }));
    expect(seen!.bot.busy).toBe(true);
  });
});
