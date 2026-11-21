// A bot on a chat-only model (openai-compat and the other chat engines) has no shell of its own, and on a Cloud home
// nothing gives it one by default: vm_exec is left out there (drivers/agents-catalog.ts), the chat runtime has only the
// tools its MCP servers bring, and the cloud computer's exec is mounted only on a turn whose place is the cloud computer.
// Left to itself such a bot explains a script it could not run in its own words ("no execution environment was
// mounted") and the run reads as fine. So the app says it instead: the turn's context states the real reason, a
// routine run that tried and failed to run a command ends with the app's own sentence, and switching a bot to such a
// model says once, in its chat, what its routines will no longer do.
import { serverLine } from "../server-lines.ts";

/** What a turn has for running commands, as the turn is about to start. */
export interface TurnReach {
  /** This server is a Cloud home (My Cloud). */
  cloudHome: boolean;
  /** The engine runs commands itself (it works in its own folder with its own shell: workspace.ts supportsWorkspaceFiles). */
  ownShell: boolean;
  /** A cloud computer or VPS is mounted for this turn, whose tools include exec. */
  computerMounted: boolean;
  /** A computer the person lends My Cloud is online, lent, lends its terminal, and this turn has the shared_computer tools. */
  lentTerminal: boolean;
}

/** Only a Cloud home: on the desktop app a chat model still has the Local VM's vm_exec or this computer's own tools. */
export function cannotRunCommands(reach: TurnReach): boolean {
  return reach.cloudHome && !reach.ownShell && !reach.computerMounted && !reach.lentTerminal;
}

/** The turn's own words for it, for the model only (English, as every prompt part). `cloudComputer`: this model can
 * work on the cloud computer and one is set up, so it is a real way out; otherwise it is never offered. */
export function noTerminalPrompt(input: { bot: string; model: string; cloudComputer: boolean; routine: boolean }): string {
  const ways = `switch ${input.bot} to a model with a terminal, such as Claude or Codex${input.cloudComputer ? ", or have the work run on the cloud computer" : ""}`;
  return ` You cannot run commands this turn. You are on My Cloud, where this model (${input.model}) has no terminal of its own, and no cloud computer is mounted for this turn, so no program, script or shell command can run here.`
    + " This is how this bot is set up, not a fault: nothing is broken, and files in your working folder on My Cloud are still there."
    + ` When the work needs a command, do not look for another way to run it and do not give another reason (a missing execution environment, an empty or new computer, lost files): say in one sentence that ${input.model} can't run commands on My Cloud, and that the person can ${ways}.`
    + (input.routine ? " This is a routine run: do the parts that need no command, then say plainly which step was not done and why, in those words." : "");
}

/** A shell tool by the names models reach for, bare or behind the prefix of the server that has one (computer_exec,
 * mcp__computer__exec, agents_vm_exec). */
const COMMAND_TOOL = /^(?:computer_|agents_|vm_)?(?:exec|vm_exec|bash|sh|zsh|shell|terminal|run_command|run_shell|run_script|execute_command|python3?|powershell)$/iu;
const SELECT_COMPUTER = /(?:^|_)select_computer$/iu;
/** What the chat runtime answers a call to a tool this turn was not given (drivers/chat-mcp-tools.ts). */
const NOT_OFFERED = "not advertised for this turn";
const lastPart = (name: string) => name.trim().split(/__|\.|\s/u).filter(Boolean).at(-1) ?? "";

/** The rule for the app's sentence: the bot tried to run a command and nothing here could. It is either a call to a
 * shell tool that was refused because this turn has none (the runtime's own "not advertised" answer, so an app's tool
 * that merely shares a name and failed for its own reason never counts), or a refused select_computer asking to move
 * somewhere other than the built-in browser, which a routine run may not do. */
export function triedCommand(tool: { name?: string; ok?: boolean; input?: string; output?: string } | undefined): boolean {
  if (!tool?.name || tool.ok !== false) return false;
  const name = lastPart(tool.name);
  if (SELECT_COMPUTER.test(name)) return !/browser/iu.test(tool.input ?? "");
  return COMMAND_TOOL.test(name) && (tool.output ?? "").includes(NOT_OFFERED);
}

type Activity = { kind?: string; at?: number; tool?: { name?: string; ok?: boolean; input?: string; output?: string } };
type Run = { threadId?: string; startedAt?: number };

export interface NoTerminalDeps {
  /** A personal Cloud home (My Cloud); a team's Cloud and the desktop app are left as they are. */
  cloudHome: boolean;
  /** The lines of a conversation, oldest first. */
  lines(threadId: string): readonly Activity[];
  /** A routine run by its id: the conversation it works in, and when its current attempt started. */
  run?(runId: string): Run | undefined;
  /** For a model switch: the engine a selection runs on (its model's name, and whether it has a shell of its own). */
  engine?(selection: Selection): { model: string; shell: boolean } | undefined;
  /** The bot's name and the folder it was set to work in, if any. */
  bot?(botId: string): { name: string; cwd?: string } | undefined;
  /** The bot's routines, paused ones too: each runs on this model once it runs. */
  routines?(botId: string): ReadonlyArray<{ runOn?: string; modelSelection?: Selection }>;
  language?(threadId: string): string | undefined;
  /** Writes the app's own one line into a conversation. */
  notice?(threadId: string, text: string): void;
}

