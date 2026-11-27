// A bot on a chat-only model (openai-compat and the other chat engines) has no shell of its own, and on My Cloud nothing
// gives it one by default: vm_exec is left out there (drivers/agents-catalog.ts), the chat runtime has only the tools its
// MCP servers bring, and the cloud desktop's exec is mounted only on a turn whose place is the cloud desktop. Left to
// itself such a bot explained a script it could not run in its own words ("no execution environment was mounted") and
// the run read as fine. So the app says it: the turn's context states the real reason (or, on a turn that may move, that
// the cloud desktop runs commands), a routine run that tried a command ends with the app's own sentence, once per routine
// and model, and switching a bot to such a model says once, in its chat, what that takes away. Each sentence shows only
// where it is true; anything less certain shows nothing. Team Clouds and the desktop app are left as they were.
import { readRunReply } from "../automation-reports.ts";
import { serverLine } from "../server-lines.ts";

/** What a turn has for running commands, as it is about to start. */
export interface TurnReach {
  /** The engine runs commands itself (its own folder and shell: workspace.ts supportsWorkspaceFiles). */
  ownShell: boolean;
  /** A cloud desktop or VPS is mounted for this turn, whose tools include exec. */
  computerMounted: boolean;
  /** This turn has shared_computer, so a computer the person lends could run a command for it. */
  sharedTools: boolean;
  /** This turn may move its request with select_computer (a person's own request, not a hand-off or a run). */
  canSelect: boolean;
}

/** For the model only (English, as every prompt part). */
export function noTerminalPrompt(input: { model: string; cloudDesktop: boolean; routine: boolean }): string {
  const why = ` You can't run commands this turn: on My Cloud this model (${input.model}) has no terminal of its own, and no cloud desktop is in use. Nothing is broken.`;
  if (input.routine) return `${why} Do the parts that need no command and say which step was not done, without giving a reason for it.`;
  return `${why} If the work needs a command, don't try another way or give another reason: say ${input.model} can't run commands on My Cloud, and that a model with a terminal, such as Claude or Codex${input.cloudDesktop ? ", or the cloud desktop," : ""} can.`;
}

/** For a turn that may move to the cloud desktop: the way to run a command is to go there. */
export function selectCloudPrompt(model: string): string {
  return ` This turn has no terminal: on My Cloud this model (${model}) can't run commands itself. To run one, call select_computer with surface "cloud": the request moves to the cloud desktop, where exec runs it.`;
}

/** A shell tool by the names models reach for, bare or behind the prefix of the server that has one (computer_exec,
 * mcp__computer__exec, agents_vm_exec). */
const COMMAND_TOOL = /^(?:computer_|agents_|vm_)?(?:exec|vm_exec|bash|sh|zsh|shell|terminal|run_command|run_shell|run_script|execute_command|python3?|powershell)$/iu;
/** What the chat runtime answers a call to a tool this turn was not given (drivers/chat-mcp-tools.ts). */
const NOT_OFFERED = "not advertised for this turn";
const lastPart = (name: string) => name.trim().split(/__|\.|\s/u).filter(Boolean).at(-1) ?? "";

/** The rule for the app's sentence: the bot called a shell tool and it was refused because this turn has none (the
 * runtime's own "not advertised" answer, so an app's tool that merely shares a name and failed for its own reason, or a
 * command that ran and failed, never counts). */
export function triedCommand(tool: { name?: string; ok?: boolean; output?: string } | undefined): boolean {
  if (!tool?.name || tool.ok !== false) return false;
  return COMMAND_TOOL.test(lastPart(tool.name)) && (tool.output ?? "").includes(NOT_OFFERED);
}

type Line = { role?: string; kind?: string; at?: number; text?: string; tool?: { name?: string; ok?: boolean; output?: string } };
type Run = { routineId: string; threadId?: string; startedAt?: number; status?: string };
type Selection = { instanceId: string; model?: string };

export interface NoTerminalDeps<Bot> {
  /** A personal Cloud home (My Cloud). */
  cloudHome: boolean;
  /** The cloud desktop is a place this bot (as its turn runs it) may use now: Computer access is on, its tool scope and
   * the managed policy allow it, its model can work there, and one is set up. */
  cloudDesktop?(bot: Bot): boolean;
  /** The lines of a conversation, oldest first. */
  lines(threadId: string): readonly Line[];
  /** A routine run by its id. */
  run?(runId: string): Run | undefined;
  /** A computer the person lends lends its terminal, online or not: whatever happens then is that computer's to say. */
  lentTerminal?(): boolean;
  /** For a model switch: the engine a selection runs on (its model's name, and whether it has a shell of its own). */
  engine?(selection: Selection): { model: string; shell: boolean } | undefined;
  /** The bot's name and the folder it was set to work in, if any. */
  bot?(botId: string): { name: string; cwd?: string } | undefined;
  /** The bot's routines, paused ones too. */
  routines?(botId: string): ReadonlyArray<{ runOn?: string; modelSelection?: Selection }>;
  /** With no computer of its own and no lent terminal, the bot's work runs where no command can (turnSurfacePlan): not
   * on the cloud desktop it works on, a VPS on Auto, a team's computer, or (with `threadId`) a chat pinned there. */
  noComputer?(botId: string, threadId?: string): boolean;
  language?(threadId: string): string | undefined;
  /** Writes the app's own one line into a conversation. */
  notice?(threadId: string, text: string): void;
}

const FLAGS_KEPT = 2_000;

