// Bot task records: per-thread settings and usage, projects, activity
// aggregation, cwd pinning, and peer pair-conversation resolution.
import { newId, type ModelSelection } from "../contracts.ts";
import { approvalModeFor } from "../../shared/approval-mode.ts";
import type {
  BotActivity, BotProject as BotProjectRecord, TaskClosedBy, TaskOpenedBy, TaskUsage,
} from "../../shared/wire.ts";
import {
  ACTIVITY_BUSY, isProjectEmoji, TASK_PATCH_FIELDS, threadTitleFrom, titleFromMessage,
  UNTITLED_TASK, UNTITLED_THREAD, type BotRecord, type TaskPatch, type TaskRecord,
} from "./records.ts";
import type { StoreContext } from "./context.ts";
import { clearPendingThreadDeletions, flushPendingThreadDeletions, stagePendingThreadDeletions } from "./messages.ts";

export function tasks(ctx: StoreContext, botId: string): TaskRecord[] {
  return ctx.bot(botId)?.tasks ?? [];
}

export function activeTask(ctx: StoreContext, botId: string): TaskRecord | undefined {
  const record = ctx.bot(botId);
  return record?.tasks?.find((t) => t.threadId === record.threadId);
}

export function taskByThread(ctx: StoreContext, botId: string, threadId: string): TaskRecord | undefined {
  return ctx.bot(botId)?.tasks?.find((t) => t.threadId === threadId);
}

/** A turn gets an independent snapshot without changing the selected task
 * or mutating the bot's defaults while another turn is running. */
export function projectBotForTask(ctx: StoreContext, botId: string, threadId: string): BotRecord | null {
  const record = ctx.bot(botId);
  const task = ctx.taskByThread(botId, threadId);
  if (!record || !task) return null;
  return {
    ...record,
    threadId: task.threadId,
    approvalGrant: record.approvalGrant?.threadOnly && record.approvalGrant.threadId !== threadId ? undefined : record.approvalGrant,
    modelSelection: structuredClone(task.modelSelection ?? record.modelSelection),
    resumeCursors: structuredClone(task.resumeCursors),
    approvalMode: task.approvalMode ?? (task.autoApprove === undefined ? record.approvalMode : undefined),
    autoApprove: task.autoApprove ?? record.autoApprove,
    alwaysAllow: structuredClone(task.alwaysAllow ?? record.alwaysAllow),
    unread: Boolean(task.unread),
    rewound: task.rewound,
    pinnedMessageId: task.pinnedMessageId,
    activity: task.activity ?? "idle",
    busy: Boolean(task.busy),
  };
}

export function patchTask(ctx: StoreContext, botId: string, threadId: string, patch: TaskPatch): TaskRecord | null {
  const record = ctx.bot(botId);
  const task = ctx.taskByThread(botId, threadId);
  if (!record || !task) return null;
  if (patch.projectId !== undefined && !ctx.project(botId, patch.projectId)) return null;
  for (const key of TASK_PATCH_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      Object.assign(task, { [key]: structuredClone(patch[key]) });
    }
  }
  if (typeof patch.title === "string") task.title = patch.title.trim().slice(0, 80) || UNTITLED_THREAD;
  if (record.threadId === threadId) mirrorActiveTask(record, task);
  record.unread = record.tasks!.some((candidate) => candidate.unread);
  ctx.saveBots();
  ctx.emit({ type: "bot", botId });
  return task;
}

/** Model/provider changes are one configuration transaction: never publish
 * a new provider before its confirmed approval downgrade, or change the
 * default while leaving the selected thread behind after a write failure. */
