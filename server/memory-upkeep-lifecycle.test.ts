import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import { DREAM_MARKER } from "./memory-dream.ts";
import { ORGANIZE_MARKER } from "./memory-organize.ts";
import { TIDY_MARKER } from "./memory-tidy.ts";
import { createMemoryUpkeep, TIDY_CHECK_MS, type MemoryUpkeep } from "./memory-upkeep.ts";
import { createMoveFreeze } from "./move-freeze.ts";
import { ensureWorkspace, readMemoryTopic, workspaceDir, writeMemoryFile, writeMemoryTopic } from "./workspace.ts";

const BOT = { id: "upkeep-lifecycle", name: "Scout" };
const NOTEBOOK = "- 2026-09-01 · Trip · until 2026-09-02\n";
const memory = () => readFileSync(join(workspaceDir(BOT.id), "MEMORY.md"), "utf8");

describe("scheduled memory upkeep", () => {
  let loop: MemoryUpkeep;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 25, 10));
    rmSync(DATA_DIR, { recursive: true, force: true });
    ensureWorkspace(BOT.id);
    writeMemoryFile(BOT.id, NOTEBOOK);
    loop = createMemoryUpkeep({
      bots: () => [BOT], bot: () => BOT, engine: () => null, busy: () => false,
      addToAboutMe: () => 0, sourceLabel: () => "chat", quietMs: () => 60_000, tidyHour: () => 3,
    });
  });

  afterEach(async () => {
    loop.stop();
    await loop.idle();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("keeps a moved desktop's memory unchanged when frozen before the first tick", async () => {
    const freeze = createMoveFreeze({ dataDir: DATA_DIR });
    freeze.hold(() => loop.start(), () => loop.stop());
    freeze.freeze("https://fixture.example");
    await vi.advanceTimersByTimeAsync(TIDY_CHECK_MS);
    expect(memory()).toBe(NOTEBOOK);
    expect(readMemoryTopic(BOT.id, "archive.md")).toBeNull();
    expect(loop.status(BOT.id).lastTidy).toBeUndefined();
    freeze.unfreeze();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(memory()).not.toContain("Trip");
    expect(loop.status(BOT.id).lastTidy?.expired).toBe(1);
  });

  it("waits a full startup delay again after restarting", async () => {
    loop.start();
    await vi.advanceTimersByTimeAsync(30_000);
    loop.stop();
    loop.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(memory()).toBe(NOTEBOOK);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(memory()).not.toContain("Trip");
  });

  it.each(["startup", "interval"] as const)("ignores an already queued %s callback from a stopped generation", async (kind) => {
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const interval = vi.spyOn(globalThis, "setInterval");
    loop.start();
    const callback = (kind === "startup" ? timeout.mock.calls[0]![0] : interval.mock.calls[0]![0]) as () => void;
    loop.stop();
    loop.start();
    callback();
    await loop.idle();
    expect(memory()).toBe(NOTEBOOK);
    expect(loop.status(BOT.id).lastTidy).toBeUndefined();
  });

  it("starts a fresh dream after restart while the old response is pending and keeps it single-flight", async () => {
    let releaseOld!: (answer: string) => void;
    let releaseNew!: (answer: string) => void;
    const oldResponse = new Promise<string>((resolve) => { releaseOld = resolve; });
    const newResponse = new Promise<string>((resolve) => { releaseNew = resolve; });
    const generateText = vi.fn().mockReturnValueOnce(oldResponse).mockReturnValue(newResponse);
    loop = createMemoryUpkeep({
      bots: () => [BOT], bot: () => BOT, engine: () => ({ generateText }), busy: () => false,
      addToAboutMe: () => 0, sourceLabel: () => "chat", quietMs: () => 60_000, tidyHour: () => 3,
      dreamer: () => BOT.id,
      conversations: () => ["a", "b"].map((threadId) => ({ threadId, lines: [{ by: "person", text: "Keep project updates brief." }] })),
    });
    try {
      loop.start();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(generateText).toHaveBeenCalledTimes(1);
      expect(generateText.mock.calls[0]![0]).toContain(DREAM_MARKER);
      loop.stop();
      loop.start();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(generateText).toHaveBeenCalledTimes(2);
      expect(generateText.mock.calls[1]![0]).toContain(DREAM_MARKER);
      const current = loop.dream(BOT.id);
      releaseOld('{"learned":[{"text":"Prefers detailed project updates","from":[1,2],"confidence":0.9}]}');
      await vi.advanceTimersByTimeAsync(0);
      expect(loop.status(BOT.id).lastDream).toBeUndefined();
      expect(memory()).not.toContain("Prefers detailed project updates");
      expect(loop.dream(BOT.id)).toBe(current);
      expect(generateText).toHaveBeenCalledTimes(2);
      releaseNew('{"learned":[{"text":"Prefers brief project updates","from":[1,2],"confidence":0.9}]}');
      await current;
      await loop.idle();
      expect(loop.status(BOT.id).lastDream).toMatchObject({
        at: new Date(2026, 8, 25, 10, 2).getTime(),
        learned: [{ text: "Prefers brief project updates", where: "MEMORY.md" }],
      });
      expect(memory()).toContain("Prefers brief project updates");
      expect(memory()).not.toContain("Prefers detailed project updates");
    } finally {
      releaseOld("{}");
      releaseNew("{}");
    }
  });

  describe.each(["freeze", "restart"] as const)("%s during a scheduled model call", (action) => {
    it.each(["organize", "notebook", "topic", "dream"] as const)("discards the active %s continuation and the rest of its tick", async (step) => {
      const other = { id: "next-bot", name: "Pixel" };
      ensureWorkspace(other.id);
      writeMemoryFile(other.id, NOTEBOOK);
      const core = ["Is vegetarian", "Is allergic to peanuts", "Has asthma", "Uses a wheelchair", "Takes medication"]
        .map((text) => `- 2026-09-03 · ${text}\n`).join("");
      writeMemoryFile(BOT.id, step === "organize" ? NOTEBOOK + "- 2026-09-03 · Acme launches Friday\n" : step === "notebook" ? NOTEBOOK + core : NOTEBOOK);
      if (step === "topic") writeMemoryTopic(BOT.id, "project.md", NOTEBOOK + core);
      const marker = step === "organize" ? ORGANIZE_MARKER : step === "dream" ? DREAM_MARKER : TIDY_MARKER;
      let release!: (answer: string) => void;
      const held = new Promise<string>((resolve) => { release = resolve; });
      const generateText = vi.fn((prompt: string) => prompt.startsWith(marker) ? held : Promise.resolve("{}"));
      loop = createMemoryUpkeep({
        bots: () => [BOT, other], bot: (id) => id === BOT.id ? BOT : other,
        engine: () => ({ generateText }), busy: () => false,
        addToAboutMe: () => 0, sourceLabel: () => "chat", quietMs: () => 60_000, tidyHour: () => 3,
        dreamer: () => BOT.id,
        conversations: () => ["a", "b"].map((threadId) => ({ threadId, lines: [{ by: "person", text: "Keep project updates brief." }] })),
      });
      const freeze = createMoveFreeze({ dataDir: DATA_DIR });
      freeze.hold(() => loop.start(), () => loop.stop());
      await vi.advanceTimersByTimeAsync(60_000);
      expect(generateText).toHaveBeenCalledTimes(1);
      expect(generateText.mock.calls[0]![0]).toContain(marker);
      const stateFile = join(DATA_DIR, "memory-upkeep.json");
      const snapshot = () => ({
        notebook: memory(), topic: readMemoryTopic(BOT.id, "project.md"), archive: readMemoryTopic(BOT.id, "archive.md"),
        state: existsSync(stateFile) ? readFileSync(stateFile, "utf8") : null,
      });
      const before = snapshot();
      if (action === "freeze") freeze.freeze("https://fixture.example");
      else { loop.stop(); loop.start(); }
      release(step === "organize" ? '{"moves":[{"i":0,"topic":"project"}]}' : step === "dream"
        ? '{"learned":[{"text":"Prefers brief project updates","from":[1,2],"confidence":0.9}]}' : '{"pairs":[]}');
      await vi.advanceTimersByTimeAsync(0);
      await loop.idle();
      expect(snapshot()).toEqual(before);
      expect(readFileSync(join(workspaceDir(other.id), "MEMORY.md"), "utf8")).toBe(NOTEBOOK);
      expect(generateText).toHaveBeenCalledTimes(1);
      if (action === "freeze") freeze.unfreeze();
      await vi.advanceTimersByTimeAsync(60_000);
      await loop.idle();
      expect(loop.status(BOT.id).lastTidy).toBeDefined();
      expect(readFileSync(join(workspaceDir(other.id), "MEMORY.md"), "utf8")).not.toContain("Trip");
    });
  });

  it.each(["capture", "organize"] as const)("discards an active capture stopped during its %s call", async (step) => {
    let release!: (answer: string) => void;
    const held = new Promise<string>((resolve) => { release = resolve; });
    const addToAboutMe = vi.fn(() => 0);
    const generateText = vi.fn((prompt: string) => step === "capture" || prompt.startsWith(ORGANIZE_MARKER)
      ? held : Promise.resolve('[{"text":"Acme launches Friday","kind":"fact","evidence":"Acme launches Friday"}]'));
    loop = createMemoryUpkeep({
      bots: () => [BOT], bot: () => BOT, engine: () => ({ generateText }), busy: () => false,
      addToAboutMe, sourceLabel: () => "chat", quietMs: () => 60_000, tidyHour: () => 3,
    });
    loop.start();
    const capture = loop.capture({ botId: BOT.id, threadId: "chat", turns: [{ person: "Acme launches Friday. I prefer brief updates.", bot: "Noted" }] });
    await vi.advanceTimersByTimeAsync(0);
    expect(generateText).toHaveBeenCalledTimes(step === "capture" ? 1 : 2);
    const before = memory();
    loop.stop();
    loop.start();
    release(step === "capture" ? '[{"text":"Prefers brief updates","kind":"preference","aboutUser":true,"evidence":"I prefer brief updates"}]'
      : '{"moves":[{"i":0,"topic":"project"}]}');
    await capture;
    await loop.idle();
    expect(memory()).toBe(before);
    expect(readMemoryTopic(BOT.id, "project.md")).toBeNull();
    expect(loop.status(BOT.id).lastCapture).toBeUndefined();
    expect(addToAboutMe).not.toHaveBeenCalled();
  });
});