type Selection = { instanceId: string; model?: string };

const FLAGS_KEPT = 2_000;

export function createNoTerminal(deps: NoTerminalDeps) {
  /** Conversations whose latest turn started with no way to run commands: when, and the bot and model that turn ran
   * (a routine or a conversation can have a model of its own, so never the bot's default read later). */
  const flagged = new Map<string, { at: number; bot: string; model: string; cloudComputer: boolean }>();
  const host = {
    /** A turn is starting: its context line, empty when it can run commands. */
    turn(threadId: string, reach: Omit<TurnReach, "cloudHome">, prompt: { bot: string; model: string; cloudComputer: boolean; routine: boolean }, now = Date.now()): string {
      if (!cannotRunCommands({ ...reach, cloudHome: deps.cloudHome })) { flagged.delete(threadId); return ""; }
      flagged.delete(threadId);
      flagged.set(threadId, { at: now, bot: prompt.bot, model: prompt.model, cloudComputer: prompt.cloudComputer });
      // Newest last: the oldest conversations' flags go first, long after any run of theirs was reported.
      for (const oldest of flagged.keys()) { if (flagged.size <= FLAGS_KEPT) break; flagged.delete(oldest); }
      return noTerminalPrompt(prompt);
    },
    /** The app's sentence a routine run's line in its results chat ends with, in that chat's language; null unless a turn
     * of this run had no way to run commands and the bot then tried to run one (triedCommand). */
    runNote(run: Run, language: string | undefined): string | null {
      if (!run.threadId) return null;
      const turn = flagged.get(run.threadId);
      const started = run.startedAt ?? 0;
      if (!turn || turn.at < started) return null;
      if (!deps.lines(run.threadId).some((line) => line.kind === "activity" && (line.at ?? Number.POSITIVE_INFINITY) >= started && triedCommand(line.tool))) return null;
      return serverLine(language, turn.cloudComputer ? "server.reach.runNoTerminalCloud" : "server.reach.runNoTerminal", { bot: turn.bot, model: turn.model });
    },
    forget(threadId: string): void { flagged.delete(threadId); },
    /** The app's line under a run's reply, as automation-reports.ts takes it: taken once, whatever the bot wrote. */
    notes: {
      has(runId: string): boolean {
        const run = deps.run?.(runId);
        return Boolean(run && host.runNote(run, undefined));
      },
      take(runId: string, language: string | undefined): string | null {
        const run = deps.run?.(runId), note = run ? host.runNote(run, language) : null;
        if (note && run?.threadId) flagged.delete(run.threadId);
        return note;
      },
    },
    /** A model switch, from `before` to `after`, seen in `threadId`: says there, once, what it takes away. `routinesFollow`:
     * the bot's own model changed, so its routines run on the new one. */
    modelSwitched(botId: string, threadId: string, before: Selection, after: Selection, routinesFollow: boolean): void {
      if (!deps.cloudHome || (before.instanceId === after.instanceId && before.model === after.model)) return;
      const bot = deps.bot?.(botId), was = deps.engine?.(before), now = deps.engine?.(after);
      if (!bot || !now) return;
      // A routine on the cloud computer has exec there; one with a model of its own keeps that model.
      const routines = routinesFollow ? (deps.routines?.(botId) ?? []).filter((routine) => routine.runOn !== "cloud" && !routine.modelSelection).length : 0;
      const text = modelSwitchNotice({ cloudHome: true, bot: bot.name, model: now.model, hadShell: was?.shell === true, hasShell: now.shell,
        sameEngine: before.instanceId === after.instanceId, ownFolder: Boolean(bot.cwd), routines }, deps.language?.(threadId));
      if (text) deps.notice?.(threadId, text);
    },
  };
  return host;
}

export type NoTerminal = ReturnType<typeof createNoTerminal>;

/** A bot's model is changing on a Cloud home: the line its chat shows once, or null when the switch takes nothing away.
 * It matters only when the new model has no terminal and the bot was last on one that had, has a working folder of its
 * own, or has routines that will run on this model (not one on the cloud computer, nor one with a model of its own). */
export function modelSwitchNotice(input: {
  cloudHome: boolean; bot: string; model: string; hadShell: boolean; hasShell: boolean; sameEngine: boolean; ownFolder: boolean; routines: number;
}, language: string | undefined): string | null {
  if (!input.cloudHome || input.hasShell) return null;
  if (input.sameEngine && !input.hadShell) return null;
  if (input.routines > 0) {
    return serverLine(language, input.routines === 1 ? "server.reach.modelNoTerminalRoutine" : "server.reach.modelNoTerminalRoutines", { model: input.model, bot: input.bot, count: input.routines });
  }
  return input.hadShell || input.ownFolder ? serverLine(language, "server.reach.modelNoTerminal", { model: input.model, bot: input.bot }) : null;
}
