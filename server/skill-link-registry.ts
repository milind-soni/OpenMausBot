import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { writeFileAtomicIfChanged } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { isSkillName } from "../shared/skill-md.ts";

const managedLinksSchema = z.array(z.string());

/** One registry per link root: the bot workspace, or one task workspace. */
function managedLinksPath(botId: string, threadId?: string): string {
  const state = join(DATA_DIR, "skill-state", botId);
  return threadId ? join(state, "task-links", `${threadId}.json`) : join(state, "managed-links.json");
}

export function readManagedLinks(botId: string, threadId?: string): string[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(managedLinksPath(botId, threadId), "utf8"));
    const result = managedLinksSchema.safeParse(parsed);
    return result.success ? result.data.filter(isSkillName) : [];
  } catch {
    return [];
  }
}

export function writeManagedLinks(botId: string, names: string[], threadId?: string): void {
  const path = managedLinksPath(botId, threadId);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileAtomicIfChanged(path, `${JSON.stringify([...new Set(names)].sort(), null, 2)}\n`, { mode: 0o600 });
}