export function switchTaskModel(ctx: StoreContext, botId: string, threadId: string, selection: ModelSelection,
  updateBotDefault: boolean, resetApprovalToAsk: boolean, taskPatch: TaskPatch = {}): TaskRecord | null {
  const record = ctx.bot(botId);
  const task = ctx.taskByThread(botId, threadId);
  if (!record || !task) return null;
  const patch = { modelSelection: structuredClone(selection),
    ...(resetApprovalToAsk ? { approvalMode: "ask" as const, autoApprove: false, alwaysAllow: [] } : {}) };
  const nextTask = { ...task, ...taskPatch, ...patch,
    ...(typeof taskPatch.title === "string" ? { title: taskPatch.title.trim().slice(0, 80) || UNTITLED_THREAD } : {}) };
  // Older threads may still inherit settings. Freeze their effective
  // values before updating the default so "other threads unchanged" also
  // holds for workspaces created before per-thread approval settings.
  const nextTasks = record.tasks!.map((candidate) => candidate === task ? nextTask : !updateBotDefault ? candidate : {
    ...candidate,
    modelSelection: structuredClone(candidate.modelSelection ?? record.modelSelection),
    approvalMode: approvalModeFor(ctx.projectBotForTask(botId, candidate.threadId)!),
    autoApprove: candidate.autoApprove ?? record.autoApprove,
    alwaysAllow: structuredClone(candidate.alwaysAllow ?? record.alwaysAllow ?? []),
  });
  const next = { ...record, ...(updateBotDefault ? patch : {}),
    tasks: nextTasks };
  ctx.saveBots(ctx.bots.map((candidate) => candidate === record ? next : candidate));
  record.tasks!.forEach((candidate, index) => Object.assign(candidate, nextTasks[index]));
  if (updateBotDefault) Object.assign(record, patch);
  ctx.emit({ type: "bot", botId });
  return task;
}

export function mirrorActiveTask(record: BotRecord, task: TaskRecord) {
  record.threadId = task.threadId;
  record.resumeCursors = structuredClone(task.resumeCursors);
  record.rewound = task.rewound;
  record.pinnedMessageId = task.pinnedMessageId;
}

/** The pure half of createTask: a fresh task row — new thread id, the
 * bot's current defaults, idle — with no store, save or emit side
 * effects, so mid-delete replacement rows can be built without
 * persisting or broadcasting anything. */
function newTaskRecord(record: BotRecord, title?: string, projectId?: string, openedBy?: TaskOpenedBy): TaskRecord {
  return {
    threadId: newId(),
    title: threadTitleFrom(title),
    createdAt: Date.now(),
    ...(projectId ? { projectId } : {}),
    ...(openedBy ? { openedBy: structuredClone(openedBy) } : {}),
    resumeCursors: {},
    modelSelection: structuredClone(record.modelSelection),
    approvalMode: approvalModeFor(record),
    autoApprove: Boolean(record.autoApprove),
    alwaysAllow: [...(record.alwaysAllow ?? [])],
    unread: false,
    activity: "idle",
    busy: false,
  };
}

/** A fresh context on the same bot: new thread, new session, same
 * persona/tools/computer. Becomes the active task. */
export function createTask(ctx: StoreContext, botId: string, title?: string, activate = true, projectId?: string, openedBy?: TaskOpenedBy): TaskRecord | null {
  const record = ctx.bot(botId);
  if (!record) return null;
  if (projectId !== undefined && !ctx.project(botId, projectId)) return null;
  const task = newTaskRecord(record, title, projectId, openedBy);
  record.tasks = [task, ...(record.tasks ?? [])];
  if (activate) {
    mirrorActiveTask(record, task);
  }
  ctx.saveBots();
  ctx.emit({ type: "bot", botId });
  return task;
}

/** Attach (or complete) the opener record after the thread exists — the
 * handoff id is only known once the thread it targets has an id, so a
 * peer-opened thread is created first and stamped second. Never reachable
 * from the HTTP task PATCH: openedBy is not a TASK_PATCH_FIELD. */
export function setTaskOpenedBy(ctx: StoreContext, botId: string, threadId: string, openedBy: TaskOpenedBy): TaskRecord | null {
  const record = ctx.bot(botId);
  const task = ctx.taskByThread(botId, threadId);
  if (!record || !task) return null;
  task.openedBy = structuredClone(openedBy);
  ctx.saveBots();
  ctx.emit({ type: "bot", botId });
  return task;
}

/** Stamp or clear the closer record. `null` reopens: the next turn in a
 * closed thread calls this so the row comes back to the sidebar. Never
 * reachable from the HTTP task PATCH: closedBy is not a TASK_PATCH_FIELD. */
export function setTaskClosedBy(ctx: StoreContext, botId: string, threadId: string, closedBy: TaskClosedBy | null): TaskRecord | null {
  const record = ctx.bot(botId);
  const task = ctx.taskByThread(botId, threadId);
  if (!record || !task) return null;
  if (closedBy) task.closedBy = structuredClone(closedBy);
  else if (!task.closedBy) return task;
  else delete task.closedBy;
  ctx.saveBots();
  ctx.emit({ type: "bot", botId });
  return task;
}

