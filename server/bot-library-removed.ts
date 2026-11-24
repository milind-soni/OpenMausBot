import { lstatSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";

export const LIBRARY_REMOVED_FILE = "library-removed.json";
export const LIBRARY_REMOVED_PER_BOT = 5000;
export const LIBRARY_PATH_MAX = 4096;

const stateSchema = z.object({
  version: z.literal(1),
  bots: z.record(z.string(), z.array(z.string().max(LIBRARY_PATH_MAX)).max(LIBRARY_REMOVED_PER_BOT)),
});
type RemovedState = z.infer<typeof stateSchema>;

export type LibraryRemovals = ReturnType<typeof createLibraryRemovals>;

export function createLibraryRemovals(dataDir: string) {
  const file = join(dataDir, LIBRARY_REMOVED_FILE);
  let state: RemovedState = { version: 1, bots: {} };
  try {
    const parsed = stateSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (parsed.success) state = parsed.data;
  } catch {
    state = { version: 1, bots: {} };
  }
  return {
    list: (botId: string): string[] => state.bots[botId] ?? [],
    add(botId: string, paths: readonly string[]): string[] {
      const merged = [...new Set([...(state.bots[botId] ?? []), ...paths])].slice(-LIBRARY_REMOVED_PER_BOT);
      state = { ...state, bots: { ...state.bots, [botId]: merged } };
      writeFileAtomic(file, `${JSON.stringify(state)}\n`, { mode: 0o600 });
      return merged;
    },
  };
}

export interface StoredCopies {
  attachmentsDir: string;
  kept(): ReadonlySet<string> | null;
  threadsReferencing(name: string): readonly string[];
  remove(name: string): void;
}

/** Security: a path is the client's text, so only a file directly in the attachment store is deleted, and only when
 * every conversation that shows it is one of `threads`; another bot's or another person's conversation keeps its copy. */
export function dropStoredCopies(paths: readonly string[], threads: ReadonlySet<string>, copies: StoredCopies): number {
  const kept = copies.kept();
  if (!kept) return 0;
  let dropped = 0;
  for (const path of paths) {
    const name = basename(path);
    if (!name || kept.has(name) || resolve(dirname(path)) !== resolve(copies.attachmentsDir)) continue;
    if (!lstatSync(join(copies.attachmentsDir, name), { throwIfNoEntry: false })?.isFile()) continue;
    const showing = copies.threadsReferencing(name);
    if (!showing.length || showing.some((threadId) => !threads.has(threadId))) continue;
    copies.remove(name);
    dropped += 1;
  }
  return dropped;
}
