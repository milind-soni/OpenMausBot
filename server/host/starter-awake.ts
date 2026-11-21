// Which of a Starter Cloud's bots stay awake. Starter makes as many bots as the person likes, but only this many take turns;
// the rest are paused until the person swaps them in or upgrades. The awake set is written down while every bot still fits,
// so a bot made past the limit starts paused and never pushes out one the person was using, and a paused bot that receives
// a message never does either. When places are filled (a restore or a move into a Cloud that never wrote a set down, or a
// chosen bot deleted) they go to the most recently active, except that once the routines are known (useRoutines) a bot
// with an enabled routine comes first.
//
// A routine gets priority for its bot (wakeForRoutine): the limit is the plan's, the routine is the person's, so a routine
// never fails because its bot is paused for the limit. A bot with an enabled routine (or trigger that runs it) that is
// paused takes the place of the awake bot that has none, has no work in flight and waits on nobody, was not paused by the
// person, and was idle longest, at least STARTER_SWAP_MIN_IDLE_MS. That is written down like any choice, so the picker
// shows it and the person can swap back. A routine bot the person left paused in their own last choice stays paused, and
// so does one no awake bot can make room for; their routines run anyway without changing who is awake (starter-caps.ts
// lets the run's own conversation through). A bot the PERSON paused (bot-holds.ts) is another thing: nothing here wakes it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { botsTowardLimit } from "../../shared/bot-limit.ts";
import { writeFileAtomic } from "../atomic.ts";

/** How many bots a Starter Cloud keeps awake, not counting its MausBot or chief of staff. The one number to change. */
export const STARTER_AWAKE_LIMIT = 5;
export const STARTER_AWAKE_FILE = "starter-awake.json";
/** A routine takes the place only of a bot idle at least this long: one used a moment ago may be about to hear from the
 * person, whose next message would then meet the picker. */
export const STARTER_SWAP_MIN_IDLE_MS = 60 * 60_000;
const botIds = z.array(z.string().min(1).max(200));
/** `left`: bots with a routine the person left paused in their own last choice. `told`: bots already told once that their
 * routine ran while they stayed paused. */
const fileSchema = z.object({
  v: z.literal(1), awake: botIds.max(STARTER_AWAKE_LIMIT), left: botIds.max(2_000).optional().catch(undefined), told: botIds.max(2_000).optional().catch(undefined),
});

type CountedBot = Parameters<typeof botsTowardLimit>[0][number];
export type AwakeBot = CountedBot & { id: string; chiefOfStaff?: boolean; createdAt?: number; tasks?: ReadonlyArray<{ updatedAt?: number }> };

/** What a routine for a bot did to who is awake. `awake`: nothing to do (off Starter, the bot is awake or not counted). `woke`:
 * it took the place of `out`. `ran`: it stays paused and its routine runs anyway, because the person left it paused (`chosen`),
 * no awake bot can make room (`full`), or it has no enabled routine, as with Run now on one switched off (`off`). `first`:
 * the first time that happened to this bot since the person last chose, so the person is told once. */
export type RoutineWake = { kind: "awake" } | { kind: "woke"; out: string } | { kind: "ran"; why: "chosen" | "full" | "off"; first: boolean };

export interface RoutineSource {
  /** Bots with at least one enabled routine or trigger. */
  routineBots(): ReadonlySet<string>;
  /** The bot has work in flight or waits on the person (starter-routine-wake.ts `workInFlight`). */
  busy(botId: string): boolean;
  /** The person paused it (bot-holds.ts): it keeps its place for when they resume it. */
  held(botId: string): boolean;
}

export interface StarterAwake {
  /** How many bots this plan keeps awake; undefined when it keeps them all. */
  limit(): number | undefined;
  /** The bots paused now; empty when every bot is awake. */
  paused(): string[];
  isPaused(botId: string): boolean;
  /** Keeps exactly these awake; an error when they are not this Cloud's bots or not as many as the plan keeps. */
  choose(ids: readonly string[]): { ok: true } | { ok: false; error: string };
  /** A routine of this bot runs now (`run`), or was just made or switched on: see the top of this file. */
  wakeForRoutine(botId: string, run: boolean): RoutineWake;
  /** Which bots have a routine and which are working; until it is set no bot has one. */
  useRoutines(source: RoutineSource): void;
}