/** Where a bot-to-bot send outside a room lands: the PAIR CONVERSATION
 * for (sender, recipient) — the recipient's task stamped `openedBy` this
 * sender with kind "pair".
 *
 * Its scope is global for those two bots: deliberately not per source
 * thread and not per assignment, so a teammate you work with all day is
 * one readable row in the recipient's sidebar that remembers what was
 * asked last time, instead of one row per message. Nothing about the
 * caller's current turn takes part in choosing it — no dispatch
 * generation, no request key — and never the recipient's selected
 * thread, which belongs to the person.
 *
 * Two things bend that rule, both deliberately:
 *
 *   adoption — a recipient still carrying threads this sender opened
 *   before pair conversations existed (one per assignment, each titled
 *   with a sliced brief) has its most recently active one stamped as the
 *   pair conversation instead of gaining yet another row, so the sprawl
 *   stops on upgrade day. Nothing is deleted or closed. A start_thread
 *   handoff is left alone: the sender named that job itself and tracks
 *   it by its own delegation id.
 *
 *   concurrency — a second assignment arriving while the pair
 *   conversation is still working (`working`, which the caller answers
 *   from live turn state) gets its own work thread, so two jobs never
 *   interleave in one transcript. `label` names that thread; the caller
 *   closes it once its result has been reported. A pair conversation
 *   never auto-closes. */
export function resolvePairConversation(
  ctx: StoreContext,
  sender: Pick<BotRecord, "id" | "name">,
  recipientId: string,
  options: { label?: string; working: (threadId: string) => boolean },
): { task: TaskRecord; created: boolean } | null {
  if (!ctx.bot(recipientId)) return null;
  const title = `@${sender.name}`;
  const opener = (kind: "pair" | "work", at = Date.now()): TaskOpenedBy => ({ botId: sender.id, name: sender.name, kind, at });
  const fromSender = ctx.tasks(recipientId).filter((task) => task.openedBy?.botId === sender.id);
  let pair = fromSender.find((task) => task.openedBy?.kind === "pair");
  if (!pair) {
    const lastActivity = (task: TaskRecord) =>
      ctx.messagesTail(task.threadId, 1).messages.at(-1)?.at ?? task.openedBy?.at ?? task.createdAt;
    const adopted = fromSender
      .filter((task) => !task.openedBy?.kind && !task.openedBy?.delegationId && !task.closedBy)
      .sort((a, b) => lastActivity(b) - lastActivity(a))[0];
    if (adopted) {
      // Keep the hour it was really opened: list_threads and the sidebar
      // order by it, and adoption is not a new conversation.
      ctx.setTaskOpenedBy(recipientId, adopted.threadId, opener("pair", adopted.openedBy?.at ?? adopted.createdAt));
      // The title changes only when nobody typed it. The rule: rename it
      // when it still equals what createTask made of the assignment that
      // opened the thread — and that assignment is still the thread's
      // first message, "@Recipient <brief>" — so the comparison is
      // threadTitleFrom(that brief). Anything else is a name a person
      // chose, and a thread with no request to read (its handoff never
      // ran) cannot be checked, so both keep the title they have.
      if (adopted.title === openingRequestTitle(ctx, recipientId, adopted.threadId)) {
        ctx.renameTask(recipientId, adopted.threadId, title);
      }
      pair = adopted;
    }
  }
  if (pair && !options.working(pair.threadId)) {
    // A conversation the sender closed after reading a result is picked
    // back up, never replaced: closing is only the sidebar's idle state.
    if (pair.closedBy) ctx.setTaskClosedBy(recipientId, pair.threadId, null);
    return { task: pair, created: false };
  }
  // The brief is never a title. An 80-character slice of an assignment
  // is the row nobody can read, and a durable conversation outlives the
  // one brief that opened it.
  const task = ctx.createTask(recipientId, pair ? `${title} · ${options.label || "parallel work"}` : title,
    false, undefined, opener(pair ? "work" : "pair"));
  return task ? { task, created: true } : null;
}

/** The title a peer-opened thread was born with: what createTask made of
 * the request that opened it, which is still the first message in it,
 * addressed "@Recipient <brief>". null when there is no such message to
 * read — an unrun handoff proves nothing about who named the row. */
