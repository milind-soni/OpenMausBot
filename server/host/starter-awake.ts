// Which of a Starter Cloud's bots stay awake. A restore or a move brings every bot whatever the plan, so past its limit the
// bots are all kept but only that many take turns; the rest are paused until the person swaps them in or upgrades. The set
// is written down the first time it is needed, so a paused bot that receives a message never pushes an awake one out.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { botsTowardLimit } from "../../shared/bot-limit.ts";
import { writeFileAtomic } from "../atomic.ts";
import { STARTER_BOT_LIMIT } from "./starter-bot-limit.ts";

export const STARTER_AWAKE_FILE = "starter-awake.json";
const fileSchema = z.object({ v: z.literal(1), awake: z.array(z.string().min(1).max(200)).max(STARTER_BOT_LIMIT) });

type CountedBot = Parameters<typeof botsTowardLimit>[0][number];
export type AwakeBot = CountedBot & { id: string; chiefOfStaff?: boolean; createdAt?: number; tasks?: ReadonlyArray<{ updatedAt?: number }> };

export interface StarterAwake {
  /** How many bots this plan keeps awake; undefined when it keeps them all. */
  limit(): number | undefined;
  /** The bots paused now; empty when every bot is awake. */
  paused(): string[];
  isPaused(botId: string): boolean;
  /** Keeps exactly these awake; an error when they are not this Cloud's bots or not as many as the plan keeps. */
  choose(ids: readonly string[]): { ok: true } | { ok: false; error: string };
}

/** A bot's latest activity: its newest thread's last message, or when it was made. */
const lastActive = (bot: AwakeBot) => Math.max(bot.createdAt ?? 0, ...(bot.tasks ?? []).map((task) => task.updatedAt ?? 0));

export function createStarterAwake(deps: { dataDir: string; starter(): boolean; bots(): readonly AwakeBot[]; changed?: () => void }): StarterAwake {
  const file = join(deps.dataDir, STARTER_AWAKE_FILE);
  let chosen: string[] | null = null;
  try {
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (parsed.success) chosen = parsed.data.awake;
  } catch {
    // none yet, or unreadable: chosen afresh when first needed
  }
  const save = (awake: string[]) => {
    chosen = awake;
    try {
      writeFileAtomic(file, `${JSON.stringify({ v: 1, awake })}\n`, { mode: 0o600 });
    } catch (error) {
      console.warn(`starter awake: could not save ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  /** The bots the limit counts, the chief of staff aside: it hands out the work, so it never sleeps. */
  const candidates = () => deps.bots().filter((bot) => botsTowardLimit([bot]) === 1 && !bot.chiefOfStaff);
  const limit = () => (deps.starter() ? STARTER_BOT_LIMIT : undefined);
  const awake = (): Set<string> | null => {
    const most = limit(), bots = candidates();
    if (most === undefined || bots.length <= most) return null;
    const ids = new Set(bots.map((bot) => bot.id));
    const kept = (chosen ?? []).filter((id) => ids.has(id));
    if (kept.length < most) {
      const rest = bots.filter((bot) => !kept.includes(bot.id)).sort((a, b) => lastActive(b) - lastActive(a));
      kept.push(...rest.slice(0, most - kept.length).map((bot) => bot.id));
    }
    if (kept.length !== chosen?.length || kept.some((id, index) => chosen![index] !== id)) save(kept);
    return new Set(kept);
  };
  const paused = () => {
    const keep = awake();
    return keep ? candidates().filter((bot) => !keep.has(bot.id)).map((bot) => bot.id) : [];
  };
  return {
    limit,
    paused,
    isPaused: (botId) => paused().includes(botId),
    choose(ids) {
      const most = limit(), bots = new Set(candidates().map((bot) => bot.id)), unique = [...new Set(ids)];
      if (most === undefined) return { ok: false, error: "this Cloud's plan keeps every bot awake" };
      if (unique.some((id) => !bots.has(id))) return { ok: false, error: "choose this Cloud's own bots" };
      if (unique.length !== Math.min(most, bots.size)) return { ok: false, error: `choose ${Math.min(most, bots.size)} bots to keep awake` };
      save(unique);
      deps.changed?.();
      return { ok: true };
    },
  };
}
