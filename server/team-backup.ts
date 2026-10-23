import { newId, type ModelSelection } from "./contracts.ts";
import { botBodyId } from "../shared/bot-body.ts";
import { takeImportName } from "../shared/import-name.ts";
import { MAX_TEAM_BACKUP_BYTES, parseTeamBackup, type BackupTask, type TeamBackup } from "../shared/team-backup.ts";
import { helperModelAllowed, type BotVisibility } from "../shared/wire.ts";
import type { BotRecord, GroupRecord, Message, Store, TaskRecord } from "./store.ts";
import type { Routine, RoutineManager } from "./routines.ts";
import { redactSecretsInText } from "./redact.ts";
import {
  listMemoryLogs, listMemoryTopics, readMemoryFile, readMemoryLog, readMemoryTopic,
  writeMemoryFile, writeMemoryLog, writeMemoryTopic,
} from "./workspace.ts";

/** Scrubbed on the way out: files the bot's own tools wrote never passed the server's scrub. */
function memoryFor(botId: string): TeamBackup["bots"][number]["memory"] {
  const file = redactSecretsInText(readMemoryFile(botId).text);
  const topics = listMemoryTopics(botId).flatMap((topic) => {
    const text = readMemoryTopic(botId, topic.name);
    return text === null ? [] : [{ name: topic.name, text: redactSecretsInText(text) }];
  });
  const logs = listMemoryLogs(botId).flatMap((name) => {
    const text = readMemoryLog(botId, name);
    return text === null ? [] : [{ name, text: redactSecretsInText(text) }];
  });
  if (!file && !topics.length && !logs.length) return undefined;
  return { file, topics, logs };
}

function restoreMemory(botId: string, memory: NonNullable<TeamBackup["bots"][number]["memory"]>): void {
  if (memory.file) writeMemoryFile(botId, memory.file);
  for (const topic of memory.topics) writeMemoryTopic(botId, topic.name, topic.text);
  for (const log of memory.logs) writeMemoryLog(botId, log.name, log.text);
}

/** Readable history only: no executable cards, queue entries, approval requests, local paths or session handles. */
function messageText(message: Message): string {
  const parts = [message.text ?? ""];
  if (message.card) parts.push(message.card.title, message.card.subtitle, ...message.card.options, message.card.answered ?? "");
  if (message.tool) parts.push(`[${message.tool.name}${message.tool.ok === false ? ": failed" : ""}]`);
  if (message.kind === "connector") parts.push("[Connection card — reconnect in Settings]");
  if (message.kind === "secret") parts.push("[Secret request — not restored]");
  if (message.kind === "signin") parts.push("[Sign-in request — not restored]");
  if (message.routineRun) parts.push(`[Routine: ${message.routineRun.routineName} — ${message.routineRun.status}]`, message.routineRun.summary ?? "", message.routineRun.error ?? "");
  if (message.goalRun) parts.push(`[Room goal: ${message.goalRun.status}]`, message.goalRun.goal, message.goalRun.detail ?? "");
  if (message.kind === "screen" || message.attachments?.length) parts.push("[Image or attachment — file not included in this backup]");
  return parts.filter(Boolean).join("\n");
}

