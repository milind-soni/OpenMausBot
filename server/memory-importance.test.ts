// Importance on the memory entry grammar (Phase 1 part 2, decision 19):
// an entry may say how much it matters; under budget nothing changes; over
// budget the cut lands on the least important, oldest lines, never on the
// ones marked 5.
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { closeMessageDb } from "./message-db.ts";
import { memoryCapacity } from "./memory-store.ts";
import { ensureWorkspace, entryImportance, loadMemory, memoryEntry, MEMORY_MAX_LINES, WORKSPACES_DIR } from "./workspace.ts";

const BOT = "importance-bot";

describe("importance on the entry grammar", () => {
  it("renders an importance segment only when one was given", () => {
    const now = new Date(2026, 8, 15);
    expect(memoryEntry("prefers pnpm", { now, source: 'chat "Setup"', importance: 5 })).toBe('- 2026-09-15 · from chat "Setup" · importance 5 · prefers pnpm');
    expect(memoryEntry("prefers pnpm", { now, importance: 1 })).toBe("- 2026-09-15 · importance 1 · prefers pnpm");
    expect(memoryEntry("prefers pnpm", { now, source: 'chat "Setup"' })).toBe('- 2026-09-15 · from chat "Setup" · prefers pnpm');
    // 3 is the default and is not written, so the file stays as it was
    expect(memoryEntry("prefers pnpm", { now, importance: 3 })).toBe("- 2026-09-15 · prefers pnpm");
  });

  it("reads importance back from a line, and a line without one as 3", () => {
    expect(entryImportance('- 2026-09-15 · from chat "Setup" · importance 5 · prefers pnpm')).toBe(5);
    expect(entryImportance("- 2026-09-15 · importance 1 · prefers pnpm")).toBe(1);
    expect(entryImportance('- 2026-09-15 · from chat "Setup" · prefers pnpm')).toBe(3);
    expect(entryImportance("- a hand-written line")).toBe(3);
    // a typed "importance 9" is not a segment; it reads as text
    expect(entryImportance("- 2026-09-15 · importance 9 · nine")).toBe(3);
  });
});

describe("loadMemory with importance", () => {
  beforeEach(() => {
    closeMessageDb();
    rmSync(join(WORKSPACES_DIR, BOT), { recursive: true, force: true });
  });

  it("returns the file byte for byte while it is under budget", () => {
    const dir = ensureWorkspace(BOT);
    const text = "# Memory\n- 2026-09-01 · importance 1 · low\n- 2026-09-02 · importance 5 · high\n- plain\n";
    writeFileSync(join(dir, "MEMORY.md"), text);
    const memory = loadMemory(BOT);
    expect(memory?.text).toBe(text);
    expect(memory?.truncated).toBe(false);
  });

  it("over budget, keeps every importance-5 line and the headings, drops the least important first, in file order", () => {
    const dir = ensureWorkspace(BOT);
    const lines = ["# Memory", "## Facts"];
    for (let i = 0; i < MEMORY_MAX_LINES + 40; i += 1) lines.push(`- 2026-09-${String((i % 28) + 1).padStart(2, "0")} · importance ${i % 20 === 0 ? 1 : 3} · fact ${i}`);
    for (let i = 0; i < 10; i += 1) lines.push(`- 2026-09-15 · importance 5 · vital ${i}`);
    writeFileSync(join(dir, "MEMORY.md"), lines.join("\n") + "\n");
    const memory = loadMemory(BOT)!;
    expect(memory.truncated).toBe(true);
    const kept = memory.text.split("\n").filter(Boolean);
    expect(kept.length).toBeLessThanOrEqual(MEMORY_MAX_LINES);
    expect(kept[0]).toBe("# Memory");
    expect(kept[1]).toBe("## Facts");
    for (let i = 0; i < 10; i += 1) expect(memory.text).toContain(`vital ${i}`);
    // the importance-1 lines are the first to go
    expect(memory.text).not.toContain("importance 1 · fact 0\n");
    expect(memory.text).not.toContain("importance 1 · fact 200\n");
    // file order is preserved: the vital lines still come last
    expect(kept.at(-1)).toContain("vital 9");
    expect(memory.dropped).toBe(lines.length - 2 - (kept.length - 2));
  });

  it("agrees with the capacity gauge on what loads", () => {
    const dir = ensureWorkspace(BOT);
    const lines = ["# Memory"];
    for (let i = 0; i < MEMORY_MAX_LINES + 30; i += 1) lines.push(`- 2026-09-01 · importance ${i < 30 ? 1 : 3} · fact ${i}`);
    const raw = lines.join("\n") + "\n";
    writeFileSync(join(dir, "MEMORY.md"), raw);
    const memory = loadMemory(BOT)!;
    const capacity = memoryCapacity(raw);
    expect(capacity.truncated).toBe(true);
    expect(capacity.loadedLines).toBe(memory.text.split("\n").filter(Boolean).length);
    expect(capacity.loadedBytes).toBe(Buffer.byteLength(memory.text, "utf8"));
  });
});
