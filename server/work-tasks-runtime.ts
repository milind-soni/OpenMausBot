import type { CoordinateBotsCall, HandoffView } from "./coordinator.ts";
import { isQaBot, type AgentTask } from "../shared/work-tasks.ts";
import { chiefLevel } from "./chief-level.ts";
import type { BotRecord, Store } from "./store.ts";
import type { JiraSyncService } from "./work-tasks-jira.ts";
import type { WorkTaskActor, WorkTaskStore } from "./work-tasks.ts";

function botActor(bot: BotRecord | null | undefined, fallbackId: string, roomDefaultResponderId?: string): WorkTaskActor {
  if (!bot) {
    return { actorType: "agent", actorId: fallbackId, actorName: fallbackId, actorRole: "Worker" };
  }
  const isCoordinator = chiefLevel(bot) || roomDefaultResponderId === bot.id;
  const isQa = isQaBot(bot);
  const actorRole = bot.title?.trim() || (isCoordinator ? "Coordinator" : isQa ? "QA" : "Worker");
  return {
    actorType: "agent",
    actorId: bot.id,
    actorName: bot.name,
    actorRole,
    isCoordinator,
    isQa,
  };
}

function triggerAutoJira(workTasks: WorkTaskStore, jira: JiraSyncService | undefined, task: AgentTask | undefined): void {
  if (!jira || !task?.jiraSync?.issueKey) return;
  const cfg = workTasks.getRoomJiraConfig(task.roomId);
  if (!cfg.enabled || !cfg.autoSync) return;
  void jira.syncTaskToJira(task.id).catch(() => {});
}

export function syncTaskOnCoordinateDispatch(params: {
  workTasks: WorkTaskStore;
  jira?: JiraSyncService;
  store: Store;
  sender: BotRecord;
  recipient: BotRecord;
  senderThreadId: string;
  node: HandoffView;
  call: CoordinateBotsCall;
}): AgentTask | undefined {
  const { workTasks, jira, store, sender, recipient, senderThreadId, node, call } = params;
  if (call.consult) return undefined;

  const parentWorkTask =
    (node.parentId ? workTasks.findByAssignmentId(node.parentId) : undefined) ??
    workTasks.findByThreadId(senderThreadId);
  const targetRoom =
    (node.groupId ? store.group(node.groupId) : undefined) ??
    (call.groupId ? store.group(call.groupId) : undefined) ??
    store.groupByThread(senderThreadId) ??
    (parentWorkTask ? store.group(parentWorkTask.roomId) : undefined);

  const roomId = targetRoom?.id ?? parentWorkTask?.roomId;
  const defaultRespId =
    targetRoom?.defaultResponder.kind === "member" ? targetRoom.defaultResponder.botId : undefined;
  const senderActor = {
    ...botActor(sender, sender.id, defaultRespId),
    isCoordinator: true, // Caller dispatching coordinate_bots acts as coordinator for that delegation
  };

  if (call.workTaskId) {
    const existing = workTasks.get(call.workTaskId);
    if (!existing) return undefined;
    const assigned = workTasks.assign(
      existing.id,
      {
        assigneeBotId: recipient.id,
        assigneeName: recipient.name,
        assigneeRole: recipient.title ?? (isQaBot(recipient) ? "QA" : "Worker"),
        coordinatorBotId: sender.id,
        threadId: node.threadId,
        assignmentId: node.id,
      },
      senderActor,
    );
    triggerAutoJira(workTasks, jira, assigned);
    return assigned;
  }

  if (!roomId) return undefined;

  // Avoid duplicate auto-creation if a task already binds this exact assignmentId
  const alreadyBound = workTasks.findByAssignmentId(node.id);
  if (alreadyBound) return alreadyBound;

  const firstLine = call.message.replace(/\s+/g, " ").trim().slice(0, 80);
  const title = call.title?.trim() || firstLine || `Work for ${recipient.name}`;
  const created = workTasks.create(
    {
      roomId,
      ...(parentWorkTask ? { parentTaskId: parentWorkTask.id, type: "subtask" as const } : { type: "task" as const }),
      title,
      description: call.message,
      status: "todo",
      coordinatorBotId: sender.id,
      assigneeBotId: recipient.id,
      assigneeName: recipient.name,
      assigneeRole: recipient.title ?? (isQaBot(recipient) ? "QA" : "Worker"),
      ...(call.doneWhen ? { acceptanceCriteria: [call.doneWhen] } : {}),
      threadId: node.threadId,
      assignmentId: node.id,
    },
    senderActor,
  );
  return created.task;
}