/** `shown`: on a Team Cloud someone else's private chat is never in the exporting person's backup. */
export function createTeamBackup(store: Store, routines: Routine[], name: string, shown: (threadId: string) => boolean = () => true): TeamBackup {
  const botIds = new Set(store.bots.map((bot) => bot.id));
  const warnings: string[] = [];
  const history = (record: BotRecord | GroupRecord): BackupTask[] => {
    const tasks = record.tasks?.length ? record.tasks : [{ threadId: record.threadId, title: "Conversation", createdAt: record.createdAt }];
    return tasks.filter((task) => shown(task.threadId)).map((task) => ({
      key: task.threadId, title: task.title, createdAt: task.createdAt,
      titleFromFirstMessage: "titleFromFirstMessage" in task && task.titleFromFirstMessage || undefined,
      openedBy: "openedBy" in task && task.openedBy
        ? { botId: task.openedBy.botId, name: task.openedBy.name, at: task.openedBy.at,
            ...(task.openedBy.kind ? { kind: task.openedBy.kind } : {}) }
        : undefined,
      closedBy: "closedBy" in task && task.closedBy
        ? { botId: task.closedBy.botId, name: task.closedBy.name, at: task.closedBy.at }
        : undefined,
      pinned: task.pinned === true ? true : undefined,
      turnTimeoutMinutes: "turnTimeoutMinutes" in task && typeof task.turnTimeoutMinutes === "number"
        ? task.turnTimeoutMinutes
        : undefined,
      activeLeafId: store.activeLeaf(task.threadId),
      messages: store.messagesFor(task.threadId).map((message) => ({
        id: message.id, role: message.role, text: messageText(message), at: message.at,
        parentId: message.parentId ?? null, replyToId: message.replyToId,
        from: message.from, peerPost: message.peerPost, ...(message.serverCard ? { serverCard: true as const } : {}),
      })),
    }));
  };
  const groups = store.groups.map((group) => {
    const memberIds = group.memberIds.filter((id) => botIds.has(id));
    if (memberIds.length !== group.memberIds.length) warnings.push(`Room “${group.name}” contains deleted bots. Its conversation is included with the remaining members.`);
    return {
      key: group.id, name: group.name, section: group.section, dm: Boolean(group.dm) && memberIds.length === 2,
      bulletin: group.bulletin, memberIds,
      defaultResponder: group.defaultResponder.kind === "member" && !memberIds.includes(group.defaultResponder.botId)
        ? { kind: "mentions" as const }
        : group.defaultResponder.kind === "auto" && group.defaultResponder.fallbackBotId && !memberIds.includes(group.defaultResponder.fallbackBotId)
          ? { kind: "auto" as const } : group.defaultResponder,
      activeTask: group.threadId,
      tasks: history(group).map((task, index) =>
        group.dm && index === 0 && typeof group.turnTimeoutMinutes === "number"
          ? { ...task, turnTimeoutMinutes: group.turnTimeoutMinutes }
          : task,
      ),
    };
  });
  const validRoutines = routines.filter((routine) => {
    const room = groups.find((group) => group.key === routine.groupId);
    const valid = botIds.has(routine.botId) && (routine.target !== "room-goal" || (room && !room.dm && room.memberIds.includes(routine.botId)));
    if (!valid) warnings.push(`Routine “${routine.name}” is not included because its bot, room or coordinator was deleted.`);
    return valid;
  });
  const document = parseTeamBackup({
    format: "openmaus.backup", version: 1, name, exportedAt: Date.now(),
    warnings,
    bots: store.bots.map((bot) => ({
      key: bot.id, name: bot.name, title: bot.title, description: bot.description, soul: bot.soul,
      section: bot.section, color: bot.color,
      mascotExpression: bot.mascotExpression ?? undefined, mascotBody: bot.mascotBody ?? undefined,
      chiefOfStaff: Boolean(bot.chiefOfStaff), hidden: Boolean(bot.hidden), playbooks: bot.playbooks ?? [],
      // Grants travel so the team's shape survives, but the import still lands every bot grant-less.
      ...(bot.connectorTools ? { connectorTools: structuredClone(bot.connectorTools) } : {}),
      ...(bot.toolScope !== undefined ? { toolScope: structuredClone(bot.toolScope) } : {}),
      // A bot kept off the helper model stays off it wherever its notes and chats land.
      ...(helperModelAllowed(bot) ? {} : { helperModel: false }),
      memory: memoryFor(bot.id),
      // Someone else's private chat selected: the backup opens on the first conversation it carries instead.
      ...((tasks) => ({ activeTask: tasks.some((task) => task.key === bot.threadId) ? bot.threadId : tasks[0]?.key ?? bot.threadId, tasks }))(history(bot)),
    })),
    groups,
    routines: validRoutines.map((routine) => ({
      name: routine.name, prompt: routine.prompt, target: routine.target, botId: routine.botId,
      groupId: routine.groupId, runOn: routine.runOn, schedule: routine.schedule,
      durationMinutes: routine.durationMinutes, timeoutMinutes: routine.timeoutMinutes,
      ...(routine.checks ? { checks: routine.checks } : {}), ...(routine.access ? { access: routine.access } : {}), ...(routine.deliver ? { deliver: routine.deliver } : {}),
    })),
  });
  if (Buffer.byteLength(JSON.stringify(document)) > MAX_TEAM_BACKUP_BYTES) {
    throw new Error("This backup exceeds the 50 MB portable-backup limit. Nothing was exported or changed.");
  }
  return document;
}

