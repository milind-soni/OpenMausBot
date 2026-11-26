import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { BoardItem } from "../../shared/board.ts";
import { BOARD_FILE, readBoardFile, writeBoardFile } from "./store.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const fileIn = () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-board-store-"));
  dirs.push(dir);
  return join(dir, "data", BOARD_FILE);
};

const ITEM: BoardItem = {
  threadId: "t1", groupId: "g1", title: "Write the brief", state: "needs_person", needs: ["t0"], labels: { area: "billing" },
  forBotId: "scout", holder: { botId: "scout", since: 5 }, attempts: 1, question: { text: "Which client?", askedAt: 6, person: "p_mira" },
  createdBy: { kind: "person", id: "p_mira", name: "Mira" }, createdAt: 1, updatedAt: 6,
};

describe("board.json", () => {
  it("round-trips items and keeps repeats it does not know", () => {
    const file = fileIn();
    writeBoardFile(file, { items: [ITEM], repeats: [{ every: "day" }] });
    expect(readBoardFile(file)).toEqual({ items: [ITEM], repeats: [{ every: "day" }] });
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ version: 1 });
  });

  it("is written whole, readable only by its owner, with no temporary file left beside it", () => {
    const file = fileIn();
    writeBoardFile(file, { items: [ITEM], repeats: [] });
    writeBoardFile(file, { items: [], repeats: [] });
    expect(readBoardFile(file).items).toEqual([]);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(file, ".."))).toEqual([BOARD_FILE]);
  });

  it("reads a missing, corrupt or foreign file as an empty board", () => {
    const file = fileIn();
    expect(readBoardFile(file)).toEqual({ items: [], repeats: [] });
    writeBoardFile(file, { items: [], repeats: [] });
    for (const text of ["{not json", "[]", JSON.stringify({ version: 2, items: [ITEM] }), JSON.stringify({ version: 1 })]) {
      writeFileSync(file, text);
      expect(readBoardFile(file), text).toEqual({ items: [], repeats: [] });
    }
  });

  it("leaves out an item that does not parse and keeps the rest, with fields a newer version added", () => {
    const file = fileIn();
    writeBoardFile(file, { items: [ITEM], repeats: [] });
    const newer = { ...ITEM, threadId: "t2", lane: "fast" };
    writeFileSync(file, JSON.stringify({ version: 1, items: [ITEM, { ...ITEM, state: "stuck" }, { threadId: "t3" }, newer], repeats: [] }));
    expect(readBoardFile(file).items).toEqual([ITEM, newer]);
  });
});