export function createNoTerminal<Bot>(deps: NoTerminalDeps<Bot>) {
  /** Conversations whose latest turn started with no way to run commands, with the model and place that turn had. */
  const flagged = new Map<string, { at: number; model: string; cloudDesktop: boolean }>();
  /** Routine and model pairs the app has said it for, so a routine that runs every hour says it once. */
  const said = new Set<string>();

  /** The app's sentence for a run, null unless a turn of it had no way to run commands, the bot then tried one, its
   * reply says something, and this routine on this model was not told before. */
  const noteFor = (run: Run, language: string | undefined): { key: string; text: string } | null => {
    const turn = run.threadId ? flagged.get(run.threadId) : undefined, started = run.startedAt ?? 0;
    if (!turn || turn.at < started || said.has(`${run.routineId}\0${turn.model}`)) return null;
    const lines = deps.lines(run.threadId!).filter((line) => (line.at ?? Number.POSITIVE_INFINITY) >= started);
    if (!lines.some((line) => line.kind === "activity" && triedCommand(line.tool))) return null;
    const key = turn.cloudDesktop ? "server.reach.runNoTerminalCloud" : "server.reach.runNoTerminal";
    return { key: `${run.routineId}\0${turn.model}`, text: serverLine(language, key, { model: turn.model }) };
  };

  return {
    /** A turn is starting: its context line, empty when it can run commands or this is not My Cloud. */
    turn(threadId: string, bot: Bot, reach: TurnReach, prompt: { model: string; routine: boolean }, now = Date.now()): string {
      flagged.delete(threadId);
      if (!deps.cloudHome || reach.ownShell || reach.computerMounted || (reach.sharedTools && deps.lentTerminal?.())) return "";
      const cloudDesktop = deps.cloudDesktop?.(bot) === true;
      if (reach.canSelect && cloudDesktop) return selectCloudPrompt(prompt.model);
      flagged.set(threadId, { at: now, model: prompt.model, cloudDesktop });
      // Newest last: the oldest conversations' flags go first, long after any run of theirs was reported.
      for (const oldest of flagged.keys()) { if (flagged.size <= FLAGS_KEPT) break; flagged.delete(oldest); }
      return noTerminalPrompt({ ...prompt, cloudDesktop });
    },
    /** The app's line under a run's line (automation-reports.ts notes): under its reply, or under the line saying it
     * failed. It never makes a line by itself: a completed run that said nothing gets none, so the person is never
     * pushed the note alone. */
    notes: {
      has: (_runId: string): boolean => false,
      take(runId: string, language: string | undefined): string | null {
        const run = deps.run?.(runId), note = run ? noteFor(run, language) : null;
        if (!run?.threadId || !note) return null;
        const reply = deps.lines(run.threadId).findLast((line) => line.role === "bot" && line.kind === "text" && (line.at ?? 0) >= (run.startedAt ?? 0));
        if (run.status !== "failed" && readRunReply(reply?.text ?? "").quiet) return null;
        said.add(note.key);
        return note.text;
      },
    },
    /** A model switch, from `before` to `after`, seen in `threadId`. `routinesFollow`: the bot's own model changed, so its
     * routines run on the new one; otherwise only this chat's did. */
    modelSwitched(botId: string, threadId: string, before: Selection, after: Selection, routinesFollow: boolean): void {
      if (!deps.cloudHome || (before.instanceId === after.instanceId && before.model === after.model)) return;
      const bot = deps.bot?.(botId), was = deps.engine?.(before), now = deps.engine?.(after);
      if (!bot || !now || now.shell || deps.lentTerminal?.()) return;
      // Where the bot (or this chat) works on the cloud desktop, a VPS or a team's computer, exec is still there.
      if (!deps.noComputer?.(botId, threadId) || (routinesFollow && !deps.noComputer(botId))) return;
      // A routine on the cloud desktop has exec there; one with a model of its own keeps that model.
      const routines = routinesFollow ? (deps.routines?.(botId) ?? []).filter((routine) => routine.runOn !== "cloud" && !routine.modelSelection).length : 0;
      const text = modelSwitchNotice({ bot: bot.name, model: now.model, hadShell: was?.shell === true, sameEngine: before.instanceId === after.instanceId,
        ownFolder: Boolean(bot.cwd), routines, chatOnly: !routinesFollow }, deps.language?.(threadId));
      if (text) deps.notice?.(threadId, text);
    },
  };
}

export type NoTerminal = ReturnType<typeof createNoTerminal>;

/** The line a switch to a model with no terminal shows once, where the bot's work has no computer to run commands on;
 * null when the switch takes nothing away: from another model of the same chat engine, or with nothing to run. */
export function modelSwitchNotice(input: {
  bot: string; model: string; hadShell: boolean; sameEngine: boolean; ownFolder: boolean; routines: number; chatOnly: boolean;
}, language: string | undefined): string | null {
  if (input.sameEngine && !input.hadShell) return null;
  if (input.chatOnly) return input.hadShell || input.ownFolder ? serverLine(language, "server.reach.modelNoTerminalChat", { model: input.model }) : null;
  if (input.routines > 0) {
    return serverLine(language, input.routines === 1 ? "server.reach.modelNoTerminalRoutine" : "server.reach.modelNoTerminalRoutines", { model: input.model, bot: input.bot, count: input.routines });
  }
  return input.hadShell || input.ownFolder ? serverLine(language, "server.reach.modelNoTerminal", { model: input.model, bot: input.bot }) : null;
}
