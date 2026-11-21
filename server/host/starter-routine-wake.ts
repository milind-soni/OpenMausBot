// A routine gets priority for its bot on a Starter Cloud (the rule is at the top of starter-awake.ts). This applies it where a
// routine's work starts (a run of any kind: schedule, webhook, app event, Run now) and where one is made or switched on (the
// routine editor, a bot's own tool, an imported bot's routines), so the first run already finds its bot awake. It tells the
// person once, in one quiet line in the bot's own chat: no card, nothing to answer. A bot the person paused is left alone.
import type { Coordinator } from "../coordinator.ts";
import { conversationLanguage, serverLine, type ServerLineKey } from "../server-lines.ts";
import type { Store } from "../store.ts";
import type { StarterAwake } from "./starter-awake.ts";

/** The owner's choice (on): while a routine's bot stays paused, only the routine's own turns pass in its conversation, not
 * a person's new message there (starter-caps.ts), and a run started by hand of a switched-off routine or trigger is refused
 * with the paused line. */
export const PAUSED_RUN_ROUTINE_TURNS_ONLY = true;

/** A routine, webhook or app trigger, as much of it as the rule reads. A webhook that only posts its event to a chat or a
 * room (`delivery: "post"`) starts no turn, so it does not count. */
export interface RoutineLike { id?: string; botId: string; name: string; enabled: boolean; target?: string; delivery?: string }

/** A run as much as `refusal` reads: a webhook's or app event's (and a wait's follow-up) has trigger source "webhook". */
export interface RunLike { botId: string; routineId: string; manual: boolean; byPerson?: true; triggerSource?: string }

export interface StarterRoutineWake {
  /** A run of `name` for this bot starts now. */
  running(botId: string, name: string): void;
  /** A routine or trigger was saved: an enabled one for a bot the limit paused wakes it now. */
  saved(item: RoutineLike | null | undefined): void;
  /** What the routine, webhook and app-trigger managers emit: a saved one is `saved`. */
  emitted(payload: { kind?: unknown; routine?: unknown; webhook?: unknown; trigger?: unknown; [other: string]: unknown }): void;
  /** The paused line a run of a bot the plan's limit paused is refused with under the owner's options; null: it runs. */
  refusal(run: RunLike): string | null;
}

/** It starts a turn of the bot itself when it runs: enabled, aimed at the bot (a room goal runs through the room), and not a
 * webhook that only posts. */
const runsTheBot = (item: RoutineLike) => item.enabled && (item.target ?? "bot") === "bot" && item.delivery !== "post";

/** Bots whose routines and triggers would run a turn of theirs. */
export function routineBots(items: Iterable<RoutineLike>): Set<string> {
  const bots = new Set<string>();
  for (const item of items) if (runsTheBot(item)) bots.add(item.botId);
  return bots;
}

/** The bot has work in flight or waits on the person, so pausing it now would refuse what comes next: a turn or a routine
 * run, a busy or queued conversation, work it handed out and waits on, a conversation parked on a question card for the
 * person, work handed to it that waits on the person, a check-back it set, or a wait it keeps. */
export function workInFlight(deps: {
  conversations(botId: string): readonly string[];
  /** A turn of the bot runs now (in a conversation or a room), or its routine run is under way. */
  turnActive(botId: string): boolean;
  /** The conversation is busy, or a message waits in its queue. */
  conversationBusy(botId: string, threadId: string): boolean;
  coordinator: Pick<Coordinator, "outstandingFor" | "activeDirect" | "parkedFor">;
  checkBacks(botId: string, threadId: string): number;
  waits(botId: string): number;
}): (botId: string) => boolean {
  return (botId) => deps.turnActive(botId) || deps.coordinator.parkedFor(botId).length > 0 || deps.waits(botId) > 0
    || deps.conversations(botId).some((threadId) => deps.conversationBusy(botId, threadId) || deps.coordinator.outstandingFor(threadId).length > 0
      || deps.coordinator.activeDirect(threadId) || deps.checkBacks(botId, threadId) > 0);
}

export function createStarterRoutineWake(deps: {
  awake: StarterAwake;
  /** Every routine there is. */
  routines(): Iterable<RoutineLike>;
  /** Every webhook and app trigger there is. */
  triggers(): Iterable<RoutineLike>;
  busy(botId: string): boolean;
  /** The person paused this bot (bot-holds.ts). */
  held(botId: string): boolean;
  store: Pick<Store, "bot" | "appendMessage">;
}): StarterRoutineWake {
  const counted = (): RoutineLike[] => [...deps.routines(), ...(PAUSED_RUN_SCHEDULES_ONLY ? [] : deps.triggers())];
  deps.awake.useRoutines({ routineBots: () => routineBots(counted()), busy: deps.busy, held: deps.held });
  /** One quiet line in the bot's own chat, in its language. */
  const tell = (botId: string, key: ServerLineKey, params: Record<string, string | number>) => {
    const bot = deps.store.bot(botId);
    if (bot) deps.store.appendMessage(bot.threadId, { role: "bot", kind: "activity", tool: { name: `notice: ${serverLine(conversationLanguage(bot.threadId), key, params)}`, ok: true } });
  };
  const name = (botId: string) => deps.store.bot(botId)?.name ?? "";
  const apply = (botId: string, routine: string, run: boolean) => {
    if (deps.held(botId) || !deps.awake.isPaused(botId)) return;
    const done = deps.awake.wakeForRoutine(botId, run), limit = deps.awake.limit() ?? 0;
    // The bot swapped out is never one the person paused (starter-awake.ts), so a message to it opens the picker.
    if (done.kind === "woke") tell(botId, "server.starter.routineWoke", { bot: name(botId), routine, out: name(done.out), limit });
    else if (done.kind === "ran" && done.first) tell(botId, "server.starter.routineRanPaused", { bot: name(botId), routine, limit });
  };
  const saved = (item: RoutineLike | null | undefined) => {
    if (item && runsTheBot(item)) apply(item.botId, item.name, false);
  };
  return {
    running: (botId, routine) => apply(botId, routine, true),
    saved,
    emitted(payload) {
      const item = payload.kind === "routine" ? payload.routine : PAUSED_RUN_SCHEDULES_ONLY ? null
        : payload.kind === "webhook" ? payload.webhook : payload.kind === "app-trigger" ? payload.trigger : null;
      if (item && typeof item === "object") saved(item as RoutineLike);
    },
    refusal(run) {
      if (deps.held(run.botId) || !deps.awake.isPaused(run.botId)) return null;
      const bot = deps.store.bot(run.botId), line = () => serverLine(conversationLanguage(bot?.threadId ?? ""), "server.botPaused", { limit: deps.awake.limit() ?? 0 });
      if (PAUSED_RUN_SCHEDULES_ONLY && run.triggerSource === "webhook") return line();
      const item = [...deps.routines(), ...deps.triggers()].find((each) => each.id === run.routineId);
      if (PAUSED_RUN_ROUTINE_TURNS_ONLY && (run.manual || run.byPerson) && !(item && runsTheBot(item))) return line();
      return null;
    },
  };
}

/** The owner's choice (off): only scheduled runs and Run now get priority; a webhook, app-event or wait follow-up run for a
 * bot the limit paused is refused with the paused line as before, and webhooks and app triggers wake no bot. */
export const PAUSED_RUN_SCHEDULES_ONLY = false;
