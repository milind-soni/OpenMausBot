import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BOARD_LIMITS } from "../../shared/board.ts";
import { createBoard, type BoardChange, type NewBoardItem } from "./host.ts";
import { BOARD_FILE } from "./store.ts";

const T0 = 1_700_000_000_000;
const MIRA = { kind: "person" as const, id: "p_mira", name: "Mira" };
const PERSON = { kind: "person" as const, person: "p_mira" };
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function harness(dir = mkdtempSync(join(tmpdir(), "omb-board-host-"))) {
  if (!dirs.includes(dir)) dirs.push(dir);
  const h = {
    dir,
    clock: T0,
    rooms: new Map<string, { bots: string[]; threads: Set<string> }>([
      ["g1", { bots: ["scout", "payroll"], threads: new Set(["t1", "t2", "t3", "t4"]) }],
      ["g2", { bots: ["notes"], threads: new Set(["u1"]) }],
    ]),
    changes: [] as BoardChange[],
    opened: 0,
  };
  const board = createBoard({
    dataDir: dir,
    now: () => h.clock,
    alive: (groupId, threadId) => h.rooms.get(groupId)?.threads.has(threadId) ?? false,
    roomBots: (groupId) => h.rooms.get(groupId)?.bots ?? null,
    log: () => {},
  });
  board.onChange((change) => h.changes.push(change));
  const open = (groupId: string) => (title: string) => {
    const threadId = `new${++h.opened}`;
    h.rooms.get(groupId)!.threads.add(threadId);
    expect(title).toBeTruthy();
    return threadId;
  };
  const add = (over: Partial<NewBoardItem> = {}) => board.create({ groupId: "g1", title: "Item", createdBy: MIRA, ...over }, open(over.groupId ?? "g1"));
  return { h, board, add };
}

