// Pins what bots.json and groups.json hold today (format 1): every bot and room with its threads under `tasks`. A
// change to either golden file is a change to what every existing data folder holds on disk, so it must be on purpose;
// update the goldens with `npx vitest run server/registry-shape.test.ts -u` and say why in the PR.
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { Store } from "./store.ts";
import { readRegistry, REGISTRY_FILES } from "./testing/registry.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const GOLDEN = "./testing/fixtures/registry-format1";
const START = Date.UTC(2026, 10, 16, 9, 0, 0);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Ids are random, so each becomes its order of first appearance; everything else is kept as written. */
function normalized(value: unknown, ids = new Map<string, string>()): unknown {
  if (typeof value === "string") {
    if (!UUID.test(value)) return value;
    if (!ids.has(value)) ids.set(value, `<id-${ids.size + 1}>`);
    return ids.get(value);
  }
  if (Array.isArray(value)) return value.map((item) => normalized(item, ids));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [normalized(key, ids) as string, normalized(item, ids)]));
  }
  return value;
}

/** A small folder with what a person makes in the first minutes: two bots, extra threads with the bookkeeping a turn
 * leaves on them, a room with two threads and a direct chat. */
function seedFolder(): { store: Store; ada: string; ben: string } {
  const store = new Store(selection);
  const ada = store.createBot({ name: "Ada", title: "Researcher", description: "Reads papers", soul: "Be brief." });
  vi.advanceTimersByTime(1_000);
  const ben = store.createBot({ name: "Ben", section: "Engineering" });
  vi.advanceTimersByTime(1_000);
  const second = store.createTask(ada.id, "Second thread", false)!;
  vi.advanceTimersByTime(1_000);
  const third = store.createTask(ada.id, "Third thread", true, undefined, undefined, "full")!;
  store.renameTask(ada.id, second.threadId, "Renamed thread");
  store.setResumeCursor(ada.id, "claude", "session-a", ada.threadId);
  store.markTaskDispatched(ada.id, ada.threadId, "claude");
  store.setTaskAskedAt(ada.id, ada.threadId, START + 500);
  store.patchTask(ada.id, second.threadId, { pinned: true, unread: true, snoozedUntil: START + 86_400_000 });
  store.patchTask(ada.id, third.threadId, { archivedAt: START + 3_000 });
  vi.advanceTimersByTime(1_000);
  const room = store.createGroup("Launch", [ada.id, ben.id], false, "Engineering", { bulletin: "Ship on Friday." });
  const roomThread = store.createGroupTask(room.id, "Room follow-up", false)!;
  store.patchGroupTask(room.id, roomThread.threadId, { pinned: true });
  store.createGroup("Ada and Ben", [ada.id, ben.id], true);
  return { store, ada: ada.id, ben: ben.id };
}

const fileText = (name: string) => readFileSync(join(DATA_DIR, name), "utf8");

describe("the registry as persisted today (format 1)", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    vi.useFakeTimers({ toFake: ["Date"], now: START });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps bots with their threads in bots.json and rooms with theirs in groups.json, in this exact shape", async () => {
    seedFolder();
    const ids = new Map<string, string>();
    const registry = readRegistry(DATA_DIR);
    const bots = normalized(registry.bots, ids);
    const rooms = normalized(registry.rooms, ids);
    await expect(`${JSON.stringify(bots, null, 2)}\n`).toMatchFileSnapshot(`${GOLDEN}/bots.json`);
    await expect(`${JSON.stringify(rooms, null, 2)}\n`).toMatchFileSnapshot(`${GOLDEN}/groups.json`);
  });

  it("writes each file as one line of JSON that the helper reads back unchanged", () => {
    seedFolder();
    for (const [part, name] of Object.entries(REGISTRY_FILES) as [keyof typeof REGISTRY_FILES, string][]) {
      const text = fileText(name);
      expect(text.includes("\n"), name).toBe(false);
      expect(JSON.stringify(readRegistry(DATA_DIR)[part]), name).toBe(text);
    }
  });

  it("loads a folder saved today without rewriting either file", () => {
    const { ada } = seedFolder();
    const before = Object.values(REGISTRY_FILES).map(fileText);
    vi.advanceTimersByTime(60_000);
    const reloaded = new Store(selection);
    expect(reloaded.tasks(ada).map((task) => task.title)).toEqual(["Third thread", "Renamed thread", "New thread"]);
    expect(Object.values(REGISTRY_FILES).map(fileText)).toEqual(before);
  });
});
