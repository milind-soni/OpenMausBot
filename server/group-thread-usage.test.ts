import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GroupUsageReader } from "./group-thread-usage.ts";

vi.mock("node:fs", { spy: true });
let dir: string;
const load = (path: string) => { const reader = new GroupUsageReader(path); reader.refresh(); return reader; };
const row = (at: string, patch = {}) => ({ at, threadId: "room", botId: "one", botName: "One", input: 100, output: 10, cachedInput: 80, costUsd: 0.01, ...patch });
const write = (month: string, rows: unknown[]) => writeFileSync(join(dir, "usage", `${month}.jsonl`), rows.map(item => JSON.stringify(item)).join("\n") + "\n");
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "omb-group-usage-")); mkdirSync(join(dir, "usage")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("group thread accounting", () => {
  it("does no disk work during lookups and rereads only changed months", () => {
    write("2026-08", [row("2026-08-02", { input: 75 })]);
    write("2026-09", [row("2026-09-02", { input: 90 })]);
    const reader = load(dir);
    vi.mocked(readFileSync).mockClear(); vi.mocked(readdirSync).mockClear(); vi.mocked(statSync).mockClear();
    for (let i = 0; i < 100; i++) expect(reader.forThread("room")?.input).toBe(165);
    expect(readFileSync).not.toHaveBeenCalled(); expect(readdirSync).not.toHaveBeenCalled(); expect(statSync).not.toHaveBeenCalled();
    appendFileSync(join(dir, "usage", "2026-09.jsonl"), JSON.stringify(row("2026-09-03")) + "\n");
    reader.refresh();
    expect(readFileSync).toHaveBeenCalledExactlyOnceWith(join(dir, "usage", "2026-09.jsonl"), "utf8");
    expect(reader.forThread("room")).toMatchObject({ input: 265, turns: 3, lastTurn: { input: 100 } });
  });

  it("combines months and speakers while isolating unrelated threads", () => {
    write("2026-08", [row("2026-08-02"), row("2026-08-01"), row("2026-08-03", { threadId: "private" })]);
    write("2026-09", [row("2026-09-01", { botId: "two", botName: "Two", input: 200, cachedInput: 150 })]);
    const reader = load(dir);
    expect(reader.forThread("room")).toMatchObject({ input: 400, output: 30, cachedInput: 310, costUsd: 0.03, turns: 3, lastSpeaker: { botId: "two", name: "Two" }, lastTurn: { input: 200, output: 10, cachedInput: 150 } });
    expect(reader.forThread("empty")).toBeUndefined();
    expect(load(dir).forThread("room")).toEqual(reader.forThread("room"));
  });

  it("refreshes after appends and truncation and ignores damaged rows", () => {
    write("2026-09", [row("2026-09-01"), null, row("bad"), row("2026-09-02", { input: -1 })]);
    const reader = load(dir);
    const file = join(dir, "usage", "2026-09.jsonl");
    appendFileSync(file, "{unfinished\n");
    expect(reader.forThread("room")?.turns).toBe(1);
    appendFileSync(file, JSON.stringify(row("2026-09-03", { input: 10, cachedInput: 500 })) + "\n");
    reader.refresh();
    expect(reader.forThread("room")).toMatchObject({ input: 110, cachedInput: 90, turns: 2 });
    write("2026-09", [row("2026-09-04")]);
    reader.refresh();
    expect(reader.forThread("room")?.turns).toBe(1);
    rmSync(file);
    reader.refresh();
    expect(reader.forThread("room")).toBeUndefined();
  });

  it("never treats omitted cache information as zero", () => {
    write("2026-09", [row("2026-09-01"), row("2026-09-02", { cachedInput: undefined, costUsd: null }), row("2026-09-03")]);
    const usage = load(dir).forThread("room")!;
    expect(usage.cachedInput).toBeUndefined();
    expect(usage.lastTurn?.cachedInput).toBe(80);
    expect(usage.costUsd).toBe(0.02);
    expect(usage.input).toBe(300);
  });

  it("returns independent snapshots and handles absent ledgers", () => {
    write("2026-09", [row("2026-09-01")]);
    const reader = load(dir);
    reader.forThread("room")!.lastSpeaker!.name = "Changed";
    expect(reader.forThread("room")!.lastSpeaker!.name).toBe("One");
    expect(load(join(dir, "absent")).forThread("room")).toBeUndefined();
  });
});
