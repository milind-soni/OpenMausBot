import { api } from "./api";
import { MESSAGE_PAGE_SIZE, type Action, type Group } from "./store";

export async function switchRoomTask(
  action: Extract<Action, { type: "switchGroupTask" }>,
  groups: readonly Group[],
  apply: (answer: { group?: Partial<Group> & { id: string } } | undefined) => void,
): Promise<void> {
  if (action.whole && groups.some((group) => group.id === action.groupId && group.threadId === action.threadId)) return;
  const answer = await api<{ group?: Partial<Group> & { id: string } }>(
    `/api/groups/${action.groupId}/tasks/${action.threadId}${action.whole ? "" : `?messages=${MESSAGE_PAGE_SIZE}`}`,
    { method: "POST" },
  );
  apply(answer);
}
