import { describe, expect, it } from "vitest";
import { lastLine } from "@/components/sidebar-preview";
import { botUnreadCount } from "@/lib/bot-unread";
import { forgetTranscriptPositions, rememberTranscriptPosition } from "@/lib/transcript-follow";
import { setWebPanels } from "@/lib/web-panel-preferences";
import { createAppStore } from "./app-store";
import { followHeldTails, noteSnapshotTails } from "./held-tails";
import { HELD_AFTER_LEAVING, HELD_IN_BACKGROUND } from "./message-history";
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

  it("never trims a conversation whose pinned page the web panel shows", () => {
    setWebPanels([{ id: "panel-1", name: "Sales", page: { botId: "worker", threadId: "work", messageId: "w3" } }]);
    let state: AppState = { ...initialState, bots: [worker(HELD_IN_BACKGROUND), reader], selectedId: "reader", activeView: "web-panel", webPanelId: "panel-1" };
    state = land(state, HELD_IN_BACKGROUND);
    expect(held(state).messages).toHaveLength(HELD_IN_BACKGROUND + 1);
    setWebPanels([]);
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

describe("a conversation the snapshot sent as a short tail", () => {
  const tailed = (count: number, hasMore = true) => ({ ...worker(count), hasMore });
  /** A store holding `state`, the tails the snapshot sent, and what the follower asks for. */
  async function follow(state: AppState, tails: Bot[]) {
    const store = createAppStore<AppState, Action, never>(reducer, state, () => () => {});
    const asked: Action[] = [];
    noteSnapshotTails(tails);
    const stop = followHeldTails(store, (action) => asked.push(action));
    await Promise.resolve();
    return { store, asked, stop, settle: () => Promise.resolve() };
  }

  it("asks for the page before its tail however it becomes selected", async () => {
    for (const select of [{ type: "select", id: "worker" }, { type: "toggleComputer", botId: "worker", open: true }, { type: "toggleSettings", botId: "worker", open: true }] as Action[]) {
      const bot = tailed(20);
      const { store, asked, stop, settle } = await follow({ ...initialState, bots: [reader, bot], selectedId: "reader", activeView: "team-map" }, [bot]);
      expect(asked).toEqual([]);
      store.dispatch(select);
      await settle();
      expect(asked, select.type).toEqual([{ type: "loadOlderMessages", threadId: "work" }]);
      store.dispatch({ type: "loadOlderMessages", threadId: "work" });
      store.dispatch({ type: "select", id: "reader" });
      store.dispatch(select);
      await settle();
      expect(asked, "not again while its page is on the way").toHaveLength(1);
      stop();
    }
  });

  it("asks for it when the selection falls to it because the selected bot is gone", async () => {
    const bot = tailed(20);
    const { asked, stop } = await follow({ ...initialState, bots: [bot, reader], selectedId: "gone", activeView: "chat" }, [bot]);
    expect(asked).toEqual([{ type: "loadOlderMessages", threadId: "work" }]);
    stop();
  });

  it("asks for it when another client moves its branch, not when a new row lands", async () => {
    const bot = tailed(20);
    const { store, asked, stop, settle } = await follow({ ...initialState, bots: [reader, bot], selectedId: "reader", activeView: "chat" }, [bot]);
    store.dispatch({ type: "messageAdded", threadId: "work", message: row(20, held(store.getState()).activeLeafId ?? null) });
    await settle();
    expect(asked).toEqual([]);
    store.dispatch({ type: "threadActive", threadId: "work", activeLeafId: "elsewhere" });
    await settle();
    expect(asked).toEqual([{ type: "loadOlderMessages", threadId: "work" }]);
    stop();
  });

  it("asks again after a failed page, at most once per opening, and stops once a page lands", async () => {
    const bot = tailed(20);
    const thread = worker(400).messages;
    const { store, asked, stop, settle } = await follow({ ...initialState, bots: [reader, bot], selectedId: "reader", activeView: "chat" }, [bot]);
    const fail = () => {
      store.dispatch({ type: "loadOlderMessages", threadId: "work" });
      store.dispatch({ type: "olderMessages", threadId: "work", generation: 0, before: "w0", messages: [], hasMore: true });
    };
    store.dispatch({ type: "select", id: "worker" });
    await settle();
    expect(asked).toHaveLength(1);
    fail();
    await settle();
    expect(asked, "one more ask after a failed page").toHaveLength(2);
    fail();
    await settle();
    expect(asked, "no loop").toHaveLength(2);

    store.dispatch({ type: "select", id: "reader" });
    store.dispatch({ type: "select", id: "worker" });
    await settle();
    expect(asked, "selected again: a fresh ask").toHaveLength(3);
    store.dispatch({ type: "loadOlderMessages", threadId: "work" });
    store.dispatch({ type: "olderMessages", threadId: "work", generation: 0, before: "w0", messages: thread.slice(0, 0), hasMore: true });
    await settle();
    expect(asked).toHaveLength(4);
    const older = Array.from({ length: 200 }, (_, index) => ({ ...thread[0]!, id: `older-${index}` }));
    store.dispatch({ type: "olderMessages", threadId: "work", generation: 0, before: "w0", messages: older, hasMore: true });
    await settle();
    expect(held(store.getState()).messages).toHaveLength(220);
    store.dispatch({ type: "select", id: "reader" });
    store.dispatch({ type: "select", id: "worker" });
    await settle();
    expect(asked, "landed: nothing more to ask").toHaveLength(4);
    stop();
  });

  it("leaves alone a whole page, a whole short conversation, and a conversation switched to since", async () => {
    for (const bot of [tailed(200), tailed(20, false)]) {
      const { asked, stop } = await follow({ ...initialState, bots: [bot, reader], selectedId: "worker", activeView: "chat" }, [bot]);
      expect(asked).toEqual([]);
      stop();
    }
    const switched = { ...tailed(20), messages: worker(20).messages.map((message) => ({ ...message, id: `other-${message.id}` })) };
    const { asked, stop } = await follow({ ...initialState, bots: [switched, reader], selectedId: "worker", activeView: "chat" }, [tailed(20)]);
    expect(asked).toEqual([]);
    stop();
  });
});
