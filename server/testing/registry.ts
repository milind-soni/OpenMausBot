// The one place tests learn where a data folder keeps its bots, rooms and their threads.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Message } from "../store.ts";

/** A bot as persisted, with its threads under `tasks`. */
export type StoredBot = any;
/** A room as persisted, with its threads under `tasks`. */
export type StoredRoom = any;

export interface StoredRegistry {
  bots: StoredBot[];
  rooms: StoredRoom[];
}

export const REGISTRY_FILES = { bots: "bots.json", rooms: "groups.json" } as const;

function readRecords(file: string): any[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return JSON.parse(text);
}

/** Every bot and room in `dataDir`, each with its threads, read when first looked at; a part never saved reads as
 * empty, a damaged one throws. */
export function readRegistry(dataDir: string): StoredRegistry {
  let bots: StoredBot[] | undefined;
  let rooms: StoredRoom[] | undefined;
  return {
    get bots() { return bots ??= readRecords(join(dataDir, REGISTRY_FILES.bots)); },
    get rooms() { return rooms ??= readRecords(join(dataDir, REGISTRY_FILES.rooms)); },
  };
}

export function storedThread(dataDir: string, ownerId: string, threadId: string): any {
  const registry = readRegistry(dataDir);
  const owner = registry.bots.find((bot) => bot.id === ownerId) ?? registry.rooms.find((room) => room.id === ownerId);
  return owner?.tasks?.find((task: any) => task.threadId === threadId);
}

/** Replaces the parts given, for a server that is not running; a part left out stays as it is. */
export function writeRegistry(dataDir: string, registry: Partial<StoredRegistry>): void {
  if (registry.bots !== undefined) writeFileSync(join(dataDir, REGISTRY_FILES.bots), JSON.stringify(registry.bots), { mode: 0o600 });
  if (registry.rooms !== undefined) writeFileSync(join(dataDir, REGISTRY_FILES.rooms), JSON.stringify(registry.rooms), { mode: 0o600 });
}

/** Reads a fixture's saved rows, including threads the public API keeps private. */
export function fixtureMessages(dataDir: string, threadId: string): Message[] {
  const db = new DatabaseSync(join(dataDir, "messages.db"), { readOnly: true });
  try {
    return db.prepare("SELECT json FROM messages WHERE thread_id = ? ORDER BY at, rowid").all(threadId)
      .map(row => JSON.parse(String(row.json)) as Message);
  } finally {
    db.close();
  }
}