export function syncTaskOnRuntimeStart(params: {
  workTasks: WorkTaskStore;
  jira?: JiraSyncService;
  store: Store;
  node: HandoffView;
  bot: BotRecord;
}): void {
  const { workTasks, jira, store, node, bot } = params;
  const task = workTasks.findByAssignmentId(node.id);
  if (!task) return;
  if (task.threadId !== node.threadId) {
    workTasks.bindRuntime(task.id, { threadId: node.threadId });
  }
  const room = store.group(task.roomId);
  const defaultRespId = room?.defaultResponder.kind === "member" ? room.defaultResponder.botId : undefined;
  const actor = botActor(bot, bot.id, defaultRespId);

  if (task.status === "backlog") {
    const asTodo = workTasks.transition(task.id, "todo", {
      actorType: "system",
      actorName: "Runtime",
    });
    const started = workTasks.transition(asTodo.id, "in-progress", actor, {
      message: `${bot.name} started working on ${asTodo.key}`,
    });
    triggerAutoJira(workTasks, jira, started);
    return;
  }

  if (task.status === "todo" || task.status === "rework" || task.status === "blocked") {
    const started = workTasks.transition(task.id, "in-progress", actor, {
      message: `${bot.name} started execution in thread ${node.threadId}`,
    });
    triggerAutoJira(workTasks, jira, started);
  }
}

export function syncTaskOnRuntimePark(params: {
  workTasks: WorkTaskStore;
  jira?: JiraSyncService;
  store: Store;
  node: HandoffView;
  question: string;
}): void {
  const { workTasks, jira, store, node, question } = params;
  const task = workTasks.findByAssignmentId(node.id);
  if (!task) return;
  if (!["todo", "in-progress", "rework"].includes(task.status)) return;
  const bot = store.bot(node.botId);
  const room = store.group(task.roomId);
  const defaultRespId = room?.defaultResponder.kind === "member" ? room.defaultResponder.botId : undefined;
  const actor = botActor(bot, node.botId, defaultRespId);
  const blocked = workTasks.transition(task.id, "blocked", actor, {
    message: question || "Waiting for user or coordinator answer",
    needsUserAction: true,
    needsUserReason: question || "Needs input",
  });
  triggerAutoJira(workTasks, jira, blocked);
}

export function syncTaskOnRuntimeReport(params: {
  workTasks: WorkTaskStore;
  jira?: JiraSyncService;
  store: Store;
  child: HandoffView;
  hasActiveChildren: boolean;
}): void {
  const { workTasks, jira, store, child, hasActiveChildren } = params;
  const task = workTasks.findByAssignmentId(child.id);
  if (!task) return;
  const bot = store.bot(child.botId);
  const room = store.group(task.roomId);
  const defaultRespId = room?.defaultResponder.kind === "member" ? room.defaultResponder.botId : undefined;
  const actor = botActor(bot, child.botId, defaultRespId);

  if (child.status === "completed") {
    const unfinishedChildren = hasActiveChildren || workTasks.hasUnfinishedSubtasks(task.id);
    if (unfinishedChildren) {
      workTasks.addActivity(
        task.id,
        {
          type: "progress",
          message: `${bot?.name ?? child.botId} finished turn, waiting on child subtasks before review`,
        },
        actor,
      );
      return;
    }
    if (task.status === "in-progress") {
      const reviewed = workTasks.transition(task.id, "in-review", actor, {
        message: `${bot?.name ?? child.botId} completed work and moved ${task.key} to In Review`,
      });
      triggerAutoJira(workTasks, jira, reviewed);
    } else if (task.status === "todo" || task.status === "rework") {
      const inProg = workTasks.transition(task.id, "in-progress", actor);
      const reviewed = workTasks.transition(inProg.id, "in-review", actor, {
        message: `${bot?.name ?? child.botId} completed work and moved ${task.key} to In Review`,
      });
      triggerAutoJira(workTasks, jira, reviewed);
    }
    return;
  }

  if (child.status === "failed") {
    const cause = child.outcomeDetail || child.result || "Agent runtime failed";
    if (["todo", "in-progress", "blocked", "in-review"].includes(task.status)) {
      const failed = workTasks.transition(task.id, "failed", { actorType: "system", actorName: "Runtime" }, {
        message: cause.slice(0, 800),
        needsUserAction: true,
        needsUserReason: cause.slice(0, 400),
        activityType: "error",
      });
      triggerAutoJira(workTasks, jira, failed);
    } else {
      workTasks.addActivity(task.id, { type: "error", message: cause.slice(0, 800) }, { actorType: "system", actorName: "Runtime" });
    }
  }
}
