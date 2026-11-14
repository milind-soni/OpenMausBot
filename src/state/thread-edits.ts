import type { AppState, GroupTask } from "./store";

export function patchGroupTask(state: AppState, groupId: string, threadId: string, patch: Partial<GroupTask>): AppState {
  return {
    ...state,
    groups: state.groups.map((group) => group.id !== groupId ? group : {
      ...group,
      tasks: (group.tasks ?? []).map((task) => task.threadId === threadId ? { ...task, ...patch } : task),
    }),
  };
}
