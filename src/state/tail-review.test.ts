import { describe, expect, it } from "vitest";
import { heldTail } from "../../server/host/snapshot-tail.ts";
import { lastLine } from "@/components/sidebar-preview";
import { stateForBot } from "@/lib/mascot";
import { visibleMessages } from "@/state/snapshot-navigation";
import { recentChangedFiles } from "@/components/ComputerFilesPane";
import { createAppStore } from "@/state/app-store";
import { followHeldTails, noteSnapshotTails } from "@/state/held-tails";
import { HELD_IN_BACKGROUND } from "@/state/message-history";
import { initialState, reducer, type Action, type AppState, type Bot, type Message } from "@/state/store";

type Row = Message & { parentId: string | null };

describe("review: heldTail", () => {
  it("a thread with no active leaf (legacy rows) and no person line in the last 20 rows still gets a short tail", () => {
    const rows: Row[] = Array.from({ length: 300 }, (_, i) => ({ id: `r${i}`, at: i, parentId: null, role: "bot", kind: "text", text: `t${i}` }) as Row);
    const read = (limit: number) => ({ messages: rows.slice(-limit), hasMore: rows.length > limit, activeLeafId: null });
    const tail = heldTail(read, 20, 200);
    expect(tail.messages.length).toBeLessThanOrEqual(20);
  });
});

describe("review: a branch switch from another client on a tailed conversation", () => {
  // Original branch o0..o59 (o10 is a person line). The person edited o10 -> e0 (parent o9), and the bot answered e1..e39.
  const original: Row[] = Array.from({ length: 60 }, (_, i) => ({ id: `o${i}`, at: i, parentId: i ? `o${i - 1}` : null,
    role: i === 10 ? "user" : "bot", kind: "text", text: i === 59 ? "ORIGINAL BRANCH END" : `o${i}` }) as Row);
  const edited: Row[] = Array.from({ length: 40 }, (_, i) => ({ id: `e${i}`, at: 100 + i, parentId: i ? `e${i - 1}` : "o9",
    role: i === 0 ? "user" : "bot", kind: "text", text: i === 39 ? "EDITED BRANCH END" : `e${i}` }) as Row);
  const all = [...original, ...edited];
  const bot = (messages: Row[], hasMore: boolean): Bot => ({ id: "b", name: "Scout", threadId: "t", messages, hasMore, activeLeafId: "e39", tasks: [] }) as unknown as Bot;
  const other = { id: "o", name: "Other", threadId: "ot", messages: [], hasMore: false, tasks: [] } as unknown as Bot;
  const read = (limit: number) => ({ messages: all.slice(-limit), hasMore: all.length > limit, activeLeafId: "e39" });

  it("shows the same sidebar line and mascot as a whole page after the phone switches back to the original branch", () => {
    const tail = heldTail(read, 20, 200);
    const page = read(200);
    const look = (b: Bot) => ({ line: lastLine(b, visibleMessages(b), [], true), mascot: stateForBot({ ...b, messages: visibleMessages(b) }) });
    const after = (b: Bot) => {
      const state: AppState = { ...initialState, bots: [b, other], selectedId: "o", activeView: "chat" };
      return reducer(state, { type: "threadActive", threadId: "t", activeLeafId: "o59" }).bots[0]!;
    };
    expect(tail.messages.length).toBeLessThan(page.messages.length);
    expect(look(after(bot(page.messages, page.hasMore))).line).toBe("ORIGINAL BRANCH END");
    expect(look(after(bot(tail.messages, true))).line).toBe("ORIGINAL BRANCH END");
  });
});

describe("review: the background cap", () => {
  const row = (i: number): Message => ({ id: `w${i}`, at: i, parentId: i ? `w${i - 1}` : null, role: "bot", kind: "text", text: `l${i}` }) as Message;
  const reader = { id: "reader", threadId: "read", name: "Reader", messages: [], hasMore: false, tasks: [] } as unknown as Bot;
  it("still holds when the conversation has a pinned message more than 600 rows back", () => {
    const messages = Array.from({ length: HELD_IN_BACKGROUND }, (_, i) => row(i));
    const worker = { id: "worker", threadId: "work", name: "Worker", messages, hasMore: false, activeLeafId: messages.at(-1)!.id, pinnedMessageId: "w5", tasks: [] } as unknown as Bot;
    let state: AppState = { ...initialState, bots: [worker, reader], selectedId: "reader", activeView: "chat" };
    for (let i = HELD_IN_BACKGROUND; i < HELD_IN_BACKGROUND + 500; i++) state = reducer(state, { type: "messageAdded", threadId: "work", message: row(i) });
    expect(state.bots[0]!.messages.length).toBeLessThanOrEqual(HELD_IN_BACKGROUND);
  });
});

