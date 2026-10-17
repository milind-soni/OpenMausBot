import type { Action, AppState, GroupTask } from "./store";

export type ThreadEdit = Extract<Action, { type: "renameTask" | "renameGroupTask" | "pinGroupTask" }> | (Extract<Action, { type: "setConversationTurnLimit" }> & { dm: false });

export function patchGroupTask(state: AppState, groupId: string, threadId: string, patch: Partial<GroupTask>): AppState {
  return {
    ...state,
    groups: state.groups.map((group) => group.id !== groupId ? group : {
      ...group,
      tasks: (group.tasks ?? []).map((task) => task.threadId === threadId ? { ...task, ...patch } : task),
    }),
  };
}

const botTask = (state: AppState, botId: string, threadId: string) =>
  state.bots.find((bot) => bot.id === botId)?.tasks?.find((task) => task.threadId === threadId);
const groupTask = (state: AppState, groupId: string, threadId: string) =>
  state.groups.find((group) => group.id === groupId)?.tasks?.find((task) => task.threadId === threadId);

/** The edit that shows a thread as it was before `edit`, for when its save fails and no newer edit has replaced it. */
export function undoThreadEdit(before: AppState, edit: ThreadEdit): (now: AppState) => Action | undefined {
  switch (edit.type) {
    case "renameTask": {
      const title = botTask(before, edit.botId, edit.threadId)?.title;
      return (now) => title !== undefined && botTask(now, edit.botId, edit.threadId)?.title === edit.title ? { ...edit, title } : undefined;
    }
    case "renameGroupTask": {
      const title = groupTask(before, edit.groupId, edit.threadId)?.title;
      return (now) => title !== undefined && groupTask(now, edit.groupId, edit.threadId)?.title === edit.title ? { ...edit, title } : undefined;
    }
    case "pinGroupTask": {
      const pinned = Boolean(groupTask(before, edit.groupId, edit.threadId)?.pinned);
      return (now) => Boolean(groupTask(now, edit.groupId, edit.threadId)?.pinned) === edit.pinned ? { ...edit, pinned } : undefined;
    }
    case "setConversationTurnLimit": {
      const minutes = groupTask(before, edit.groupId, edit.threadId)?.turnTimeoutMinutes ?? null;
      return (now) => (groupTask(now, edit.groupId, edit.threadId)?.turnTimeoutMinutes ?? null) === edit.minutes ? { ...edit, minutes } : undefined;
    }
  }
}