describe("the board", () => {
  it("makes an item on a new thread, saves it, and tells listeners", () => {
    const { h, add } = harness();
    const item = add({ title: "Write the brief", labels: { area: "billing" }, forBotId: "scout" });
    expect(item).toMatchObject({ threadId: "new1", groupId: "g1", title: "Write the brief", state: "ready", needs: [], labels: { area: "billing" }, forBotId: "scout", attempts: 0, createdBy: MIRA, createdAt: T0 });
    expect(h.changes).toEqual([{ groupId: "g1", threadId: "new1", item }]);
    expect(JSON.parse(readFileSync(join(h.dir, BOARD_FILE), "utf8")).items).toEqual([item]);
    expect(createBoard({ dataDir: h.dir, alive: () => true, roomBots: () => [] }).get("new1")).toEqual(item);
  });

  it("makes an item of a thread the room has, once", () => {
    const { board, add } = harness();
    expect(add({ threadId: "t1" }).threadId).toBe("t1");
    expect(() => add({ threadId: "t1" })).toThrow(expect.objectContaining({ status: 409, code: "board_exists" }));
    expect(() => add({ threadId: "u1" })).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => add({ groupId: "nope" })).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => board.create({ groupId: "g1", title: "x", createdBy: MIRA })).toThrow(expect.objectContaining({ code: "board_bad_input" }));
  });

  it("checks everything before it opens a thread", () => {
    const { h, add } = harness();
    for (const bad of [{ title: "" }, { labels: { Bad: "x" } }, { forBotId: "notes" }, { needs: ["missing"] }]) {
      expect(() => add(bad), JSON.stringify(bad)).toThrow(expect.objectContaining({ status: 400 }));
    }
    expect(h.opened).toBe(0);
  });

  it("refuses the 201st open item in a room but not a settled one's place", () => {
    const { board, add } = harness();
    for (let i = 0; i < BOARD_LIMITS.openPerRoom; i += 1) add();
    expect(() => add()).toThrow(expect.objectContaining({ status: 409, code: "board_full" }));
    expect(add({ groupId: "g2" }).groupId).toBe("g2");
    board.move(board.list({ groupId: "g1" })[0]!.threadId, { move: "cancel" }, PERSON);
    expect(add().state).toBe("ready");
  });

  it("readies a waiting item when its last need is done, and says so", () => {
    const { h, board, add } = harness();
    const a = add({ title: "A" });
    const b = add({ title: "B" });
    const c = add({ title: "C", needs: [a.threadId, b.threadId] });
    expect(c.state).toBe("waiting");
    board.move(a.threadId, { move: "done" }, PERSON);
    expect(board.get(c.threadId)!.state).toBe("waiting");
    h.changes.length = 0;
    h.clock += 10;
    board.move(b.threadId, { move: "done", result: "Done by hand" }, PERSON);
    expect(board.get(c.threadId)).toMatchObject({ state: "ready", updatedAt: T0 + 10 });
    expect(h.changes.map((change) => [change.threadId, change.item?.state])).toEqual([[b.threadId, "done"], [c.threadId, "ready"]]);
  });

  it("a failed or cancelled need leaves its dependent waiting", () => {
    const { board, add } = harness();
    const a = add({ title: "A" });
    const c = add({ title: "C", needs: [a.threadId] });
    board.move(a.threadId, { move: "take", botId: "scout" }, { kind: "dispatcher" });
    board.move(a.threadId, { move: "failed", result: "No access" }, { kind: "bot", botId: "scout" });
    expect(board.get(c.threadId)!.state).toBe("waiting");
    board.move(c.threadId, { move: "cancel" }, PERSON);
    board.move(c.threadId, { move: "reopen" }, PERSON);
    expect(board.get(c.threadId)!.state).toBe("waiting");
  });

  it("changes fields: title, labels, the bot, needs before a bot takes it, a settled item's result", () => {
    const { board, add } = harness();
    const a = add({ title: "A" });
    const b = add({ title: "B" });
    const patched = board.patch(b.threadId, { title: "B2", labels: { area: "ops" }, forBotId: "payroll", needs: [a.threadId] }, PERSON);
    expect(patched).toMatchObject({ title: "B2", labels: { area: "ops" }, forBotId: "payroll", needs: [a.threadId], state: "waiting" });
    expect(board.patch(b.threadId, { forBotId: null, needs: [] }, PERSON)).toMatchObject({ state: "ready", needs: [] });
    expect(board.get(b.threadId)!.forBotId).toBeUndefined();
    expect(() => board.patch(a.threadId, { needs: [b.threadId] }, PERSON)).not.toThrow();
    expect(() => board.patch(b.threadId, { needs: [a.threadId] }, PERSON)).toThrow(expect.objectContaining({ code: "board_cycle" }));
    board.move(b.threadId, { move: "take", botId: "scout" }, { kind: "dispatcher" });
    expect(() => board.patch(b.threadId, { needs: [] }, PERSON)).toThrow(expect.objectContaining({ code: "board_bad_move" }));
    expect(() => board.patch(b.threadId, { result: "x" }, PERSON)).toThrow(expect.objectContaining({ code: "board_bad_move" }));
    board.move(b.threadId, { move: "done" }, PERSON);
    expect(board.patch(b.threadId, { result: "Sent on Friday" }, PERSON).result).toBe("Sent on Friday");
    expect(() => board.move("missing", { move: "cancel" }, PERSON)).toThrow(expect.objectContaining({ status: 404 }));
  });

  it("a refused change saves nothing and says nothing", () => {
    const { h, board, add } = harness();
    const a = add();
    h.changes.length = 0;
    const before = readFileSync(join(h.dir, BOARD_FILE), "utf8");
    expect(() => board.patch(a.threadId, { title: "Fine", labels: { BAD: "x" } }, PERSON)).toThrow();
    expect(() => board.move(a.threadId, { move: "reopen" }, PERSON)).toThrow();
    expect(readFileSync(join(h.dir, BOARD_FILE), "utf8")).toBe(before);
    expect(h.changes).toEqual([]);
  });

  it("removing an item leaves its thread and frees what needed it", () => {
    const { h, board, add } = harness();
    const a = add({ title: "A" });
    const c = add({ title: "C", needs: [a.threadId] });
    h.changes.length = 0;
    expect(board.remove(a.threadId)!.threadId).toBe(a.threadId);
    expect(board.get(c.threadId)).toMatchObject({ needs: [], state: "ready" });
    expect(h.changes.map((change) => [change.threadId, change.item?.state ?? null])).toEqual([[c.threadId, "ready"], [a.threadId, null]]);
    expect(h.rooms.get("g1")!.threads.has(a.threadId)).toBe(true);
    expect(board.remove(a.threadId)).toBeNull();
  });

  it("drops the items of a deleted thread or room when it next reads the board", () => {
    const { h, board, add } = harness();
    const a = add({ title: "A" });
    const c = add({ title: "C", needs: [a.threadId] });
    const other = add({ groupId: "g2", title: "Elsewhere" });
    h.rooms.get("g1")!.threads.delete(a.threadId);
    h.changes.length = 0;
    expect(board.list().map((item) => item.threadId)).toEqual([c.threadId, other.threadId]);
    expect(board.get(c.threadId)).toMatchObject({ state: "ready", needs: [] });
    expect(h.changes).toContainEqual({ groupId: "g1", threadId: a.threadId, item: null });
    h.rooms.delete("g2");
    expect(board.list().map((item) => item.threadId)).toEqual([c.threadId]);
    expect(JSON.parse(readFileSync(join(h.dir, BOARD_FILE), "utf8")).items.map((item: { threadId: string }) => item.threadId)).toEqual([c.threadId]);
  });

  it("lists oldest first, by room and state", () => {
    const { h, board, add } = harness();
    const a = add({ title: "A" });
    h.clock += 1;
    const b = add({ title: "B", groupId: "g2" });
    h.clock += 1;
    const c = add({ title: "C", needs: [a.threadId] });
    expect(board.list().map((item) => item.title)).toEqual(["A", "B", "C"]);
    expect(board.list({ groupId: "g1" }).map((item) => item.threadId)).toEqual([a.threadId, c.threadId]);
    expect(board.list({ state: "waiting" }).map((item) => item.threadId)).toEqual([c.threadId]);
    expect(b.groupId).toBe("g2");
  });

  it("starts empty from a corrupt file and writes a good one on the next change", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-board-host-"));
    writeFileSync(join(dir, BOARD_FILE), "{oops");
    const { board, add } = harness(dir);
    expect(board.list()).toEqual([]);
    add();
    expect(JSON.parse(readFileSync(join(dir, BOARD_FILE), "utf8")).items).toHaveLength(1);
  });

  it("hands out copies: changing one changes nothing on the board", () => {
    const { board, add } = harness();
    const a = add({ labels: { area: "ops" } });
    a.labels.area = "changed";
    board.get(a.threadId)!.needs.push("x");
    expect(board.get(a.threadId)).toMatchObject({ labels: { area: "ops" }, needs: [] });
  });
});
