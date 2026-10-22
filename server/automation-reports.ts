// A bot's automations report into the chat they belong to. A run still works in its own hidden conversation with a
// fresh session; when it ends with something to say, its last reply lands in that chat as one bot message named after
// the automation, and a run with nothing to tell writes nothing. A card a run waits on is copied there, and answering
// the copy answers the run. Nothing is written into a chat while a turn runs or settles in it: a line waits for the
// next flush, which the server runs whenever it releases what was queued behind a turn, ahead of that queue. A routine
// that delivers to the brief posts no line: its answer goes to the brief, which reads it as a small JSON result.
import { liveCardKind } from "../shared/live-approval.ts";
import type { AutomationLine } from "../shared/routine-run.ts";
import { needsInputQuestion } from "./runtime-coordinator.ts";
import type { RoutineManager, RoutineRun } from "./routines.ts";
import type { BotRecord, Message, Store } from "./store.ts";
import { hostTimeZone } from "./turn-clock.ts";

const QUIET = /^[\s*_`"'.!-]*nothing new[\s*_`"'.!-]*$/i;
const NEEDS_INPUT = /^\s*needs input:\s*/i;

export type RunReply = { quiet: true } | { quiet: false; text: string; question?: string };

/** What a run's last reply says to the person. Its last line alone being NOTHING NEW keeps the run quiet. */
export function readRunReply(text: string, attached = false): RunReply {
  const lines = text.trim().split(/\r?\n/);
  if (QUIET.test(lines.at(-1) ?? "") || (!text.trim() && !attached)) return { quiet: true };
  const question = needsInputQuestion(text);
  if (question === undefined) return { quiet: false, text: text.trim() };
  const at = lines.findLastIndex((line) => NEEDS_INPUT.test(line));
  return { quiet: false, text: [...lines.slice(0, at), lines[at]!.replace(NEEDS_INPUT, ""), ...lines.slice(at + 1)].join("\n").trim(), question };
}

function localTime(at: number): string {
  const format = (timeZone: string) => new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(at).replace(",", "");
  try { return format(hostTimeZone()); } catch { return format("UTC"); }
}

/** How the chat's own session reads an automation's line: as its own report, named and dated. */
export function automationContextText(line: AutomationLine, at: number, text: string): string {
  const what = line.failed ? "could not finish" : line.needsYou ? "asked" : "reported";
  return `[Your automation ${JSON.stringify(line.name)} ${what} at ${localTime(at)}:]\n${text}`;
}

/** A sign-in, connection or credential card still waiting on the person, in plain words; null once it is settled. */
export function waitingCardText(message: Pick<Message, "kind" | "signIn" | "connector" | "secret">): string | null {
  const { signIn, connector, secret } = message;
  if (message.kind === "signin" && signIn && !signIn.done && !signIn.cancelled && !signIn.superseded && !signIn.resumed && !signIn.stopped) {
    const reason = signIn.reason?.trim();
    return `I need you to sign in to ${signIn.site}${reason ? `: ${reason}${/[.!?]$/.test(reason) ? "" : "."}` : "."}`;
  }
  if (message.kind === "connector" && connector && connector.status !== "connected" && !connector.dismissed && !connector.resumed && !connector.stopped) {
    return `I need you to connect ${connector.label}.`;
  }
  if (message.kind === "secret" && secret && !secret.provided && !secret.dismissed && !secret.superseded && !secret.resumed && !secret.stopped) {
    return `I need your ${secret.label}.`;
  }
  return null;
}

/** The newest line of each automation: whatever else is dropped for room, the chat's session always gets these. */
export function newestAutomationLines(messages: readonly Pick<Message, "id" | "automation">[]): Set<string> {
  const newest = new Map<string, string>();
  for (const message of messages) if (message.automation) newest.set(message.automation.routineId, message.id);
  return new Set(newest.values());
}

type Waiting =
  | { kind: "reply"; run: RoutineRun; messageId?: string }
  | { kind: "failure"; run: RoutineRun; detail: string }
  | { kind: "card"; run: RoutineRun; threadId: string; messageId: string };

export interface AutomationReportDeps {
  store: Pick<Store, "activePath" | "appendMessage" | "bot" | "botByThread" | "messagesFor" | "onChange" | "patchMessage" | "patchTask" | "taskByThread">;
  routines(): Pick<RoutineManager, "listRuns" | "noteReport" | "runForThread"> | null;
  /** A turn runs or settles in this conversation. */
  busy(botId: string, threadId: string): boolean;
  /** After a line this conversation's session did not write: it marks the chat unread and reaches the next turn. */
  wrote(bot: BotRecord, threadId: string): void;
  notify(kind: "done" | "question", bot: BotRecord, threadId: string, detail: string): void;
  /** A run that delivers to the brief completed: its answer is the brief's to read. */
  brief?(run: RoutineRun, turnId?: string): void;
}

export function createAutomationReports(deps: AutomationReportDeps) {
  const { store } = deps;
  const waiting = new Map<string, Waiting>();
  let resumed = false;
  let flushing = false;

  const destination = (run: RoutineRun): { bot: BotRecord; threadId: string } | null => {
    const bot = run.resultsThreadId && run.resultsThreadId !== run.threadId ? store.bot(run.botId) : undefined;
    const task = bot && !bot.hidden ? store.taskByThread(bot.id, run.resultsThreadId!) : undefined;
    return bot && task && !task.routineRunId ? { bot, threadId: task.threadId } : null;
  };

  const lineOf = (run: RoutineRun, extra: Pick<AutomationLine, "needsYou" | "failed" | "copyOf">): AutomationLine => ({
    routineId: run.routineId, runId: run.id, name: run.routineName, trigger: run.eventSource ?? run.triggerSource ?? (run.manual ? "manual" : "schedule"),
    executionThreadId: run.threadId!, scheduledFor: run.scheduledFor, ...extra,
  });

  /** The reply a run ends with: its last turn's last text, or after a restart the last one a turn settled on. */
  const replyOf = (run: RoutineRun, messageId?: string) => {
    const path = run.threadId ? store.activePath(run.threadId) : [];
    const said = (message: Message) => message.role === "bot" && message.kind === "text";
    return messageId ? path.find((message) => message.id === messageId) : path.findLast((message) => said(message) && message.turnTerminal) ?? path.findLast(said);
  };

  const read = (message: Message | undefined) => readRunReply(message?.text ?? "", Boolean(message?.attachments?.length));

  const copyOf = (run: RoutineRun, threadId: string, originalId: string) =>
    store.messagesFor(threadId).find((message) => message.automation?.runId === run.id && message.automation.copyOf === originalId);

  /** An option card is copied whole and answered through its request; any other card the run waits on is named. */
  const writeCopy = (line: Extract<Waiting, { kind: "card" }>, target: { bot: BotRecord; threadId: string }) => {
    const original = store.messagesFor(line.threadId).find((message) => message.id === line.messageId);
    const named = original ? waitingCardText(original) : null;
    if (!original || (!named && !liveCardKind(original.card))) return;
    const automation = lineOf(line.run, { needsYou: true, copyOf: original.id });
    store.appendMessage(target.threadId, named ? { role: "bot", kind: "text", text: named, automation } : { role: "bot", kind: "options", card: { ...original.card! }, automation });
    if (named) deps.wrote(target.bot, target.threadId);
    else store.patchTask(target.bot.id, target.threadId, { unread: true });
  };

  /** False while the chat it goes to is busy. */
  const write = (line: Waiting): boolean => {
    const { run } = line;
    const target = destination(run);
    if (!target) {
      if (line.kind !== "card") deps.routines()?.noteReport(run.id, undefined);
      return true;
    }
    if (deps.busy(target.bot.id, target.threadId)) return false;
    if (line.kind === "card") {
      writeCopy(line, target);
      return true;
    }
    const written = store.messagesFor(target.threadId).find((message) =>
      (message.automation?.runId === run.id && message.kind === "text" && !message.automation.copyOf) || message.routineRun?.runId === run.id);
    if (written) {
      deps.routines()?.noteReport(run.id, { state: "posted", threadId: target.threadId, messageId: written.id });
      return true;
    }
    const source = line.kind === "reply" ? replyOf(run, line.messageId) : undefined;
    const reply: RunReply = line.kind === "reply" ? read(source)
      : { quiet: false, text: line.detail ? `This run didn't finish: ${line.detail}` : "This run didn't finish." };
    if (reply.quiet) {
      deps.routines()?.noteReport(run.id, { state: "quiet" });
      return true;
    }
    const posted = store.appendMessage(target.threadId, {
      role: "bot", kind: "text", text: reply.text,
      ...(source?.attachments?.length ? { attachments: source.attachments } : {}),
      automation: lineOf(run, line.kind === "failure" ? { failed: true } : reply.question ? { needsYou: true } : {}),
    });
    deps.routines()?.noteReport(run.id, { state: "posted", threadId: target.threadId, messageId: posted.id });
    deps.wrote(target.bot, target.threadId);
    if (line.kind === "reply") deps.notify(reply.question ? "question" : "done", target.bot, target.threadId, `${run.routineName}: ${reply.question ?? reply.text}`);
    return true;
  };

  const flush = () => {
    const manager = deps.routines();
    if (flushing || !manager) return;
    flushing = true;
    try {
      if (!resumed) {
        resumed = true;
        for (const run of manager.listRuns().reverse()) {
          if (run.report?.state !== "pending" || waiting.has(run.id)) continue;
          waiting.set(run.id, run.status === "failed" ? { kind: "failure", run, detail: run.error ?? "" } : { kind: "reply", run });
        }
      }
      for (const [key, line] of waiting) if (write(line)) waiting.delete(key);
    } finally {
      flushing = false;
    }
  };

  const hold = (key: string, line: Waiting) => {
    if (line.kind !== "card") deps.routines()?.noteReport(line.run.id, { state: "pending" });
    waiting.set(key, line);
    flush();
  };

  store.onChange((change) => {
    if (change.type !== "message" && change.type !== "message.patch") return;
    const { message } = change;
    const option = message.kind === "options" && Boolean(message.card?.requestId);
    if (message.automation || (!option && message.kind !== "signin" && message.kind !== "connector" && message.kind !== "secret")) return;
    const run = deps.routines()?.runForThread(change.threadId);
    const target = run?.target === "bot" && store.taskByThread(run.botId, change.threadId)?.routineRunId === run.id ? destination(run) : null;
    if (!run || !target) return;
    if (change.type === "message") {
      if (option ? !message.card!.autoApplied : waitingCardText(message)) {
        hold(`card:${message.id}`, { kind: "card", run, threadId: change.threadId, messageId: message.id });
      }
      return;
    }
    const copy = copyOf(run, target.threadId, message.id);
    if (!copy) return;
    if (option && JSON.stringify(copy.card) !== JSON.stringify(message.card)) store.patchMessage(target.threadId, copy.id, { card: { ...message.card! } });
    if (!option && copy.automation?.needsYou && !waitingCardText(message)) {
      const { needsYou: _settled, ...line } = copy.automation;
      store.patchMessage(target.threadId, copy.id, { automation: line });
    }
  });

  return {
    flush,
    /** A run's turn ended: once the run is complete, its reply becomes one line in the chat it reports to, or nothing. */
    runSettled(run: RoutineRun, turnId?: string): void {
      if (run.target !== "bot" || run.status !== "completed" || !run.threadId) return;
      if (run.deliver === "brief") return deps.brief?.(run, turnId);
      const said = turnId ? store.activePath(run.threadId).findLast((message) => message.role === "bot" && message.kind === "text" && message.turnId === turnId) : replyOf(run);
      const reply = read(said);
      const bot = store.bot(run.botId);
      if (reply.quiet) deps.routines()?.noteReport(run.id, { state: "quiet" });
      else if (destination(run)) hold(run.id, { kind: "reply", run, ...(said ? { messageId: said.id } : {}) });
      else if (bot) deps.notify("done", bot, run.threadId, reply.text);
    },
    /** A run failed in a way the person is told about: one line says so where its reports go. */
    runFailed(run: RoutineRun, detail: string): void {
      if (run.target === "bot" && run.status === "failed" && run.deliver !== "brief" && run.threadId && destination(run)) hold(run.id, { kind: "failure", run, detail });
    },
    /** This run's result, questions and failure come to its bot's chat as lines of their own. */
    speaksFor(run: RoutineRun): boolean {
      return run.target === "bot" && destination(run) !== null;
    },
    /** This conversation is a run's own, and only its last reply reaches the chat the run reports to. */
    reportsElsewhere(threadId: string): boolean {
      const run = deps.routines()?.runForThread(threadId);
      return run?.target === "bot" && run.deliver !== "brief" && destination(run) !== null;
    },
    /** Where an answer to this card goes: a copy of a run's card answers it in the run's own conversation. */
    answeredIn(threadId: string, requestId: string): string {
      const owner = store.botByThread(threadId);
      const execution = owner && store.messagesFor(threadId).find((message) => message.card?.requestId === requestId && message.automation)?.automation?.executionThreadId;
      return owner && execution && store.taskByThread(owner.id, execution) ? execution : threadId;
    },
  };
}

export type AutomationReports = ReturnType<typeof createAutomationReports>;