/** Always additive: rollback owns only the fresh records and cannot touch an existing bot or chat. */
export function importTeamBackup(store: Store, routines: RoutineManager, input: unknown, selection: ModelSelection, options: { visibility?: BotVisibility } = {}) {
  const backup = parseTeamBackup(input);
  const bots: BotRecord[] = [];
  const groups: GroupRecord[] = [];
  const createdRoutines: Routine[] = [];
  const existingBotIds = new Set(store.bots.map((bot) => bot.id));
  const existingGroupIds = new Set(store.groups.map((group) => group.id));
  const botIds = new Map<string, string>();
  const groupIds = new Map<string, string>();
  const takenNames = new Set(store.bots.map((bot) => bot.name.trim().toLowerCase()));
  const takenGroups = new Set(store.groups.map((group) => group.name.trim().toLowerCase()));
  const takenSections = new Set([
    ...store.sections.map((section) => section.toLowerCase()),
    ...[...store.bots, ...store.groups].map((record) => record.section?.trim().toLowerCase() ?? ""),
  ]);
  const sections = new Map<string, string>();
  const sectionFor = (section?: string) => {
    const key = section?.trim() ?? "";
    if (!sections.has(key)) sections.set(key, takeImportName(section?.trim() || "Imported bots", takenSections, 60));
    return sections.get(key)!;
  };
  const restore = (task: BackupTask, threadId: string) => {
    const ids = new Map(task.messages.map((message) => [message.id, newId()]));
    const messages: Message[] = task.messages.map((message) => ({
      id: ids.get(message.id)!, kind: "text", role: message.role, text: message.text, at: message.at,
      parentId: message.parentId ? ids.get(message.parentId)! : null,
      replyToId: message.replyToId ? ids.get(message.replyToId) : undefined,
      // A removed sender keeps its name in the text, never a link to an unrelated local bot with a colliding key.
      ...(message.from && botIds.has(message.from.botId)
        ? { from: { ...message.from, botId: botIds.get(message.from.botId)! } }
        : message.from ? { text: `${message.from.name}:\n${message.text}` } : {}),
      peerPost: message.peerPost,
      ...(message.serverCard && message.role === "bot" ? { serverCard: true as const } : {}),
    }));
    store.importTranscript(threadId, messages, task.activeLeafId ? ids.get(task.activeLeafId)! : null);
  };
  try {
    // Allocate all bot IDs before remapping any conversation participants.
    for (const source of backup.bots) {
      const bot = store.createBot({
        name: takeImportName(source.name, takenNames), title: source.title, description: source.description, soul: source.soul,
        color: source.color, mascotExpression: source.mascotExpression,
        mascotBody: botBodyId(source.mascotBody),
        modelSelection: selection, section: sectionFor(source.section),
        // who may see the imported team is the importing admin's choice
        ...(options.visibility ? { visibility: options.visibility } : {}),
      }, { seedMessages: false });
      bots.push(bot);
      botIds.set(source.key, bot.id);
      store.patchBot(bot.id, { composio: false, computer: "off", browser: false, autoApprove: false,
        connectorTools: {}, toolScope: source.toolScope, hidden: source.hidden, chiefOfStaff: source.chiefOfStaff, playbooks: source.playbooks,
        ...(source.helperModel === false ? { helperModel: false } : {}) });
      if (source.memory) restoreMemory(bot.id, source.memory);
    }
    for (const source of backup.bots) {
      const bot = store.bot(botIds.get(source.key)!)!;
      const tasks = source.tasks.map((task, i): TaskRecord => {
        const record: TaskRecord = {
          threadId: i === 0 ? bot.threadId : newId(), title: task.title, createdAt: task.createdAt, resumeCursors: {},
          activity: "idle" as const, busy: false, unread: false,
          ...(task.titleFromFirstMessage ? { titleFromFirstMessage: true } : {}),
        };
        const opener = task.openedBy && botIds.get(task.openedBy.botId);
        if (task.openedBy && opener) record.openedBy = { botId: opener, name: task.openedBy.name, at: task.openedBy.at, ...(task.openedBy.kind ? { kind: task.openedBy.kind } : {}) };
        const closer = task.closedBy && botIds.get(task.closedBy.botId);
        if (task.closedBy && closer) record.closedBy = { botId: closer, name: task.closedBy.name, at: task.closedBy.at };
        if (task.pinned === true) record.pinned = true;
        const newest = task.messages.reduce((max, message) => Math.max(max, message.at), task.createdAt);
        record.updatedAt = newest;
        return record;
      });
      // Own the task IDs before writing transcripts, so rollback also removes partial history.
      store.patchBot(bot.id, { tasks, threadId: tasks[source.tasks.findIndex((task) => task.key === source.activeTask)].threadId });
      source.tasks.forEach((task, i) => restore(task, tasks[i].threadId));
    }
    for (const source of backup.groups) {
      const group = store.createGroup(takeImportName(source.name, takenGroups), source.memberIds.map((id) => botIds.get(id)!), source.dm, sectionFor(source.section));
      groups.push(group);
      groupIds.set(source.key, group.id);
      const responder = source.defaultResponder;
      store.patchGroup(group.id, {
        bulletin: source.bulletin,
        setupCompletedAt: Date.now(),
        ...(source.dm && source.tasks[0]?.turnTimeoutMinutes != null
          ? { turnTimeoutMinutes: source.tasks[0].turnTimeoutMinutes }
          : {}),
        defaultResponder:
        responder.kind === "member" ? { kind: "member", botId: botIds.get(responder.botId)! }
          : responder.kind === "auto" ? { kind: "auto", ...(responder.fallbackBotId ? { fallbackBotId: botIds.get(responder.fallbackBotId)! } : {}) }
            : responder });
      const threads = source.tasks.map((task, i) => {
        if (i === 0) {
          if (!source.dm) store.patchGroupTask(group.id, group.threadId, { title: task.title });
          return group.threadId;
        }
        return store.createGroupTask(group.id, task.title, false)!.threadId;
      });
      source.tasks.forEach((task, i) => restore(task, threads[i]));
      if (!source.dm) {
        group.tasks = source.tasks.map((task, i) => ({
          threadId: threads[i], title: task.title, createdAt: task.createdAt,
          updatedAt: task.messages.reduce((max, message) => Math.max(max, message.at), task.createdAt),
          ...(task.pinned === true ? { pinned: true as const } : {}),
          ...(task.titleFromFirstMessage ? { titleFromFirstMessage: true } : {}),
          ...(task.turnTimeoutMinutes != null ? { turnTimeoutMinutes: task.turnTimeoutMinutes } : {}),
        }));
        store.switchGroupTask(group.id, threads[source.tasks.findIndex((task) => task.key === source.activeTask)]);
      }
    }
    for (const source of backup.routines) {
      createdRoutines.push(routines.create({ ...source, botId: botIds.get(source.botId)!,
        groupId: source.target === "room-goal" ? groupIds.get(source.groupId!) : undefined, enabled: false }));
    }
    return { name: backup.name, bots, groups, routines: createdRoutines };
  } catch (error) {
    for (const routine of createdRoutines) routines.remove(routine.id);
    // createBot/createGroup can throw after persisting, so every fresh ID is swept.
    for (const group of store.groups) if (!existingGroupIds.has(group.id)) store.deleteGroup(group.id);
    for (const bot of store.bots) if (!existingBotIds.has(bot.id)) store.deleteBot(bot.id);
    for (const section of sections.values()) {
      if (store.sections.includes(section)) store.changeEmptySection(section, null);
    }
    throw error;
  }
}