function openingRequestTitle(ctx: StoreContext, recipientId: string, threadId: string): string | null {
  const first = ctx.messagesFor(threadId)[0]?.text?.trim();
  if (!first) return null;
  const addressed = `@${ctx.bot(recipientId)?.name ?? ""} `;
  return threadTitleFrom(first.startsWith(addressed) ? first.slice(addressed.length) : first);
}

export function switchTask(ctx: StoreContext, botId: string, threadId: string): BotRecord | null {
  const record = ctx.bot(botId);
  const task = record?.tasks?.find((t) => t.threadId === threadId);
  if (!record || !task) return null;
  mirrorActiveTask(record, task);
  ctx.saveBots();
  ctx.emit({ type: "bot", botId });
  return record;
}

export function renameTask(ctx: StoreContext, botId: string, threadId: string, title: string): TaskRecord | null {
  return ctx.patchTask(botId, threadId, { title });
}

/** Name a task after its first message, once. */
/** Name a task after its first message, once. Returns the task it named
 * so a caller can later replace exactly that machine-made title — and
 * can see the peer provenance it must leave alone. */
export function titleTaskFromFirstMessage(ctx: StoreContext, botId: string, text: string, threadId?: string): TaskRecord | null {
  const task = threadId ? ctx.taskByThread(botId, threadId) : ctx.activeTask(botId);
  if (!task || task.titleFromFirstMessage || (task.title !== UNTITLED_TASK && task.title !== UNTITLED_THREAD)) return null;
  task.title = titleFromMessage(text);
  task.titleFromFirstMessage = true;
  ctx.saveBots();
  ctx.emit({ type: "bot", botId });
  return task;
}

/** Swap a machine-made first-message title for a generated one, once.
 * Equality against the snippet is the whole contract: a rename by the
 * person, by pair adoption, or by an earlier generated title each break
 * it, so this never overwrites a name anyone chose. */
export function retitleTask(ctx: StoreContext, botId: string, threadId: string, machineTitle: string, title: string): TaskRecord | null {
  const task = ctx.taskByThread(botId, threadId);
  if (!task || task.title !== machineTitle) return null;
  return ctx.renameTask(botId, threadId, threadTitleFrom(title));
}

/** Delete a task and its transcript, retaining generated project files.
 * When no visible tasks remain, replace it with a fresh conversation. */
export function deleteTask(ctx: StoreContext, botId: string, threadId: string): BotRecord | null {
  flushPendingThreadDeletions(ctx, botId);
  const record = ctx.bot(botId);
  if (!record?.tasks) return null;
  if (!record.tasks.some((t) => t.threadId === threadId)) return null;
  const snapshot = structuredClone(record);
  record.tasks = record.tasks.filter((t) => t.threadId !== threadId);
  // Durable before anything is built on the filtered list, so a crash
  // below leaves a retryable deletion.
  stagePendingThreadDeletions(botId, [threadId]);
  let visible = record.tasks.find((task) => !task.routineRunId);
  if (!visible) {
    // No visible conversation left: build the replacement row purely (no
    // save, no emit, no activation) — this function persists and notifies
    // exactly once, at the end.
    visible = newTaskRecord(record, undefined);
    record.tasks.unshift(visible);
  }
  if (record.threadId === threadId || ctx.taskByThread(botId, record.threadId)?.routineRunId) {
    mirrorActiveTask(record, visible);
  }
  record.unread = record.tasks.some((task) => task.unread);
  refreshBotActivity(ctx, record);
  try {
    ctx.saveBots();
  } catch (error) {
    // Roll the bot back so a failed save cannot leave a half-applied deletion for a later save to persist.
    Object.assign(record, snapshot);
    clearPendingThreadDeletions(botId, [threadId]);
    throw error;
  }
  ctx.deleteThreadRecord(threadId);
  clearPendingThreadDeletions(botId, [threadId]);
  ctx.emit({ type: "bot", botId });
  return record;
}

/** Legacy bot/room activity occupies its own slot; direct conversations
 * use setTaskActivity so settling one thread cannot clear another. */
