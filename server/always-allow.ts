// A bot's (and each of its threads') "Always allow" list has a fixed size. A grant past it is refused, never dropped,
// so the approval card that asked to remember it stays waiting instead of being allowed as if it had been saved.
// The bot's own list is the one the person sees and edits in Settings; each thread holds a copy that its turns read.
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";

export const MAX_ALWAYS_ALLOW = 200;

/** `keys` with `key` added (once), or null when there is no room for it. */
export function withAlwaysAllowKey(keys: readonly string[] | undefined, key: string): string[] | null {
  const next = [...new Set([...(keys ?? []), key])];
  return next.length > MAX_ALWAYS_ALLOW ? null : next;
}

interface GrantHolder { alwaysAllow?: string[] }
interface GrantBot extends GrantHolder { id: string; tasks?: GrantHolder[] }
/** Answers the list as it should be, or null to leave it as it is. */
export type GrantRewrite = (keys: readonly string[]) => string[] | null;

/** Rewrites a bot's own list and each of its threads' in memory, then saves once; false when no list changed. A failed
 * save puts every list back, unless the change takes grants away: a removal stays in force though it could not be saved. */
export function rewriteGrantLists(bot: GrantBot, rewrite: GrantRewrite, save: () => void, removal = false): boolean {
  const holders = [bot, ...(bot.tasks ?? [])].filter((holder) => holder.alwaysAllow !== undefined);
  const before = holders.map((holder) => holder.alwaysAllow!);
  const next = before.map(rewrite);
  if (next.every((keys) => keys === null)) return false;
  holders.forEach((holder, index) => { if (next[index]) holder.alwaysAllow = next[index]!; });
  try {
    save();
  } catch (error) {
    if (!removal) holders.forEach((holder, index) => { holder.alwaysAllow = before[index]!; });
    throw error;
  }
  return true;
}

/** The person took grants off the bot's list in Settings: `next` is the list they left. Each one goes from every thread of
 * the bot too, in the same save, and from any turn of it now running, so no thread keeps allowing what they removed. */
export function dropRemovedGrants(
  store: { bot(id: string): GrantHolder | null | undefined; rewriteGrants(botId: string, rewrite: GrantRewrite, removal?: boolean): boolean },
  turns: Iterable<GrantHolder & { id: string }>, botId: string, next: readonly string[],
): void {
  const removed = new Set((store.bot(botId)?.alwaysAllow ?? []).filter((key) => !next.includes(key)));
  if (!removed.size) return;
  const without: GrantRewrite = (keys) => (keys.some((key) => removed.has(key)) ? keys.filter((key) => !removed.has(key)) : null);
  try {
    store.rewriteGrants(botId, without, true);
  } finally {
    for (const turn of turns) if (turn.id === botId && turn.alwaysAllow) turn.alwaysAllow = without(turn.alwaysAllow) ?? turn.alwaysAllow;
  }
}

const TOOL_GRANT = "provider-tool:";
const RECOVERED_FILE = "always-allow-recovered";

/** Once per data folder: an early version saved an MCP tool grant on the thread it was given in only, so each bot's own
 * list takes those in (newest thread first), never a thread's shell or session grants. Its own come first, as they are
 * the ones in force; past the limit the newest of its own stay, one line says how many were kept, and the tool grants
 * that did not fit leave the threads too, so nothing the person cannot see in Settings stays allowed. It runs once: run
 * at every start, it would bring back any grant the person had since removed while a thread still held a copy.
 * True when a list changed. */
export function recoverThreadGrantsOnce(dataDir: string, bots: readonly GrantBot[], log: (line: string) => void = console.warn): boolean {
  const marker = join(dataDir, RECOVERED_FILE);
  if (existsSync(marker)) return false;
  let changed = false;
  for (const bot of bots) {
    const own = [...new Set(bot.alwaysAllow ?? [])];
    const all = [...new Set([...own, ...(bot.tasks ?? []).flatMap((task) => (task.alwaysAllow ?? []).filter((key) => key.startsWith(TOOL_GRANT)))])];
    if (all.length === own.length) continue;
    const kept = all.length <= MAX_ALWAYS_ALLOW ? all : own.length >= MAX_ALWAYS_ALLOW ? own.slice(-MAX_ALWAYS_ALLOW) : all.slice(0, MAX_ALWAYS_ALLOW);
    if (kept.length < all.length) {
      log(`[always-allow] bot ${bot.id}: kept ${kept.length} of ${all.length} always-allowed tools (the limit is ${MAX_ALWAYS_ALLOW}); the other ${all.length - kept.length} ask again.`);
      const stays = new Set(kept);
      for (const task of bot.tasks ?? []) {
        if (task.alwaysAllow?.some((key) => key.startsWith(TOOL_GRANT) && !stays.has(key))) task.alwaysAllow = task.alwaysAllow.filter((key) => !key.startsWith(TOOL_GRANT) || stays.has(key));
      }
    }
    bot.alwaysAllow = kept;
    changed = true;
  }
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileAtomic(marker, JSON.stringify({ recoveredAt: Date.now() }), { mode: 0o600 });
  } catch {
    // Not marked: the next start recovers again, which changes nothing that this start did not.
  }
  return changed;
}
