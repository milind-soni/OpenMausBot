// The sheet store: ids that never repeat, update in place, pruning that
// drops result tables, a restart that fails a running card, a corrupt file
// that starts empty, and one broadcast per change.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { DataBroadcast } from "../../shared/data-surface.ts";
import { DataSheetRegistry, DataSheetStore, SHEET_FILE } from "./sheet.ts";

const dirs: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "omb-sheet-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function store(dir: string, extra: Partial<ConstructorParameters<typeof DataSheetStore>[0]> = {}) {
  const frames: DataBroadcast[] = [];
  const dropped: string[] = [];
  const sheet = new DataSheetStore({
    botId: "bot-1", dir,
    broadcast: (frame) => frames.push(frame),
    dropResult: async (name) => { dropped.push(name); },
    ...extra,
  });
  return { sheet, frames, dropped };
}

describe("DataSheetStore", () => {
  it("persists and broadcasts derived-table discovery without repeating unchanged catalogs", () => {
    const dir = freshDir();
    const { sheet, frames } = store(dir);
    const tables = [{ name: "derived", rowCount: 3, columns: [{ name: "total", type: "DOUBLE" }] }];
    sheet.recordTables(tables);
    sheet.recordTables(tables);
    expect(frames).toHaveLength(1);
    expect(frames[0].sheet.tables).toEqual(tables);
    expect(store(dir).sheet.sheet().tables).toEqual(tables);
  });
  it("appends cards with increasing ids, updates in place and never reuses an id", async () => {
    const dir = freshDir();
    const { sheet, frames } = store(dir);
    const first = await sheet.addCard({ kind: "table", title: "Orders", sql: "SELECT 1", by: "bot" });
    const second = await sheet.addCard({ kind: "chart", title: "Revenue", sql: "SELECT 2", by: "bot", status: "ready" });
    expect([first.id, second.id]).toEqual(["c_1", "c_2"]);
    expect(first.status).toBe("running");
    expect(second.status).toBe("ready");

    const updated = sheet.updateCard("c_1", { title: "Orders (paid)", status: "ready", rowCount: 10, result: "c_1" });
    expect(updated).toMatchObject({ id: "c_1", title: "Orders (paid)", status: "ready", rowCount: 10, createdAt: first.createdAt });
    expect(sheet.cards().map((card) => card.id)).toEqual(["c_1", "c_2"]);
    expect(sheet.updateCard("c_9", { title: "x" })).toBeUndefined();

    await sheet.removeCard("c_2");
    const third = await sheet.addCard({ kind: "table", title: "Again", by: "person" });
    expect(third.id).toBe("c_3");
    expect(sheet.nextResultName()).toBe("q_4");
    // Every change reached the clients with the whole sheet and no counter.
    expect(frames.length).toBe(5);
    expect(frames.at(-1)).toMatchObject({ kind: "data", botId: "bot-1" });
    expect((frames.at(-1)!.sheet as unknown as Record<string, unknown>).seq).toBeUndefined();
    expect(frames.at(-1)!.sheet.cards.map((card) => card.id)).toEqual(["c_1", "c_3"]);
  });

  it("persists across stores, keeps the counter, and fails a card left running by a restart", async () => {
    const dir = freshDir();
    const { sheet } = store(dir);
    await sheet.addCard({ kind: "table", title: "Running", sql: "SELECT 1", by: "bot" });
    await sheet.addCard({ kind: "table", title: "Done", sql: "SELECT 2", by: "bot", status: "ready" });
    await sheet.removeCard("c_2");
    const written = JSON.parse(readFileSync(join(dir, SHEET_FILE), "utf8"));
    expect(written.seq).toBe(2);

    const reopened = store(dir).sheet;
    const cards = reopened.cards();
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ id: "c_1", status: "failed", error: { code: "cancelled" } });
    const next = await reopened.addCard({ kind: "text", title: "Note", text: "hi", by: "person", status: "ready" });
    expect(next.id).toBe("c_3");
  });

  it("prunes the oldest unpinned card first and drops its result table", async () => {
    const dir = freshDir();
    const { sheet, dropped } = store(dir, { cardsMax: 3 });
    await sheet.addCard({ kind: "table", title: "a", by: "bot", status: "ready", result: "c_1", pinned: true });
    await sheet.addCard({ kind: "table", title: "b", by: "bot", status: "ready", result: "c_2" });
    await sheet.addCard({ kind: "table", title: "c", by: "bot", status: "ready", result: "c_3" });
    await sheet.addCard({ kind: "table", title: "d", by: "bot", status: "ready", result: "c_4" });
    expect(sheet.cards().map((card) => card.id)).toEqual(["c_1", "c_3", "c_4"]);
    expect(dropped).toEqual(["c_2"]);
    // Everything pinned: the oldest pinned card goes rather than growing past the cap.
    sheet.updateCard("c_3", { pinned: true });
    sheet.updateCard("c_4", { pinned: true });
    await sheet.addCard({ kind: "table", title: "e", by: "bot", status: "ready", result: "c_5" });
    expect(sheet.cards().map((card) => card.id)).toEqual(["c_3", "c_4", "c_5"]);
    expect(dropped).toEqual(["c_2", "c_1"]);
  });

  it("starts empty from an unreadable or foreign file instead of failing the turn", () => {
    const dir = freshDir();
    writeFileSync(join(dir, SHEET_FILE), "{not json");
    expect(store(dir).sheet.sheet()).toMatchObject({ version: 1, botId: "bot-1", cards: [], sources: [] });
    writeFileSync(join(dir, SHEET_FILE), JSON.stringify({ version: 2, cards: "nope" }));
    expect(store(dir).sheet.cards()).toEqual([]);
  });

  it("records sources by name, replacing an earlier load of the same table", () => {
    const dir = freshDir();
    const { sheet } = store(dir);
    const base = { kind: "csv" as const, source: "/tmp/orders.csv", rowCount: 3, columns: [], loadedAt: "2026-10-09T00:00:00.000Z" };
    sheet.recordSource({ name: "orders", ...base });
    sheet.recordSource({ name: "orders", ...base, rowCount: 5 });
    sheet.recordSource({ name: "people", ...base });
    expect(sheet.sheet().sources.map((source) => [source.name, source.rowCount])).toEqual([["orders", 5], ["people", 3]]);
    sheet.removeSource("orders");
    expect(sheet.sheet().sources.map((source) => source.name)).toEqual(["people"]);
  });

  it("hands out one store per bot through the registry", async () => {
    const dir = freshDir();
    const dropped: string[] = [];
    const registry = new DataSheetRegistry({ broadcast: () => {}, dropResult: async (botId, name) => { dropped.push(`${botId}:${name}`); }, dir: (botId) => join(dir, botId) });
    expect(registry.for("b1")).toBe(registry.for("b1"));
    expect(registry.for("b1")).not.toBe(registry.for("b2"));
    await registry.for("b1").addCard({ kind: "table", title: "t", by: "bot", status: "ready", result: "c_1" });
    await registry.for("b1").removeCard("c_1");
    expect(dropped).toEqual(["b1:c_1"]);
    registry.forget("b1");
    expect(registry.for("b1").cards()).toEqual([]);
    // deleting a bot removes its sheet file as well as the store
    await registry.for("b2").addCard({ kind: "text", title: "note", text: "x", by: "person", status: "ready" });
    expect(existsSync(join(dir, "b2", SHEET_FILE))).toBe(true);
    registry.delete("b2");
    expect(existsSync(join(dir, "b2", SHEET_FILE))).toBe(false);
    expect(registry.for("b2").cards()).toEqual([]);
  });
});
