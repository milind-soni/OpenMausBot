import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import { NO_TEXT_ENGINE, createMemoryUpkeep, type UpkeepBot } from "./memory-upkeep.ts";
import { ensureWorkspace, writeMemoryFile, writeMemoryTopic, WORKSPACES_DIR } from "./workspace.ts";

// Counts every atomic write the upkeep makes, without changing how any of them lands on disk.
const written = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock("./atomic.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./atomic.ts")>();
  return {
    ...actual,
    writeFileAtomic: (path: string, data: string | Uint8Array, options?: { mode?: number; durable?: boolean }) => {
      written.paths.push(path);
      return actual.writeFileAtomic(path, data, options);
    },
  };
});

const BOT_COUNT = 24;
const NOTEBOOK = "- 2026-09-01 · Trip · until 2026-09-02\n";
const TODAY_AT = new Date(2026, 8, 25, 10, 0, 0);
const BOTS: UpkeepBot[] = Array.from({ length: BOT_COUNT }, (_, i) => ({
  id: `counted-${String(i + 1).padStart(2, "0")}`,
  name: `Bot ${i + 1}`,
}));
const writesTo = (name: string) => written.paths.filter((path) => path.endsWith(`/${name}`) || path === name).length;
const state = () => JSON.parse(readFileSync(join(DATA_DIR, "memory-upkeep.json"), "utf8")) as {
  bots: Record<string, { lastTidy?: { at: number; expired: number; topicChecks?: number; contradictionsChecked: boolean }; lastCapture?: { note?: string }; topicCursor?: string }>;
};

function loopWith(engine: (botId: string) => { generateText?: (prompt: string) => Promise<string> } | null = () => null) {
  return createMemoryUpkeep({
    bots: () => BOTS,
    bot: (id) => BOTS.find((bot) => bot.id === id),
    engine,
    busy: () => false,
    addToAboutMe: () => 0,
    sourceLabel: () => "chat",
    quietMs: () => 60_000,
    tidyHour: () => 0,
    now: () => TODAY_AT,
  });
}

describe("upkeep state writes", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    written.paths.length = 0;
    for (const bot of BOTS) {
      ensureWorkspace(bot.id);
      writeMemoryFile(bot.id, NOTEBOOK);
    }
    writeMemoryTopic(BOTS[0]!.id, "project.md", "- 2026-09-20 · Launch is Friday\n- 2026-09-22 · Launch is Monday\n");
    written.paths.length = 0;
  });

  it("writes memory-upkeep.json once for a tick that tidies every bot", async () => {
    const loop = loopWith((botId) => (botId === BOTS[0]!.id ? { generateText: async () => "{}" } : null));
    await loop.tick();
    await loop.idle();

    expect(writesTo("memory-upkeep.json")).toBe(1);
    // Each notebook really changed (one expired note was archived), so each is written exactly once.
    expect(writesTo("MEMORY.md")).toBe(BOT_COUNT);

    // Nothing is lost to the batching: every bot's report is in the one file that was written.
    const saved = state();
    expect(Object.keys(saved.bots).sort()).toEqual(BOTS.map((bot) => bot.id).sort());
    for (const bot of BOTS) {
      expect(saved.bots[bot.id]?.lastTidy).toMatchObject({ at: TODAY_AT.getTime(), expired: 1, contradictionsChecked: bot.id === BOTS[0]!.id });
    }
    // The topic cursor set during the tick survives the coalesced write.
    expect(saved.bots[BOTS[0]!.id]?.topicCursor).toBe("project.md");
    expect(saved.bots[BOTS[0]!.id]?.lastTidy?.topicChecks).toBe(1);
  });

  it("writes nothing at all on a later tick with no work to do", async () => {
    const loop = loopWith();
    await loop.tick();
    await loop.idle();
    written.paths.length = 0;
    await loop.tick();
    await loop.idle();
    expect(written.paths).toEqual([]);
    expect(writesTo("memory-upkeep.json")).toBe(0);
    expect(writesTo("MEMORY.md")).toBe(0);
  });

  it("seeds each bot's notebook once, never once per tick", async () => {
    // A fresh workspace has no MEMORY.md, so the first tick creates one per bot — and only the first.
    for (const bot of BOTS) rmSync(join(WORKSPACES_DIR, bot.id), { recursive: true, force: true });
    const loop = loopWith();
    written.paths.length = 0;
    await loop.tick();
    await loop.idle();
    expect(writesTo("MEMORY.md")).toBe(BOT_COUNT);
    written.paths.length = 0;
    await loop.tick();
    await loop.idle();
    expect(writesTo("MEMORY.md")).toBe(0);
  });

  it("still saves a report made outside a tick right away", async () => {
    const loop = loopWith();
    written.paths.length = 0;
    const report = await loop.capture({ botId: BOTS[1]!.id, threadId: "chat", turns: [{ person: "I like short answers", bot: "Noted" }] });
    expect(report.note).toBe(NO_TEXT_ENGINE);
    expect(writesTo("memory-upkeep.json")).toBe(1);
    expect(state().bots[BOTS[1]!.id]?.lastCapture?.note).toBe(NO_TEXT_ENGINE);
  });
});
