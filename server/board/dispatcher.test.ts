import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { BoardItem } from "../../shared/board.ts";
import { BOARD_LEASE_MS, BOARD_MODEL_SKIP_MS, BOARD_QUIET_MS, createBoardDispatcher, type BoardBrief } from "./dispatcher.ts";
import { createBoard } from "./host.ts";

const T0 = 1_700_000_000_000;
const MIRA = { kind: "person" as const, id: "p_mira", name: "Mira" };
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** A board in a temp folder, two rooms, and fake bots whose turns run until `end` is called. */
function harness(options: { bots?: string[]; on?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omb-board-dispatch-"));
  dirs.push(dir);
  const h = {
    clock: T0,
    on: options.on ?? true,
    rooms: new Map<string, { bots: string[]; threads: Set<string> }>([["g1", { bots: options.bots ?? ["scout"], threads: new Set() }]]),
    /** Threads with a turn running now, by bot. */
    running: new Map<string, string>(),
    started: [] as Array<{ threadId: string; botId: string; text: string }>,
    cap: null as { resetsAt: number } | null,
    noModel: new Set<string>(),
    refuse: false,
    opened: 0,
  };
  const board = createBoard({
    dataDir: dir, now: () => h.clock, log: () => {},
    alive: (groupId, threadId) => h.rooms.get(groupId)?.threads.has(threadId) ?? false,
    roomBots: (groupId) => h.rooms.get(groupId)?.bots ?? null,
  });
  const dispatcher = createBoardDispatcher({
    board, on: () => h.on, now: () => h.clock, log: () => {},
    roomBots: (groupId) => h.rooms.get(groupId)?.bots ?? null,
    botFree: (botId) => ![...h.running.values()].includes(botId),
    threadWorking: (_groupId, threadId) => h.running.has(threadId),
    capped: () => h.cap,
    modelReady: (botId) => !h.noModel.has(botId),
    brief: (brief: BoardBrief) => brief.kind === "take" ? `@${brief.botId} take ${brief.item.title}` : `@${brief.botId} wake ${brief.item.title}: ${brief.note}`,
    start: (item, botId, text) => {
      if (h.refuse) throw Object.assign(new Error("finish room setup first"), { status: 409 });
      h.running.set(item.threadId, botId);
      h.started.push({ threadId: item.threadId, botId, text });
    },
    stoppedResult: () => "Stopped after 3 tries",
  });
  const add = (title: string, over: { needs?: string[]; forBotId?: string } = {}): BoardItem => {
    h.clock += 1;
    return board.create({ groupId: "g1", title, createdBy: MIRA, ...over }, () => {
      const threadId = `t${++h.opened}`;
      h.rooms.get("g1")!.threads.add(threadId);
      return threadId;
    });
  };
  /** The bot's turn in `threadId` is over. */
  const end = (threadId: string) => { h.running.delete(threadId); };
  const after = (ms: number) => { h.clock += ms; };
  const pastQuiet = () => { h.clock = T0 + BOARD_QUIET_MS + 1; };
  const state = (threadId: string) => board.get(threadId)!;
  return { h, board, dispatcher, add, end, after, pastQuiet, state };
}

describe("board dispatcher", () => {
  it("starts nothing in the first two minutes after the server starts, then the oldest ready item", async () => {
    const { h, dispatcher, add, after, state } = harness();
    const first = add("Draft the post");
    await dispatcher.tick();
    after(BOARD_QUIET_MS - 10);
    await dispatcher.tick();
    expect(h.started).toEqual([]);
    expect(state(first.threadId).state).toBe("ready");
    after(20);
    await dispatcher.tick();
    expect(h.started).toEqual([{ threadId: first.threadId, botId: "scout", text: "@scout take Draft the post" }]);
    expect(state(first.threadId)).toMatchObject({ state: "working", holder: { botId: "scout" }, attempts: 1 });
  });

  it("gives one bot one item at a time, and two bots two at once", async () => {
    const one = harness();
    const a = one.add("A");
    const b = one.add("B");
    one.pastQuiet();
    await one.dispatcher.tick();
    await one.dispatcher.tick();
    expect(one.h.started.map((start) => start.threadId)).toEqual([a.threadId]);
    expect(one.state(b.threadId).state).toBe("ready");
    one.board.move(a.threadId, { move: "done", result: "ok" }, { kind: "bot", botId: "scout" });
    one.end(a.threadId);
    await one.dispatcher.tick();
    expect(one.h.started.map((start) => start.threadId)).toEqual([a.threadId, b.threadId]);

    const two = harness({ bots: ["scout", "payroll"] });
    const c = two.add("C");
    const d = two.add("D");
    two.pastQuiet();
    await two.dispatcher.tick();
    expect(two.h.started.map((start) => [start.threadId, start.botId])).toEqual([[c.threadId, "scout"], [d.threadId, "payroll"]]);
  });

  it("gives an item for one bot only to that bot, even when another is free", async () => {
    const { h, dispatcher, add, pastQuiet, end, state, board } = harness({ bots: ["scout", "payroll"] });
    const busy = add("Busy work", { forBotId: "payroll" });
    const mine = add("Payroll only", { forBotId: "payroll" });
    pastQuiet();
    await dispatcher.tick();
    expect(h.started.map((start) => [start.threadId, start.botId])).toEqual([[busy.threadId, "payroll"]]);
    expect(state(mine.threadId).state).toBe("ready");
    board.move(busy.threadId, { move: "done" }, { kind: "bot", botId: "payroll" });
    end(busy.threadId);
    await dispatcher.tick();
    expect(h.started.at(-1)).toMatchObject({ threadId: mine.threadId, botId: "payroll" });
  });

  it("pauses everything at a spend cap until it lifts, counting no attempt", async () => {
    const { h, dispatcher, add, pastQuiet, after, state } = harness();
    const item = add("Report");
    pastQuiet();
    h.cap = { resetsAt: h.clock + 3_600_000 };
    await dispatcher.tick();
    expect(h.started).toEqual([]);
    expect(state(item.threadId)).toMatchObject({ state: "ready", attempts: 0 });
    expect(dispatcher.nextDueAt()).toBe(h.cap.resetsAt);
    h.cap = null;
    after(60_000);
    await dispatcher.tick();
    expect(h.started, "still paused until the cap's reset time").toEqual([]);
    after(3_600_000);
    await dispatcher.tick();
    expect(state(item.threadId)).toMatchObject({ state: "working", attempts: 1 });
  });

  it("passes over a bot with no model for ten minutes", async () => {
    const { h, dispatcher, add, pastQuiet, after, state } = harness({ bots: ["scout", "payroll"] });
    const item = add("Report");
    pastQuiet();
    h.noModel.add("scout");
    await dispatcher.tick();
    expect(h.started).toEqual([{ threadId: item.threadId, botId: "payroll", text: "@payroll take Report" }]);
    const other = add("Other", { forBotId: "scout" });
    h.noModel.delete("scout");
    await dispatcher.tick();
    expect(state(other.threadId).state, "scout is still passed over").toBe("ready");
    after(BOARD_MODEL_SKIP_MS);
    await dispatcher.tick();
    expect(state(other.threadId)).toMatchObject({ state: "working", holder: { botId: "scout" } });
  });

  it("hands an item back when its turn ends without settling it, and fails it the third time", async () => {
    const { h, dispatcher, add, pastQuiet, after, end, state } = harness();
    const item = add("Flaky");
    pastQuiet();
    for (let attempt = 1; attempt <= 3; attempt++) {
      await dispatcher.tick();
      expect(state(item.threadId)).toMatchObject({ state: "working", attempts: attempt });
      end(item.threadId);
      after(BOARD_LEASE_MS - 1);
      await dispatcher.tick();
      expect(state(item.threadId).state, "still within the lease").toBe("working");
      after(2);
      await dispatcher.tick();
      if (attempt < 3) expect(state(item.threadId)).toMatchObject({ state: attempt < 3 ? "working" : "failed", attempts: attempt + 1 });
    }
    expect(state(item.threadId)).toMatchObject({ state: "failed", result: "Stopped after 3 tries", attempts: 3 });
    expect(h.started).toHaveLength(3);
  });

  it("never starts an item twice while its turn runs, and does not reconcile during the quiet minutes", async () => {
    const { h, dispatcher, board, add, after, state } = harness();
    const item = add("Long");
    board.move(item.threadId, { move: "take", botId: "scout" }, { kind: "dispatcher" });
    after(BOARD_LEASE_MS * 3);
    await dispatcher.tick();
    expect(state(item.threadId).state, "the runtime's own rerun owns the first minutes").toBe("working");
    h.running.set(item.threadId, "scout");
    after(BOARD_QUIET_MS);
    await dispatcher.tick();
    await dispatcher.tick();
    expect(h.started).toEqual([]);
    expect(state(item.threadId)).toMatchObject({ state: "working", attempts: 1 });
  });

  it("looks at nothing while the switch is off", async () => {
    const { h, dispatcher, add, pastQuiet } = harness({ on: false });
    add("Hidden");
    pastQuiet();
    await dispatcher.tick();
    expect(h.started).toEqual([]);
    expect(dispatcher.nextDueAt()).toBeNull();
  });

  it("stays stopped while maintenance or a move holds it, and runs again on start", async () => {
    const { h, dispatcher, add, pastQuiet } = harness();
    add("Held");
    pastQuiet();
    dispatcher.start();
    dispatcher.stop();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.started).toHaveLength(1);
    const later = add("After the stop");
    dispatcher.poke();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.started.map((start) => start.threadId)).not.toContain(later.threadId);
  });

  it("dispatches a dependent item once what it needs is done", async () => {
    const { h, dispatcher, board, add, pastQuiet, end, state } = harness();
    const first = add("Write");
    const second = add("Review", { needs: [first.threadId] });
    expect(second.state).toBe("waiting");
    pastQuiet();
    await dispatcher.tick();
    board.move(first.threadId, { move: "done", result: "draft.md" }, { kind: "bot", botId: "scout" });
    end(first.threadId);
    expect(state(second.threadId).state).toBe("ready");
    await dispatcher.tick();
    expect(h.started.map((start) => start.threadId)).toEqual([first.threadId, second.threadId]);
  });

  it("hands back an item whose start the server refused, and waits before trying it again", async () => {
    const { h, dispatcher, add, pastQuiet, after, state } = harness();
    const item = add("Refused");
    pastQuiet();
    h.refuse = true;
    await dispatcher.tick();
    expect(state(item.threadId)).toMatchObject({ state: "ready", attempts: 1 });
    h.refuse = false;
    await dispatcher.tick();
    expect(h.started).toEqual([]);
    after(60_000);
    await dispatcher.tick();
    expect(state(item.threadId)).toMatchObject({ state: "working", attempts: 2 });
  });

  it("frees the bot while its item waits on a person, and takes the item back to work when the person answers", async () => {
    const { h, dispatcher, board, add, pastQuiet, end } = harness();
    const asked = add("Needs a client");
    const other = add("Other");
    pastQuiet();
    await dispatcher.tick();
    board.move(asked.threadId, { move: "ask", question: "Which client?" }, { kind: "bot", botId: "scout" });
    end(asked.threadId);
    await dispatcher.tick();
    expect(h.started.map((start) => start.threadId)).toEqual([asked.threadId, other.threadId]);
    expect(dispatcher.personReplied(asked.threadId)).toMatchObject({ state: "working", holder: { botId: "scout" }, attempts: 1 });
    expect(dispatcher.personReplied(asked.threadId), "only once").toBeNull();
  });

  it("brings an inbox answer back to the bot that asked once it is free, counting no attempt", async () => {
    const { h, dispatcher, board, add, pastQuiet, end, state } = harness();
    const asked = add("Needs a client");
    const other = add("Other");
    pastQuiet();
    await dispatcher.tick();
    board.move(asked.threadId, { move: "ask", question: "Which client?" }, { kind: "bot", botId: "scout" });
    end(asked.threadId);
    await dispatcher.tick();
    dispatcher.answered(asked.threadId, "Mira replied: Globex");
    await dispatcher.tick();
    expect(h.started).toHaveLength(2);
    board.move(other.threadId, { move: "done" }, { kind: "bot", botId: "scout" });
    end(other.threadId);
    await dispatcher.tick();
    expect(h.started.at(-1)).toEqual({ threadId: asked.threadId, botId: "scout", text: "@scout wake Needs a client: Mira replied: Globex" });
    expect(state(asked.threadId)).toMatchObject({ state: "working", attempts: 1 });
    expect(state(asked.threadId).later).toBeUndefined();
  });

  it("wakes an item set aside at its time, to the same bot, which may work on others meanwhile", async () => {
    const { h, dispatcher, board, add, pastQuiet, after, end, state } = harness();
    const ci = add("Ship");
    const other = add("Other");
    pastQuiet();
    await dispatcher.tick();
    board.move(ci.threadId, { move: "later", at: h.clock + 5 * 60_000, note: "Check CI" }, { kind: "bot", botId: "scout" });
    end(ci.threadId);
    after(BOARD_LEASE_MS * 2);
    await dispatcher.tick();
    expect(state(ci.threadId)).toMatchObject({ state: "working", later: { note: "Check CI" } });
    expect(h.started.map((start) => start.threadId)).toEqual([ci.threadId, other.threadId]);
    expect(dispatcher.nextDueAt()).toBe(state(ci.threadId).later!.at);
    after(5 * 60_000);
    await dispatcher.tick();
    expect(h.started, "scout is still on the other item").toHaveLength(2);
    board.move(other.threadId, { move: "done" }, { kind: "bot", botId: "scout" });
    end(other.threadId);
    await dispatcher.tick();
    expect(h.started.at(-1)).toEqual({ threadId: ci.threadId, botId: "scout", text: "@scout wake Ship: Check CI" });
    expect(state(ci.threadId)).toMatchObject({ state: "working", attempts: 1, laterCount: 1 });
  });

  it("hands back an item set aside whose bot left the room", async () => {
    const { h, dispatcher, board, add, pastQuiet, after, end, state } = harness({ bots: ["scout", "payroll"] });
    const ci = add("Ship", { forBotId: "scout" });
    pastQuiet();
    await dispatcher.tick();
    board.move(ci.threadId, { move: "later", at: h.clock + 60_000, note: "Check CI" }, { kind: "bot", botId: "scout" });
    end(ci.threadId);
    h.rooms.get("g1")!.bots = ["payroll"];
    after(60_000);
    await dispatcher.tick();
    expect(state(ci.threadId)).toMatchObject({ state: "ready", attempts: 1 });
    expect(state(ci.threadId).later).toBeUndefined();
  });
});