describe("review: a queued frame older than the snapshot's tail", () => {
  it("lands where it belongs, not after the newest row", () => {
    const row = (i: number, kind = "activity"): Message => ({ id: `r${i}`, at: i, parentId: i ? `r${i - 1}` : null, role: i === 0 ? "user" : "bot", kind,
      text: `r${i}`, ...(kind === "activity" ? { tool: { name: `step ${i}`, ok: true, input: "{}" } } : {}) }) as Message;
    // The snapshot sent r11..r30; r5 was queued from the stream while it was read.
    const tail = Array.from({ length: 20 }, (_, k) => row(11 + k));
    const bot = { id: "b", threadId: "t", name: "B", messages: tail, hasMore: true, activeLeafId: "r30", tasks: [] } as unknown as Bot;
    const other = { id: "o", threadId: "ot", name: "O", messages: [], hasMore: false, tasks: [] } as unknown as Bot;
    let state: AppState = { ...initialState, bots: [bot, other], selectedId: "o", activeView: "chat" };
    state = reducer(state, { type: "messageAdded", threadId: "t", message: row(5) });
    const held = state.bots[0]!;
    expect(held.messages.findLast((m) => m.kind === "activity" && m.tool)?.id).toBe("r30");
  });
});

describe("review: the Computer panel's recently changed files on a tailed bot (opened from the Team map, no chat drawn)", () => {
  it("lists the same files as a whole page once the bot is selected and the page before its tail lands", async () => {
    const rows: Row[] = [];
    let parent: string | null = null;
    const push = (r: Partial<Row>) => { const id = `x${rows.length}`; rows.push({ id, at: rows.length, parentId: parent, ...r } as Row); parent = id; };
    for (let turn = 0; turn < 3; turn++) {
      push({ role: "user", kind: "text", text: `do ${turn}` });
      for (let s = 0; s < 12; s++) push({ role: "bot", kind: "activity", tool: { name: "Edit", ok: true, input: "{}" } } as Partial<Row>);
      push({ role: "bot", kind: "text", text: `done ${turn}` });
      push({ role: "bot", kind: "digest", digest: { files: { added: [`file-${turn}.ts`], changed: [], deleted: [] } } } as unknown as Partial<Row>);
    }
    const read = (limit: number) => ({ messages: rows.slice(-limit), hasMore: rows.length > limit, activeLeafId: parent });
    const asBot = (p: { messages: Row[]; activeLeafId: string | null; hasMore: boolean }) => ({ id: "b", threadId: "t", name: "B", messages: p.messages, activeLeafId: p.activeLeafId, hasMore: p.hasMore, tasks: [] }) as unknown as Bot;
    const other = { id: "o", threadId: "ot", name: "O", messages: [], hasMore: false, tasks: [] } as unknown as Bot;
    const tail = asBot(heldTail(read, 20, 200));
    expect(tail.messages.length).toBeLessThan(rows.length);

    const store = createAppStore<AppState, Action, never>(reducer, { ...initialState, bots: [other, tail], selectedId: "o", activeView: "team-map" }, () => () => {});
    const asked: Action[] = [];
    noteSnapshotTails([tail]);
    const stop = followHeldTails(store, (action) => asked.push(action));
    store.dispatch({ type: "toggleComputer", botId: "b", open: true });
    await Promise.resolve();
    expect(asked).toEqual([{ type: "loadOlderMessages", threadId: "t" }]);
    const first = tail.messages[0]!.id;
    const at = rows.findIndex((r) => r.id === first);
    store.dispatch({ type: "olderMessages", threadId: "t", generation: 0, before: first, messages: rows.slice(Math.max(0, at - 200), at), hasMore: at > 200 });
    const held = store.getState().bots.find((b) => b.id === "b")!;
    expect(recentChangedFiles(held)).toEqual(recentChangedFiles(asBot({ ...read(200), activeLeafId: parent })));
    stop();
  });
});

describe("review: a genuinely new row whose server time is behind the tail's first row", () => {
  const rows = Array.from({ length: 20 }, (_, k) => ({ id: `r${k}`, at: 1_000_000 + k, parentId: k ? `r${k - 1}` : "r-1", role: "bot", kind: "text", text: `r${k}` }) as Message);
  const bot = { id: "b", threadId: "t", name: "B", messages: rows, hasMore: true, activeLeafId: "r19", tasks: [] } as unknown as Bot;
  const other = { id: "o", threadId: "ot", name: "O", messages: [], hasMore: false, tasks: [] } as unknown as Bot;
  const land = (message: Partial<Message>) => reducer({ ...initialState, bots: [bot, other], selectedId: "o", activeView: "chat" },
    { type: "messageAdded", threadId: "t", message: { id: "new", at: 999_000, role: "bot", kind: "text", text: "NEW REPLY", ...message } as Message }).bots[0]!;

  it("is kept (server clock stepped back a second)", () => {
    expect(land({ parentId: "r19" }).messages.at(-1)?.id).toBe("new");
  });

  it("is kept when it continues any held row, or names no parent at all", () => {
    expect(land({ parentId: "r7" }).messages.at(-1)?.id).toBe("new");
    expect(land({ parentId: null }).messages.at(-1)?.id).toBe("new");
    expect(land({}).messages.at(-1)?.id).toBe("new");
  });
});
