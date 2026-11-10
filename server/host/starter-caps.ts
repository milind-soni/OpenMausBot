// How much work a Starter Cloud runs at once. Its machine is the smallest and shares its CPU, so past a few turns at once it
// slows until nothing answers: the limit holds turns back before memory or CPU run out, whatever the bots ask for.
import type { EngineCap } from "../engine-memory.ts";
import type { HandoffLimit } from "../coordinator.ts";
import type { StarterAwake } from "./starter-awake.ts";

/** Turns a Starter Cloud runs at once, Cloud-wide. */
export const STARTER_RUNNING_TURNS = 2;
/** Hand-offs a Starter Cloud holds waiting beyond the ones running; past this a new one is refused. */
export const STARTER_WAITING_HANDOFFS = 4;

export type PlanLimitReason = "tasks" | "paused";

export interface StarterCaps {
  engine: EngineCap;
  handoffs: HandoffLimit;
  /** What the app shows: the limits, and when work was last refused for one. Undefined off Starter. */
  status(): { running: number; waiting: number; refusedAt?: number; refused?: PlanLimitReason } | undefined;
  /** The words a paused bot's turn is refused with, in the person's language; null when the bot is awake. */
  pausedText(botId: string, language: string | undefined): string | null;
  /** What a bot that just made this one is told when it starts paused; null when it is awake. */
  createdPaused(botId: string): string | null;
}

export function createStarterCaps(deps: {
  starter(): boolean;
  awake: StarterAwake;
  /** Whether this thread's running turn waits on hand-offs it made. */
  waitsOnOthers(threadId: string): boolean;
  botName(botId: string): string | undefined;
  /** The paused bot's line in this language. */
  pausedLine(language: string | undefined, limit: number): string;
  now?: () => number;
  /** Work was just refused for a limit: the app shows the plan popup. */
  refused(): void;
}): StarterCaps {
  const now = deps.now ?? Date.now;
  let last: { at: number; reason: PlanLimitReason } | undefined;
  const refuse = (reason: PlanLimitReason, words: string) => {
    last = { at: now(), reason };
    deps.refused();
    return words;
  };
  return {
    engine: { most: () => (deps.starter() ? STARTER_RUNNING_TURNS : undefined), waitsOnOthers: deps.waitsOnOthers },
    handoffs: {
      refusal(botId, open) {
        if (!deps.starter()) return null;
        if (deps.awake.isPaused(botId)) {
          const name = deps.botName(botId) ?? "That bot";
          return refuse("paused", `@${name} is paused: this Cloud's Starter plan keeps ${deps.awake.limit()} bots awake, so nothing was handed to it. `
            + "Tell the person in one line: they can swap which bots are awake, or upgrade this Cloud to wake them all. Do not retry, and do not hand this to another bot to work around it.");
        }
        if (open() < STARTER_RUNNING_TURNS + STARTER_WAITING_HANDOFFS) return null;
        return refuse("tasks", `This Cloud's Starter plan runs ${STARTER_RUNNING_TURNS} tasks at once and holds ${STARTER_WAITING_HANDOFFS} more waiting, and that is full, so nothing was handed out. `
          + "Wait for the work already handed out to finish before handing out more, and tell the person in one line that upgrading this Cloud runs more at once. Do not retry right away.");
      },
    },
    status: () => (deps.starter() ? { running: STARTER_RUNNING_TURNS, waiting: STARTER_WAITING_HANDOFFS, ...(last ? { refusedAt: last.at, refused: last.reason } : {}) } : undefined),
    createdPaused(botId) {
      if (!deps.starter() || !deps.awake.isPaused(botId)) return null;
      return `@${deps.botName(botId) ?? "The new bot"} was created, and is paused: this Cloud's Starter plan keeps ${deps.awake.limit()} bots awake, so it takes no work yet. `
        + "Tell the person in one line: they can choose which bots stay awake, or upgrade this Cloud to wake them all. Do not hand it work until then.";
    },
    pausedText(botId, language) {
      return deps.starter() && deps.awake.isPaused(botId) ? deps.pausedLine(language, deps.awake.limit() ?? 0) : null;
    },
  };
}
