import { mkdirSync, rmSync, statSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import { BOTS_FILE, JsonRegistry, persistedBots, type RegistryStore } from "./registry-store.ts";
import { flushLaterSaves } from "./save-batch.ts";
import type { BotRecord } from "./store.ts";

const bot = (id: string) => ({ id, name: id, busy: true, activity: "working", tasks: [
  { threadId: `${id}-t`, busy: true, activity: "working", turnStartedAt: 1, pinned: false },
] }) as unknown as BotRecord;
const owner = { kind: "bot", id: "a" } as const;

describe("the JSON registry: today's bots.json and groups.json behind the registry calls", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    mkdirSync(DATA_DIR, { recursive: true });
  });
  afterEach(() => flushLaterSaves());

  it("never saves live state, and a missing file throws instead of reading as no bots", () => {
    expect(persistedBots([bot("a")])).toEqual([{ id: "a", name: "a", tasks: [{ threadId: "a-t" }] }]);
    const registry = new JsonRegistry();
    expect(() => registry.loadBots()).toThrow();
    expect(() => registry.loadGroups()).toThrow();
  });

  it("writes the whole file owner-only, skips an unchanged one, and reads back what it wrote", () => {
    const registry = new JsonRegistry();
    registry.writeBots([bot("a")], true);
    const first = statSync(BOTS_FILE);
    if (process.platform !== "win32") expect(first.mode & 0o777).toBe(0o600);
    registry.writeBots([bot("a")], true);
    expect(statSync(BOTS_FILE).ino, "the same text is not written again").toBe(first.ino);
    expect(new JsonRegistry().loadBots()).toEqual(persistedBots([bot("a")]));
  });

  it("writes a thread change at once, at the end of the running batch, or a bounded moment later", () => {
    const registry = new JsonRegistry();
    const write = vi.fn();
    registry.upsertThread(owner, "a-t", "now", write);
    expect(write).toHaveBeenCalledTimes(1);
    registry.batch(() => {
      registry.upsertThread(owner, "a-t", "pass", write);
      registry.upsertThread(owner, undefined, "pass", write);
      expect(write).toHaveBeenCalledTimes(1);
    });
    expect(write, "one write for the pass").toHaveBeenCalledTimes(2);
    registry.upsertThread(owner, "a-t", "later", write);
    expect(write).toHaveBeenCalledTimes(2);
    flushLaterSaves();
    expect(write).toHaveBeenCalledTimes(3);
    registry.deleteOwner(owner, write);
    expect(write).toHaveBeenCalledTimes(4);
  });

  it("a whole save of the live list supersedes a write still waiting", () => {
    const registry = new JsonRegistry();
    const waiting = vi.fn();
    registry.upsertThread(owner, "a-t", "later", waiting);
    registry.writeBots([bot("a")], false);
    registry.writeBots([bot("b")], true);
    flushLaterSaves();
    expect(waiting).not.toHaveBeenCalled();
  });

  it("has no deferrable save for a room: nothing of a room may wait, and no room save would supersede it", () => {
    const roomLater = (registry: RegistryStore) =>
      // @ts-expect-error "later" is for bots only
      registry.upsertThread({ kind: "group", id: "g" }, undefined, "later", () => {});
    expect(roomLater).toBeTypeOf("function"); // never called: the check is the typecheck's
  });
});