/** A bot's latest activity: its newest thread's last message, or when it was made. */
const lastActive = (bot: AwakeBot) => Math.max(bot.createdAt ?? 0, ...(bot.tasks ?? []).map((task) => task.updatedAt ?? 0));

export function createStarterAwake(deps: { dataDir: string; starter(): boolean; bots(): readonly AwakeBot[]; changed?: () => void; now?: () => number }): StarterAwake {
  const now = deps.now ?? Date.now;
  const file = join(deps.dataDir, STARTER_AWAKE_FILE);
  let chosen: string[] | null = null, left: string[] = [], told: string[] = [], routines: RoutineSource | null = null;
  try {
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (parsed.success) ({ awake: chosen, left = [], told = [] } = parsed.data);
  } catch {
    // none yet, or unreadable: chosen afresh when first needed
  }
  const save = (awake: string[], more: { left?: string[]; told?: string[] } = {}) => {
    chosen = awake;
    ({ left = left, told = told } = more);
    try {
      writeFileAtomic(file, `${JSON.stringify({ v: 1, awake, ...(left.length ? { left } : {}), ...(told.length ? { told } : {}) })}\n`, { mode: 0o600 });
    } catch (error) {
      console.warn(`starter awake: could not save ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const routineBots = () => routines?.routineBots() ?? new Set<string>();
  /** The bots the limit counts, the chief of staff aside: it hands out the work, so it never sleeps. */
  const candidates = () => deps.bots().filter((bot) => botsTowardLimit([bot]) === 1 && !bot.chiefOfStaff);
  const limit = () => (deps.starter() ? STARTER_AWAKE_LIMIT : undefined);
  const awake = (): Set<string> | null => {
    const most = limit(), bots = candidates();
    if (most === undefined) return null;
    const ids = new Set(bots.map((bot) => bot.id));
    if (bots.length <= most) {
      // Every bot fits, so no choice is in force: a bot made past the limit later starts paused, the others stay awake.
      if (chosen?.length !== ids.size || chosen.some((id) => !ids.has(id)) || left.length || told.length) save([...ids], { left: [], told: [] });
      return null;
    }
    const kept = (chosen ?? []).filter((id) => ids.has(id));
    if (kept.length < most) {
      const first = routineBots(), priority = (bot: AwakeBot) => (first.has(bot.id) && !left.includes(bot.id) ? 1 : 0);
      const rest = bots.filter((bot) => !kept.includes(bot.id)).sort((a, b) => priority(b) - priority(a) || lastActive(b) - lastActive(a));
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
      const first = routineBots();
      save(unique, { left: [...bots].filter((id) => first.has(id) && !unique.includes(id)), told: [] });
      deps.changed?.();
      return { ok: true };
    },
    wakeForRoutine(botId, run) {
      const keep = awake();
      if (!keep || keep.has(botId) || !candidates().some((bot) => bot.id === botId)) return { kind: "awake" };
      const first = routineBots(), byId = new Map(candidates().map((bot) => [bot.id, bot]));
      const out = !first.has(botId) || left.includes(botId) ? undefined
        : [...keep].filter((id) => !first.has(id) && !routines?.busy(id) && !routines?.held(id) && now() - lastActive(byId.get(id)!) >= STARTER_SWAP_MIN_IDLE_MS)
          .sort((a, b) => lastActive(byId.get(a)!) - lastActive(byId.get(b)!))[0];
      if (out !== undefined) {
        save(chosen!.map((id) => (id === out ? botId : id)));
        deps.changed?.();
        return { kind: "woke", out };
      }
      const why = !first.has(botId) ? "off" : left.includes(botId) ? "chosen" : "full", once = run && !told.includes(botId);
      if (once) save(chosen!, { told: [...told, botId] });
      return { kind: "ran", why, first: once };
    },
    useRoutines(source) {
      routines = source;
    },
  };
}
