// A room's frames and answers: a frame naming another thread without its transcript is stale, an answer overtaken by a
// newer switch in the same room is dropped, and a snapshot keeps what streamed into the shown thread while it was out.
import { optimisticMessageId } from "./optimistic-send";
import { mergeTaskStamps } from "./thread-stamps";
import type { Action, AppState, Group, Message } from "./store";

type GroupPatch = Partial<Group> & { id: string };

/** A room frame's fields that describe the room as a whole, not the thread the server has open. */
function roomFieldsOnly({
  threadId: _threadId, pinnedCwd: _pinnedCwd, pinnedMessageId: _pinnedMessageId, usage: _usage,
  memberContext: _memberContext, busyBotId: _busyBotId, turnStartedAt: _turnStartedAt, ...room
}: GroupPatch): GroupPatch {
  return { ...room, section: room.section };
}

function foldSnapshotOntoStreamed(
  current: readonly Message[],
  heldAtStart: ReadonlySet<Message>,
  snapshot: readonly Message[],
): Message[] {
  const snapshotIds = new Set(snapshot.map((message) => message.id));
  const confirmedSends = new Set(snapshot.flatMap((message) => (message.sendId ? [message.sendId] : [])));
  const streamed = new Map(current.filter((message) => !heldAtStart.has(message)).map((message) => [message.id, message]));
  const firstShared = current.findIndex((message) => snapshotIds.has(message.id));
  const tail = current.filter((message, index) => {
    if (snapshotIds.has(message.id)) return false;
    if (message.sendId && message.id === optimisticMessageId(message.sendId)) return !confirmedSends.has(message.sendId);
    return index >= firstShared && streamed.has(message.id);
  });
  return [...snapshot.map((message) => streamed.get(message.id) ?? message), ...tail];
}

/** The rooms after a room frame or answer. The caller fences the transcript generation when it carries messages. */
export function patchedGroups(groups: Group[], group: GroupPatch): Group[] {
  const shown = groups.find((g) => g.id === group.id);
  // The server sends a transcript whenever a room changes thread, so a frame naming another thread without one is stale.
  const patch = shown && !group.messages && typeof group.threadId === "string" && group.threadId !== shown.threadId
    ? roomFieldsOnly(group)
    : group;
  if (!shown) return [{ ...(patch.description === null ? { ...patch, description: undefined } : patch) as Group, messages: patch.messages ?? [] }, ...groups];
  return groups.map((g) => (g.id === patch.id ? {
    ...g, ...patch,
    section: typeof patch.threadId === "string" || Object.hasOwn(patch, "section") ? patch.section : g.section,
    description: Object.hasOwn(patch, "description") ? (patch.description ?? undefined) : g.description,
    tasks: patch.tasks ? mergeTaskStamps(g.tasks, patch.tasks) : g.tasks,
    turnTimeoutMinutes: Object.hasOwn(patch, "turnTimeoutMinutes") ? (patch.turnTimeoutMinutes ?? undefined) : g.turnTimeoutMinutes,
    messages: patch.messages ?? g.messages,
    hasMore: patch.messages ? Boolean(patch.hasMore) : g.hasMore,
  } : g));
}

/** What a room answer patches, or null when a newer transcript of its thread arrived while it was on its way. */
export function snapshotPatch(state: AppState, { group, since, heldAtStart }: Extract<Action, { type: "groupSnapshot" }>): GroupPatch | null {
  if (!group.messages || !group.threadId) return group;
  if ((state.transcriptGeneration[group.threadId] ?? 0) !== (since[group.threadId] ?? 0)) return null;
  const shown = state.groups.find((g) => g.id === group.id);
  return shown?.threadId === group.threadId
    ? { ...group, messages: foldSnapshotOntoStreamed(shown.messages, new Set(heldAtStart), group.messages) }
    : group;
}

/** `roomAnswer(groupId, navigates)` before a room request; its result handles the answer. A switch counts as navigation. */
export function roomAnswers(current: () => AppState, dispatch: (action: Action) => void) {
  const navigation = new Map<string, number>();
  return (groupId: string, navigates: boolean) => {
    const revision = (navigation.get(groupId) ?? 0) + (navigates ? 1 : 0);
    navigation.set(groupId, revision);
    const { transcriptGeneration: since, groups } = current();
    const heldAtStart = groups.find((group) => group.id === groupId)?.messages ?? [];
    return (r: { group?: GroupPatch } | undefined) => {
      if (r?.group && navigation.get(groupId) === revision) dispatch({ type: "groupSnapshot", group: r.group, since, heldAtStart });
    };
  };
}
