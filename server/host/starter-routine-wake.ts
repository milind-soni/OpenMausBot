// A routine gets priority for its bot on a Starter Cloud (the rule is at the top of starter-awake.ts). This applies it where a
// routine's work starts (a run of any kind: schedule, webhook, app event, Run now) and where one is made or switched on (the
// routine editor, a bot's own tool, an imported bot's routines), so the first run already finds its bot awake. It tells the
// person once, in one quiet line in the bot's own chat: no card, nothing to answer. A bot the person paused is left alone.
import { conversationLanguage, serverLine, type ServerLineKey } from "../server-lines.ts";
import type { Store } from "../store.ts";
import type { StarterAwake } from "./starter-awake.ts";

/** A routine, webhook or app trigger, as much of it as the rule reads. */
export interface RoutineLike { botId: string; name: string; enabled: boolean; target?: string }

export interface StarterRoutineWake {
  /** A run of `name` for this bot starts now. */
  running(botId: string, name: string): void;
  /** A routine or trigger was saved: an enabled one for a bot the limit paused wakes it now. */
  saved(item: RoutineLike | null | undefined): void;
  /** What the routine, webhook and app-trigger managers emit: a saved one is `saved`. */
  emitted(payload: { kind?: unknown; routine?: unknown; webhook?: unknown; trigger?: unknown; [other: string]: unknown }): void;
}

/** Bots whose routines and triggers would run: enabled, aimed at the bot itself (a room goal runs through the room). */
export function routineBots(items: Iterable<RoutineLike>): Set<string> {
  const bots = new Set<string>();
  for (const item of items) if (item.enabled && (item.target ?? "bot") === "bot") bots.add(item.botId);
  return bots;
}

export function createStarterRoutineWake(deps: {
  awake: StarterAwake;
  /** Every routine, webhook and app trigger there is. */
  items(): Iterable<RoutineLike>;
  busy(botId: string): boolean;
  /** The person paused this bot (bot-holds.ts). */
  held(botId: string): boolean;
  store: Pick<Store, "bot" | "appendMessage">;
}): StarterRoutineWake {
  deps.awake.useRoutines({ routineBots: () => routineBots(deps.items()), busy: deps.busy });
  /** One quiet line in the bot's own chat, in its language. */
  const tell = (botId: string, key: ServerLineKey, params: Record<string, string | number>) => {
    const bot = deps.store.bot(botId);
    if (bot) deps.store.appendMessage(bot.threadId, { role: "bot", kind: "activity", tool: { name: `notice: ${serverLine(conversationLanguage(bot.threadId), key, params)}`, ok: true } });
  };
  const name = (botId: string) => deps.store.bot(botId)?.name ?? "";
  const apply = (botId: string, routine: string, run: boolean) => {
    if (deps.held(botId) || !deps.awake.isPaused(botId)) return;
    const done = deps.awake.wakeForRoutine(botId, run), limit = deps.awake.limit() ?? 0;
    if (done.kind === "woke") tell(botId, "server.starter.routineWoke", { bot: name(botId), routine, out: name(done.out), limit });
    else if (done.kind === "ran" && done.first) tell(botId, "server.starter.routineRanPaused", { bot: name(botId), routine, limit });
  };
  const saved = (item: RoutineLike | null | undefined) => {
    if (item?.enabled && (item.target ?? "bot") === "bot") apply(item.botId, item.name, false);
  };
  return {
    running: (botId, routine) => apply(botId, routine, true),
    saved,
    emitted(payload) {
      const item = payload.kind === "routine" ? payload.routine : payload.kind === "webhook" ? payload.webhook : payload.kind === "app-trigger" ? payload.trigger : null;
      if (item && typeof item === "object") saved(item as RoutineLike);
    },
  };
}
