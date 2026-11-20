import { describe, expect, it, vi } from "vitest";
import { lastLine } from "@/components/sidebar-preview";
import { botUnreadCount } from "@/lib/bot-unread";
import { forgetTranscriptPositions, rememberTranscriptPosition } from "@/lib/transcript-follow";
import { HELD_AFTER_LEAVING, HELD_IN_BACKGROUND, loadShortHeldOnOpen } from "./message-history";
import { visibleMessages } from "./snapshot-navigation";
import { initialState, reducer, type Action, type AppState, type Bot, type Message } from "./store";

const row = (index: number, parentId: string | null): Message =>
  ({ id: `w${index}`, at: index, parentId, role: index % 25 ? "bot" : "user", kind: index % 3 ? "activity" : "text", text: `line ${index}`,
    ...(index % 3 ? { tool: { name: "Bash", ok: true, input: "{}" } } : {}) }) as Message;
const worker = (count: number): Bot => {
  const messages = Array.from({ length: count }, (_, index) => row(index, index ? `w${index - 1}` : null));
  return { id: "worker", threadId: "work", name: "Worker", messages, hasMore: false, activeLeafId: messages.at(-1)?.id ?? null, unread: true,
    tasks: [{ threadId: "work", title: "Work", createdAt: 1, unread: true }] } as unknown as Bot;
};
const reader = { id: "reader", threadId: "read", name: "Reader", messages: [], hasMore: false, tasks: [] } as unknown as Bot;
const held = (state: AppState) => state.bots.find((bot) => bot.id === "worker")!;
const land = (state: AppState, index: number) => {
  const parentId = held(state).activeLeafId ?? null;
  return reducer(state, { type: "messageAdded", threadId: "work", message: row(index, parentId) });
};
const looksLike = (bot: Bot) => ({ simple: lastLine(bot, visibleMessages(bot), [], false), advanced: lastLine(bot, visibleMessages(bot), [], true), unread: botUnreadCount(bot) });

describe("a conversation nobody has on screen, as its rows keep landing", () => {
  it("keeps only its newest rows past the cap, with the same preview and unread count", () => {
    let state: AppState = { ...initialState, bots: [worker(HELD_IN_BACKGROUND), reader], selectedId: "reader", activeView: "chat" };
    const before = looksLike(held(state));
    state = land(state, HELD_IN_BACKGROUND);
    expect(held(state).messages).toHaveLength(HELD_AFTER_LEAVING);
    expect(held(state).messages.at(-1)!.id).toBe(`w${HELD_IN_BACKGROUND}`);
    expect(held(state).hasMore).toBe(true);
    const unchanged = { ...looksLike(held(state)) };
    const grown = reducer({ ...initialState, bots: [worker(HELD_IN_BACKGROUND + 1), reader], selectedId: "reader", activeView: "chat" }, { type: "showChat" });
    expect(unchanged).toEqual(looksLike(held(grown)));
    expect(before.unread).toBe(unchanged.unread);
    for (let index = HELD_IN_BACKGROUND + 1; index < HELD_IN_BACKGROUND * 3; index++) state = land(state, index);
    expect(held(state).messages.length).toBeLessThanOrEqual(HELD_IN_BACKGROUND);
  });

  it("never trims the conversation on screen, nor the first bot the chat draws when the selection names no one", () => {
    for (const selectedId of ["worker", "gone"]) {
      let state: AppState = { ...initialState, bots: [worker(HELD_IN_BACKGROUND), reader], selectedId, activeView: "chat" };
      for (let index = HELD_IN_BACKGROUND; index < HELD_IN_BACKGROUND + 50; index++) state = land(state, index);
      expect(held(state).messages).toHaveLength(HELD_IN_BACKGROUND + 50);
    }
  });

  it("keeps the row the reader left it at", () => {
    const place = `w${HELD_IN_BACKGROUND - 450}`;
    rememberTranscriptPosition("worker:work", { atEnd: false, rowId: place, offsetWithinRow: 0 });
    let state: AppState = { ...initialState, bots: [worker(HELD_IN_BACKGROUND), reader], selectedId: "reader", activeView: "chat" };
    state = land(state, HELD_IN_BACKGROUND);
    expect(held(state).messages[0]!.id).toBe(place);
    expect(held(state).messages.length).toBeLessThan(HELD_IN_BACKGROUND);
    forgetTranscriptPositions();
  });

  it("pages back the rows it let go when it opens again, the same rows as before", () => {
    const thread = worker(HELD_IN_BACKGROUND + 1).messages;
    let state: AppState = { ...initialState, bots: [worker(HELD_IN_BACKGROUND), reader], selectedId: "reader", activeView: "chat" };
    state = land(state, HELD_IN_BACKGROUND);
    state = reducer(state, { type: "select", id: "worker" });
    const first = held(state).messages[0]!.id;
    const at = thread.findIndex((message) => message.id === first);
    state = reducer(state, { type: "olderMessages", threadId: "work", generation: 0, before: first, messages: thread.slice(Math.max(0, at - 200), at), hasMore: at > 200 });
    expect(held(state).messages).toEqual(thread.slice(-held(state).messages.length));
    expect(held(state).messages.length).toBeGreaterThan(HELD_AFTER_LEAVING);
  });
});

describe("opening a conversation held as a short tail", () => {
  const tailed = (count: number, hasMore: boolean) => ({ ...worker(count), hasMore });
  const open = (bot: Bot, loadingOlder: Record<string, true> = {}) => {
    const dispatched: Action[] = [];
    const inFlight = new Set<string>();
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    loadShortHeldOnOpen({ ...initialState, bots: [bot], loadingOlder }, bot.id, inFlight, (action) => dispatched.push(action), () => {});
    vi.unstubAllGlobals();
    return { dispatched, inFlight };
  };

  it("asks for the page before its tail through the older-rows path", () => {
    const { dispatched, inFlight } = open(tailed(20, true));
    expect(dispatched).toEqual([{ type: "loadOlderMessages", threadId: "work" }]);
    expect([...inFlight]).toEqual(["work"]);
  });

  it("asks nothing of a whole page, a whole short conversation, or a page already on its way", () => {
    expect(open(tailed(200, true)).dispatched).toEqual([]);
    expect(open(tailed(20, false)).dispatched).toEqual([]);
    expect(open(tailed(20, true), { work: true }).dispatched).toEqual([]);
  });
});
