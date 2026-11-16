import type { Routine, RoutineManager, RoutineRun } from "../routines.ts";
import type { BotRecord, Store, TaskRecord } from "../store.ts";
import { liveCardKind } from "../../shared/live-approval.ts";
import { routineRunNeedsReview, waitingCardText } from "../automation-reports.ts";
import { messageFileTargets } from "../message-file.ts";
import type { Coordinator } from "../coordinator.ts";

const DAY = 24 * 60 * 60 * 1000;

export function createRoutineRetention(deps: {
  paused: () => boolean;
  retentionDays: () => number | undefined;
  routines: () => RoutineManager | null;
  store: Store;
  botWaits: { all(): { threadId: string }[] };
  neededByChecks: (run: RoutineRun, routines: readonly Routine[]) => boolean;
  threadBusy: (botId: string, threadId: string) => boolean;
  settlingTurns: ReadonlySet<string>;
  coordinator: Pick<Coordinator, "activeDirect" | "awaitingAnswer" | "awaitingTeammateThreads">;
  phoneSecretSubmissions: { hasThread(threadId: string): boolean };
  hasQueuedSteeredMessages: (botId: string, threadId: string) => boolean;
  openPersonCard: (threadId: string) => unknown;
  unreadForAnyone: (task: TaskRecord) => boolean;
  deleteTasks: (botId: string, threadIds: string[]) => { deleted: string[] } | null;
}) {
  return () => {
    try {
      if (deps.paused()) return;
      const retentionDays = deps.retentionDays();
      const routines = deps.routines();
      if (retentionDays === undefined || !routines) return;
      const awaitingTeammates = deps.coordinator.awaitingTeammateThreads();
      const result = sweepRoutineExecutions({
        retentionDays, routines, store: deps.store, referencedThreads: new Set(deps.botWaits.all().map((wait) => wait.threadId)), neededByChecks: deps.neededByChecks,
        busy: (botId, threadId) => deps.threadBusy(botId, threadId) || deps.settlingTurns.has(threadId) ||
          deps.coordinator.activeDirect(threadId) || deps.coordinator.awaitingAnswer(threadId) || awaitingTeammates.has(threadId) ||
          deps.phoneSecretSubmissions.hasThread(threadId) || deps.hasQueuedSteeredMessages(botId, threadId) || Boolean(deps.openPersonCard(threadId)),
        deleteTasks: deps.deleteTasks,
        unreadForAnyone: deps.unreadForAnyone,
      });
      if (result.deleted || result.compacted) {
        console.log(`[routine retention] removed ${result.deleted} execution thread(s), compacted ${result.compacted} run(s)`);
      }
    } catch (error) {
      console.warn(`routine retention sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}

export function sweepRoutineExecutions(deps: {
  retentionDays: number;
  routines: Pick<RoutineManager, "attachmentPaths" | "listRoutines" | "listRuns" | "compactScheduledRuns">;
  store: Pick<Store, "bots" | "bot" | "botByThread" | "taskByThread" | "messagesFor">;
  referencedThreads: ReadonlySet<string>;
  neededByChecks: (run: RoutineRun, routines: readonly Routine[]) => boolean;
  busy: (botId: string, threadId: string) => boolean;
  unreadForAnyone: (task: TaskRecord) => boolean;
  deleteTasks: (botId: string, threadIds: string[]) => { deleted: string[] } | null;
  now?: number;
}): { deleted: number; compacted: number } {
  // An unreadable routine store cannot prove that a detached thread is unreferenced.
  if (deps.routines.attachmentPaths() === null) return { deleted: 0, compacted: 0 };
  const cutoff = (deps.now ?? Date.now()) - deps.retentionDays * DAY;
  const runs = deps.routines.listRuns();
  const routines = deps.routines.listRoutines();
  const referenced = new Set(deps.referencedThreads);
  for (const owner of [...routines, ...runs]) {
    if (owner.sourceThreadId) referenced.add(owner.sourceThreadId);
    if (owner.resultsThreadId) referenced.add(owner.resultsThreadId);
  }
  const threadUses = new Map<string, number>();
  const newest = new Map<string, number>();
  const kept = new Set<string>();
  for (const run of runs) {
    if (run.threadId) threadUses.set(run.threadId, (threadUses.get(run.threadId) ?? 0) + 1);
    const count = newest.get(run.routineId) ?? 0;
    if (count < 5) kept.add(run.id);
    newest.set(run.routineId, count + 1);
  }
  const messages = new Map<string, Map<string, ReturnType<Store["messagesFor"]>>>();
  const linesFor = (threadId: string, runId: string) => {
    let byRun = messages.get(threadId);
    if (!byRun) {
      byRun = new Map();
      for (const message of deps.store.messagesFor(threadId)) {
        const id = message.automation?.runId ?? message.routineRun?.runId;
        if (id) byRun.set(id, [...(byRun.get(id) ?? []), message]);
      }
      messages.set(threadId, byRun);
    }
    return byRun.get(runId) ?? [];
  };
  const linesAreSafe = (lines: ReturnType<Store["messagesFor"]>) =>
    !lines.some((message) => message.automation?.needsYou || liveCardKind(message.card) || waitingCardText(message) ||
      (message.text && messageFileTargets(message.text, true).length));
  const resultIsSafe = (run: RoutineRun): boolean => {
    const bot = deps.store.bot(run.botId);
    const destination = run.resultsThreadId && deps.store.taskByThread(run.botId, run.resultsThreadId);
    if (!bot || bot.hidden || !destination || destination.routineRunId || run.resultsThreadId === run.threadId) return false;
    if (run.report?.state === "quiet") return true;
    const report = run.report;
    if (report?.state !== "posted" || report.threadId !== run.resultsThreadId) return false;
    const lines = linesFor(run.resultsThreadId!, run.id);
    return lines.some((message) => message.id === report.messageId) && linesAreSafe(lines);
  };
  const eligible = new Set<string>();
  const missing = new Set<string>();
  const deleting = new Map<string, Array<{ run?: RoutineRun; threadId: string }>>();
  const safeTask = (bot: BotRecord, task: TaskRecord) => {
    const threadId = task.threadId;
    return bot.threadId !== threadId && bot.mainThreadChoice !== threadId && !task.pinned && !task.pinnedMessageId &&
      !task.shared && !task.sharedChat && !task.archivedAt && !task.rewound && !task.askedAt && !task.setupRequest &&
      !(task.link && !task.linkAuto) && !(task.surface && task.surfaceSource !== "auto") &&
      !task.unread && !deps.unreadForAnyone(task) && !task.busy && !task.waitingForTeammates && !task.openAsks &&
      (task.updatedAt ?? task.createdAt) < cutoff && !deps.busy(bot.id, threadId) &&
      !deps.store.messagesFor(threadId).some((message) => liveCardKind(message.card) || waitingCardText(message) ||
        message.publishedPage?.state === "live" || message.attachments?.some((file) => file.kind !== "image" || !file.fromTool) ||
        (message.text && messageFileTargets(message.text, true).length));
  };
  const markForDeletion = (botId: string, threadId: string, run?: RoutineRun) => {
    const group = deleting.get(botId) ?? [];
    group.push({ run, threadId });
    deleting.set(botId, group);
  };
  for (const run of runs) {
    if (kept.has(run.id) || run.target !== "bot" || run.triggerSource !== "schedule" || run.status !== "completed" ||
      run.deliver === "brief" || run.checkKey || routineRunNeedsReview(run) || deps.neededByChecks(run, routines) ||
      (run.output && messageFileTargets(run.output, true).length) || !Number.isFinite(run.finishedAt) || run.finishedAt! >= cutoff ||
      (run.report?.state !== "posted" && run.report?.state !== "quiet")) continue;
    const threadId = run.threadId;
    if (!threadId) { eligible.add(run.id); continue; }
    if (referenced.has(threadId) || (threadUses.get(threadId) ?? 0) > 1) continue;
    const owner = deps.store.botByThread(threadId);
    if (!owner) { eligible.add(run.id); missing.add(threadId); continue; }
    if (!resultIsSafe(run)) continue;
    const task = deps.store.taskByThread(run.botId, threadId);
    if (!task || owner.id !== run.botId || task.routineRunId !== run.id || !safeTask(owner, task)) continue;
    markForDeletion(run.botId, threadId, run);
  }
  const runIds = new Set(runs.map((run) => run.id));
  for (const bot of deps.store.bots) {
    if (bot.hidden) continue;
    const destinations = new Set([bot.threadId, bot.mainThreadChoice, ...[...routines, ...runs]
      .filter((owner) => owner.botId === bot.id).flatMap((owner) => [owner.sourceThreadId, owner.resultsThreadId])]);
    const visibleDestinations = [...destinations].filter((id): id is string => Boolean(id && deps.store.taskByThread(bot.id, id) && !deps.store.taskByThread(bot.id, id)?.routineRunId));
    for (const task of bot.tasks ?? []) {
      const runId = task.routineRunId, threadId = task.threadId;
      if (!runId || runIds.has(runId) || referenced.has(threadId) || threadUses.has(threadId)) continue;
      const delivered = visibleDestinations.some((destination) => {
        const lines = linesFor(destination, runId);
        return lines.some((message) => message.role === "bot" && message.kind === "text" && Number.isFinite(message.at) && message.at < cutoff && message.automation?.trigger === "schedule" &&
          message.automation.executionThreadId === threadId && !message.automation.copyOf && !message.automation.failed && !message.automation.partial) && linesAreSafe(lines);
      });
      if (delivered && safeTask(bot, task)) markForDeletion(bot.id, threadId);
    }
  }
  let deleted = 0;
  for (const [botId, group] of deleting) {
    const removed = new Set(deps.deleteTasks(botId, group.map(({ threadId }) => threadId))?.deleted ?? []);
    for (const { run, threadId } of group) if (removed.has(threadId)) {
      deleted += 1;
      if (run) { eligible.add(run.id); missing.add(threadId); }
    }
  }
  return { deleted, compacted: deps.routines.compactScheduledRuns(eligible, missing) };
}
