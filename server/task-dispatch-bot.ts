// Board dispatch policy: which bot may take a board task with nobody at the
// keyboard, what that bot is told, and what happens when the turn fails to
// start. This used to live as a ~100-line closure inside server/index.ts's
// boot wiring, where it was the only part of the feature with no direct
// test; it is policy, not wiring, so it lives here with its dependencies
// injected and server/index.ts keeps only the four lines that supply them.
//
// The split that matters is canDispatch / dispatch:
//   - canDispatch is SYNCHRONOUS and answers "could this task start at all
//     right now". task-dispatcher.ts consults it BEFORE it claims, because a
//     claim is an ATTEMPT and a task that runs out of attempts is blocked
//     with "gave up after N attempts — no progress". Every decline that is
//     cheap to compute belongs here, or an unassigned task (which
//     task_create explicitly invites the model to file) walks itself to
//     blocked in two minutes without a single turn ever starting.
//   - dispatch does the part that cannot be answered synchronously: create
//     the thread, arm the watch, start the turn. Anything that goes wrong
//     there returns null, and the tick refunds the claim.
import { SCOPED_CLAIM_PROMPT } from "./system-prompt.ts";
import { exhausted, patchTask, type BoardTask } from "./task-board.ts";

/** Just enough of a BotRecord to decide a dispatch — a structural shape so
 * this module never has to import the store. */
export interface DispatchBot {
  id: string;
  name: string;
  busy?: boolean;
  hidden?: boolean;
}

export interface BotDispatchDeps<Bot extends DispatchBot> {
  /** features.board, read live. */
  boardEnabled: () => boolean;
  bot: (botId: string) => Bot | null | undefined;
  /** The bot's resolved approval mode for an unattended turn. */
  approvalMode: (bot: Bot) => string;
  /** A detached thread for the task's turn to run in (store.createTask). */
  createRunThread: (bot: Bot, title: string) => { threadId: string } | null;
  startTurn: (
    bot: Bot,
    prompt: string,
    opts: { threadId: string; unattended: true; onDispatchError: (message: string) => void },
  ) => Promise<unknown>;
  /** Arm the turn watch (task-turn-watch.ts) for this attempt. */
  watch: (taskId: string, threadId: string, botId: string) => void;
  /** Disarm a watch armed for a turn that then never started. */
  unwatch: (taskId: string) => void;
  /** Settle the task now, because the dispatch failed without the turn ever
   * emitting a completion event. */
  failWatch: (threadId: string, reason: string) => void;
  /** Every dispatch is a decision taken with nobody at the keyboard. */
  audit: (entry: { threadId: string; botId: string; botName: string; title: string }) => void;
  redact: (text: string) => string;
  log?: (message: string) => void;
  /** The money cap a task gets when it was filed without one: the
   * workspace's configured default, else a cap from the bot's own history
   * (task-board.ts suggestedBudgetUsd); null = no cap. Read live. */
  defaultBudgetUsd?: (task: BoardTask) => number | null;
}

export interface BotDispatch {
  canDispatch(task: BoardTask): boolean;
  /** Why an ASSIGNED task will not run as things stand, in words a bot or a
   * person can act on — or null when nothing durable is in the way.
   * Momentary states (the bot is busy) and choices (unassigned, at its cap,
   * blocked) are not holds; those already show on the task itself. */
  hold(task: BoardTask): string | null;
  dispatch(task: BoardTask): Promise<{ threadId: string } | null>;
}

/** What a board-dispatched turn actually sees. There is no task_complete
 * or task_block tool in this scope yet — a bot cannot report progress on
 * a board task from inside its own turn — so this is deliberately honest
 * about that instead of promising a tool that is not wired up. */
export function boardTaskPrompt(task: Pick<BoardTask, "title" | "body">): string {
  const detail = task.body.trim() ? `\n\n${task.body.trim()}` : "";
  return `A task was filed on the shared task board: "${task.title}"${detail}\n\n${SCOPED_CLAIM_PROMPT.trim()}`;
}