export function setActivity(ctx: StoreContext, botId: string, activity: BotActivity): BotRecord | null {
  const record = ctx.bot(botId);
  if (!record) return null;
  if ((ctx.legacyActivities.get(botId) ?? "idle") === activity) return record;
  ctx.legacyActivities.set(botId, activity);
  refreshBotActivity(ctx, record);
  ctx.emit({ type: "bot", botId });
  return record;
}

export function setTaskActivity(ctx: StoreContext, botId: string, threadId: string, activity: BotActivity): BotRecord | null {
  const record = ctx.bot(botId);
  const task = ctx.taskByThread(botId, threadId);
  if (!record || !task) return null;
  const busy = ACTIVITY_BUSY.has(activity);
  if ((task.activity ?? "idle") === activity && Boolean(task.busy) === busy) return record;
  const wasBusy = Boolean(task.busy);
  task.activity = activity;
  task.busy = busy;
  if (busy && !wasBusy) task.turnStartedAt = Date.now();
  else if (!busy) delete task.turnStartedAt;
  refreshBotActivity(ctx, record);
  ctx.emit({ type: "bot", botId });
  return record;
}

function refreshBotActivity(ctx: StoreContext, record: BotRecord) {
  const activities = [ctx.legacyActivities.get(record.id), ...(record.tasks ?? []).map((task) => task.activity)];
  record.activity = (["waiting-on-you", "no-signal", "working", "dead"] as const)
    .find((activity) => activities.includes(activity)) ?? "idle";
  record.busy = ACTIVITY_BUSY.has(record.activity);
}

export function setResumeCursor(ctx: StoreContext, botId: string, instanceId: string, cursor: unknown, threadId?: string) {
  const record = ctx.bot(botId);
  if (!record) return;
  // the cursor belongs to the task that produced it, not to the bot
  const task = threadId ? ctx.taskByThread(botId, threadId) : ctx.activeTask(botId);
  if (task) task.resumeCursors[instanceId] = cursor;
  // The legacy mirror follows the task visible in chat, never a detached
  // routine task working in the background.
  if (!threadId || record.threadId === threadId) record.resumeCursors[instanceId] = cursor;
  ctx.saveBots();
  ctx.emit({ type: "bot", botId });
}

/** Record which instance just took a turn on this task. Called at
 * dispatch, not at cursor time — transcript-replay engines never
 * produce a cursor, and they still count as having run last. */
export function markTaskDispatched(ctx: StoreContext, botId: string, threadId: string, instanceId: string) {
  const task = ctx.taskByThread(botId, threadId);
  if (!task || task.lastInstanceId === instanceId) return;
  task.lastInstanceId = instanceId;
  ctx.saveBots();
}

/** Bank one settled turn onto its task. Called once per turn.completed;
 * the running per-driver token indicator is deliberately not used here
 * because its meaning differs by driver. */
export function addTaskUsage(
  ctx: StoreContext,
  botId: string,
  threadId: string,
  turn: { input?: number; output?: number; cachedInput?: number; costUsd: number | null; context?: { tokens?: number; window?: number } },
): TaskUsage | null {
  const task = ctx.taskByThread(botId, threadId);
  if (!task) return null;
  const prev: TaskUsage = { input: 0, output: 0, costUsd: null, turns: 0, ...task.usage };
  const cost =
    typeof turn.costUsd === "number" &&
    Number.isFinite(turn.costUsd) &&
    turn.costUsd >= 0
      ? turn.costUsd
      : null;
  const prevCost = typeof prev.costUsd === "number" ? prev.costUsd : null;
  // providers occasionally report NaN or a negative on a partial turn —
  // never let that poison a running tally
  const clean = (n: number | undefined) => (typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0);
  // the cached share exists on a record only once a driver has reported
  // it — a driver that never does leaves the record shaped as before
  const cachedKnown = typeof prev.cachedInput === "number" || typeof turn.cachedInput === "number";
  const prevInput = clean(prev.input);
  const turnInput = clean(turn.input);
  const nextCachedInput = Math.min(clean(prev.cachedInput), prevInput)
    + Math.min(clean(turn.cachedInput), turnInput);
  const contextTokens = clean(turn.context?.tokens);
  const contextWindow = clean(turn.context?.window);
  task.usage = {
    input: prevInput + turnInput,
    output: prev.output + clean(turn.output),
    ...(cachedKnown ? { cachedInput: nextCachedInput } : {}),
    costUsd: cost === null ? prevCost : (prevCost ?? 0) + cost,
    turns: prev.turns + 1,
    lastTurn: {
      input: turnInput, output: clean(turn.output),
      ...(typeof turn.cachedInput === "number" ? { cachedInput: Math.min(clean(turn.cachedInput), turnInput) } : {}),
      costUsd: cost,
    },
    // a turn that reported no context keeps the previous reading rather
    // than pretending the window emptied
    ...(contextTokens > 0
      ? { context: { tokens: contextTokens, ...(contextWindow > 0 ? { window: contextWindow } : {}) } }
      : prev.context ? { context: prev.context } : {}),
  };
  ctx.saveBots();
  ctx.emit({ type: "bot", botId });
  return task.usage;
}

