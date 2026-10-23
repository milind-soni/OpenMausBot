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

/** A person's mute or unmute in a thread patch: the thread stops following the mute default. */
export function muteChoice(patch: { notificationsMuted?: boolean }): { followsMuteDefault?: false } {
  return patch.notificationsMuted === undefined ? {} : { followsMuteDefault: false };
}
