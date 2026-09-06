import { newId, type ModelSelection } from "./contracts.ts";
import { botMascotBody } from "../shared/mascot-bodies.ts";
import { takeImportName } from "../shared/import-name.ts";
import { MAX_TEAM_BACKUP_BYTES, parseTeamBackup, type BackupTask, type TeamBackup } from "../shared/team-backup.ts";
import type { BotRecord, GroupRecord, Message, Store } from "./store.ts";
import type { Routine, RoutineManager } from "./routines.ts";

/** Preserve readable history without importing executable cards, live queue
 * entries, approval requests, local paths or provider session handles. */
function messageText(message: Message): string {
  const parts = [message.text ?? ""];
  if (message.card) parts.push(message.card.title, message.card.subtitle, ...message.card.options, message.card.answered ?? "");
  if (message.tool) parts.push(`[${message.tool.name}${message.tool.ok === false ? ": failed" : ""}]`);
  if (message.kind === "connector") parts.push("[Connection card — reconnect in Settings]");
  if (message.kind === "secret") parts.push("[Secret request — not restored]");
  if (message.routineRun) parts.push(`[Routine: ${message.routineRun.routineName} — ${message.routineRun.status}]`, message.routineRun.summary ?? "", message.routineRun.error ?? "");
  if (message.goalRun) parts.push(`[Room goal: ${message.goalRun.status}]`, message.goalRun.goal, message.goalRun.detail ?? "");
  if (message.kind === "screen" || message.attachments?.length) parts.push("[Image or attachment — file not included in this backup]");
  return parts.filter(Boolean).join("\n");
}

export function createTeamBackup(store: Store, routines: Routine[], name: string): TeamBackup {
  const botIds = new Set(store.bots.map((bot) => bot.id));
  const warnings: string[] = [];
  const history = (record: BotRecord | GroupRecord): BackupTask[] => {
    const tasks = record.tasks?.length ? record.tasks : [{ threadId: record.threadId, title: "Conversation", createdAt: record.createdAt }];
    return tasks.map((task) => ({
      key: task.threadId, title: task.title, createdAt: task.createdAt,
      activeLeafId: store.activeLeaf(task.threadId),
      messages: store.messagesFor(task.threadId).map((message) => ({
        id: message.id, role: message.role, text: messageText(message), at: message.at,
        parentId: message.parentId ?? null, replyToId: message.replyToId,
        from: message.from, peerPost: message.peerPost,
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
        ? { kind: "mentions" as const } : group.defaultResponder,
      activeTask: group.threadId, tasks: history(group),
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
      activeTask: bot.threadId, tasks: history(bot),
    })),
    groups,
    routines: validRoutines.map((routine) => ({
      name: routine.name, prompt: routine.prompt, target: routine.target, botId: routine.botId,
      groupId: routine.groupId, runOn: routine.runOn, schedule: routine.schedule,
      durationMinutes: routine.durationMinutes, timeoutMinutes: routine.timeoutMinutes,
    })),
  });
  // Never download a file our own importer cannot read; never truncate history.
  if (Buffer.byteLength(JSON.stringify(document)) > MAX_TEAM_BACKUP_BYTES) {
    throw new Error("This backup exceeds the 50 MB portable-backup limit. Nothing was exported or changed.");
  }
  return document;
}

/** Import is always additive, including sections and Chiefs. Rollback owns
 * only the fresh records below and cannot touch any pre-existing bot/chat. */
export function importTeamBackup(store: Store, routines: RoutineManager, input: unknown, selection: ModelSelection) {
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
  const takenSections = new Set([...store.bots, ...store.groups].map((record) => record.section?.trim().toLowerCase() ?? ""));
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
      // Removed historical senders retain their name in the text, never a
      // link to an unrelated local bot with a colliding file key.
      ...(message.from && botIds.has(message.from.botId)
        ? { from: { ...message.from, botId: botIds.get(message.from.botId)! } }
        : message.from ? { text: `${message.from.name}:\n${message.text}` } : {}),
      peerPost: message.peerPost,
    }));
    store.importTranscript(threadId, messages, task.activeLeafId ? ids.get(task.activeLeafId)! : null);
  };
  try {
    // Allocate all bot IDs before remapping any conversation participants.
    for (const source of backup.bots) {
      const bot = store.createBot({
        name: takeImportName(source.name, takenNames), title: source.title, description: source.description, soul: source.soul,
        color: source.color, mascotExpression: source.mascotExpression,
        mascotBody: botMascotBody(source.mascotBody),
        modelSelection: selection, section: sectionFor(source.section),
      }, { seedMessages: false });
      bots.push(bot);
      botIds.set(source.key, bot.id);
      store.patchBot(bot.id, { composio: false, computer: "off", browser: false, approvalMode: "ask", autoApprove: false,
        hidden: source.hidden, chiefOfStaff: source.chiefOfStaff, playbooks: source.playbooks });
    }
    for (const source of backup.bots) {
      const bot = store.bot(botIds.get(source.key)!)!;
      const tasks = source.tasks.map((task, i) => ({
        threadId: i === 0 ? bot.threadId : newId(), title: task.title, createdAt: task.createdAt, resumeCursors: {},
      }));
      // Own the task IDs before writing their transcripts, so rollback also
      // removes partially imported history if persistence fails midway.
      store.patchBot(bot.id, { tasks, threadId: tasks[source.tasks.findIndex((task) => task.key === source.activeTask)].threadId });
      source.tasks.forEach((task, i) => restore(task, tasks[i].threadId));
    }
    for (const source of backup.groups) {
      const group = store.createGroup(takeImportName(source.name, takenGroups), source.memberIds.map((id) => botIds.get(id)!), source.dm, sectionFor(source.section));
      groups.push(group);
      groupIds.set(source.key, group.id);
      const responder = source.defaultResponder;
      store.patchGroup(group.id, { bulletin: source.bulletin, setupCompletedAt: Date.now(), defaultResponder:
        responder.kind === "member" ? { kind: "member", botId: botIds.get(responder.botId)! } : responder });
      // Use the existing task APIs for rooms; direct-message rooms have one.
      const threads = source.tasks.map((task, i) => {
        if (i === 0) {
          if (!source.dm) store.renameGroupTask(group.id, group.threadId, task.title);
          return group.threadId;
        }
        return store.createGroupTask(group.id, task.title, false)!.threadId;
      });
      source.tasks.forEach((task, i) => restore(task, threads[i]));
      if (!source.dm) {
        group.tasks = source.tasks.map((task, i) => ({ threadId: threads[i], title: task.title, createdAt: task.createdAt }));
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
    // createBot/createGroup can throw during persistence before returning.
    // This synchronous import cannot interleave another writer, so include
    // every fresh ID, even a record that never reached the result arrays.
    for (const group of store.groups) if (!existingGroupIds.has(group.id)) store.deleteGroup(group.id);
    for (const bot of store.bots) if (!existingBotIds.has(bot.id)) store.deleteBot(bot.id);
    throw error;
  }
}