/** The folder a task's turn runs in. Pins on first call from the bot's
 * current folder — unless the task already has a session (a thread from
 * before folders existed), which pins to the default so the folder can't
 * move under it. Returns the pinned value: a path, or null for default. */
export function pinTaskCwd(ctx: StoreContext, botId: string, threadId: string, fallbackCwd?: string, opts: { none?: boolean } = {}): string | null {
  const record = ctx.bot(botId);
  const task = record ? ctx.taskByThread(botId, threadId) : undefined;
  if (!record || !task) return null;
  if (opts.none) {
    if (task.cwd !== null) {
      task.cwd = null;
      ctx.saveBots();
      ctx.emit({ type: "bot", botId });
    }
    return null;
  }
  if (task.cwd === undefined) {
    task.cwd = Object.keys(task.resumeCursors).length === 0 ? (record.cwd ?? fallbackCwd ?? null) : null;
    ctx.saveBots();
    ctx.emit({ type: "bot", botId });
  }
  return task.cwd;
}

export function project(ctx: StoreContext, botId: string, projectId: string): BotProjectRecord | undefined {
  return ctx.bot(botId)?.projects?.find((candidate) => candidate.id === projectId);
}

export function createProject(ctx: StoreContext, botId: string, name: string, emoji?: string | null): BotProjectRecord | null {
  const record = ctx.bot(botId);
  if (!record || !name.trim() || (emoji != null && !isProjectEmoji(emoji))) return null;
  const created: BotProjectRecord = {
    id: newId(), name: name.trim().slice(0, 80),
    ...(emoji == null ? {} : { emoji }),
  };
  record.projects = [...(record.projects ?? []), created];
  ctx.saveBots();
  ctx.emit({ type: "bot", botId });
  return created;
}

export function patchProject(ctx: StoreContext, botId: string, projectId: string, patch: { name?: string; emoji?: string | null }): BotProjectRecord | null {
  const target = ctx.project(botId, projectId);
  if (!target || (patch.name !== undefined && !patch.name.trim()) || (patch.emoji != null && !isProjectEmoji(patch.emoji))) return null;
  if (patch.name !== undefined) target.name = patch.name.trim().slice(0, 80);
  if (patch.emoji === null) delete target.emoji;
  else if (patch.emoji !== undefined) target.emoji = patch.emoji;
  ctx.saveBots();
  ctx.emit({ type: "bot", botId });
  return target;
}

/** The stored array is the sidebar order; only a full owned permutation is valid. */
export function reorderProjects(ctx: StoreContext, botId: string, projectIds: string[]): BotProjectRecord[] | null {
  const record = ctx.bot(botId);
  const projects = record?.projects ?? [];
  if (!record || projectIds.length !== projects.length || new Set(projectIds).size !== projects.length) return null;
  const byId = new Map(projects.map((candidate) => [candidate.id, candidate]));
  if (projectIds.some((id) => !byId.has(id))) return null;
  record.projects = projectIds.map((id) => byId.get(id)!);
  ctx.saveBots();
  ctx.emit({ type: "bot", botId });
  return record.projects;
}

/** Removing an organizational label never removes its conversations. */
export function deleteProject(ctx: StoreContext, botId: string, projectId: string): BotRecord | null {
  const record = ctx.bot(botId);
  if (!record || !ctx.project(botId, projectId)) return null;
  record.projects = record.projects!.filter((candidate) => candidate.id !== projectId);
  for (const task of record.tasks ?? []) {
    if (task.projectId === projectId) delete task.projectId;
  }
  ctx.saveBots();
  ctx.emit({ type: "bot", botId });
  return record;
}