export function createBotDispatch<Bot extends DispatchBot>(deps: BotDispatchDeps<Bot>): BotDispatch {
  /** The whole eligibility rule, in one synchronous pass. Returns the bot so
   * dispatch() can re-run the same check without duplicating it. */
  function eligible(task: BoardTask): Bot | null {
    if (!deps.boardEnabled()) return null;
    // Unassigned work waits for a human to assign it (PATCH /api/tasks/:id);
    // the dispatcher never guesses a recipient.
    if (!task.assigneeBotId) return null;
    // A task at its money cap never runs again until a person raises the
    // cap (Phase 2 part 1); declining here costs no attempt.
    if (exhausted(task)) return null;
    const bot = deps.bot(task.assigneeBotId);
    if (!bot || bot.busy || bot.hidden) return null;
    // The capability rule: this dispatch happens with nobody at the
    // keyboard, so only a bot whose resolved approval mode is "auto" — the
    // one mode built to keep working instead of stopping to ask, see
    // BotRecord.autoApprove in store.ts — may take it. Ask, Edits, Full,
    // Custom, a pending approvalGrant, or a driver that cannot even offer
    // Auto (supportsApprovalMode) all resolve to something other than
    // "auto" here, and all of them would leave the task stuck on its first
    // permission card with nobody able to answer it.
    if (deps.approvalMode(bot) !== "auto") return null;
    return bot;
  }

  async function dispatch(input: BoardTask): Promise<{ threadId: string } | null> {
    let task = input;
    // Re-checked rather than trusted from canDispatch: an await elsewhere in
    // the tick may have let the bot go busy since.
    const bot = eligible(task);
    if (!bot) return null;
    // Board work runs with nobody at the keyboard, so a task filed without
    // a cap gets the unattended default before it spends anything.
    const fallbackCap = deps.defaultBudgetUsd?.(task) ?? null;
    if (task.budgetUsd === null && fallbackCap !== null && fallbackCap > 0) {
      task = patchTask(task.id, { budgetUsd: fallbackCap });
    }
    const runThread = deps.createRunThread(bot, task.title);
    if (!runThread) return null;
    const threadId = runThread.threadId;
    // Armed BEFORE the turn starts, not after. The task is already claimed
    // ("running") by the time this callback runs, so watching first closes
    // the window in which it is claimed but unwatched — and it is what lets
    // onDispatchError settle the task at all: a dispatch that fails inside
    // startTurn's un-awaited setup never emits turn.completed, so without
    // this the task would sit in "running" until a stale sweep found it.
    deps.watch(task.id, threadId, bot.id);
    try {
      await deps.startTurn(bot, boardTaskPrompt(task), {
        threadId,
        unattended: true,
        onDispatchError: (message) => deps.failWatch(threadId, deps.redact(message)),
      });
    } catch (error) {
      // Busy, budget, thread-limit, a mid-reload fleet — try again next
      // tick rather than taking the whole tick down. No turn started, so the
      // watch is disarmed and the tick refunds the claim.
      deps.unwatch(task.id);
      const message = error instanceof Error ? error.message : String(error);
      deps.log?.(`board: could not start bot ${bot.id} on task ${task.id}: ${deps.redact(message)}`);
      return null;
    }
    // Every dispatch is a decision, audited fire-and-forget exactly like
    // any other unattended approval (server/decision-log.ts).
    deps.audit({ threadId, botId: bot.id, botName: bot.name, title: task.title });
    return { threadId };
  }

  function hold(task: BoardTask): string | null {
    if (!task.assigneeBotId) return null;
    const bot = deps.bot(task.assigneeBotId);
    if (!bot) return "its assignee bot no longer exists — assign it to another bot";
    if (bot.hidden) return `${bot.name} is hidden — unhide it or assign the task to another bot`;
    const mode = deps.approvalMode(bot);
    if (mode !== "auto") {
      return `${bot.name} is on the "${mode}" approval setting; the board only runs tasks for a bot set to "Approve for me" (Auto), because nobody is at the keyboard to answer a permission card. Change ${bot.name}'s approval setting, or assign the task to a bot on Auto.`;
    }
    return null;
  }

  return { canDispatch: (task) => eligible(task) !== null, hold, dispatch };
}
