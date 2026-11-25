import { useMemo, useRef, useState, type Dispatch } from "react";
import { useStore, type Action, type Group } from "@/state/store";
import { activeLocale, t } from "@/lib/i18n";
import { roomThreadAttention, roomThreadWorking } from "@/lib/room-threads";
import { setRoomThreadClosed, threadRowCloser } from "@/lib/room-thread-close";
import { BulkSelectFilters, ThreadListFooter, deleteThreadsInBulk, useBulkSelect } from "./BulkSelectBar";
import { orderedThreadList, SidebarThreadRow, stampClock, threadRecency, useRelativeNow, useRevealedThreadRow, visibleSidebarThreads } from "./SidebarThreadRow";

/** The store actions behind a room's thread-row menu, for every list that draws that room's threads. */
export function roomThreadRowActions(groupId: string, dispatch: Dispatch<Action>) {
  return {
    onRename: (task: { threadId: string }, title: string) => dispatch({ type: "renameGroupTask", groupId, threadId: task.threadId, title }),
    onDelete: (task: { threadId: string }) => dispatch({ type: "deleteGroupTask", groupId, threadId: task.threadId }),
    onPin: (task: { threadId: string; title: string }, pinned: boolean) => dispatch({ type: "pinGroupTask", groupId, threadId: task.threadId, pinned, title: task.title }),
    onArchive: (task: { threadId: string }, archivedAt: number | null) => dispatch({ type: "archiveGroupTask", groupId, threadId: task.threadId, archivedAt }),
    onSetClosed: (task: { threadId: string }, closed: boolean) => setRoomThreadClosed(groupId, task.threadId, closed, dispatch),
  };
}

export function GroupThreadList({ group, selected, query = "" }: { group: Group; selected: boolean; query?: string }) {
  const { state, dispatch } = useStore();
  const now = useRelativeNow();
  const [showAll, setShowAll] = useState(false);
  const tasks = (group.tasks ?? [{ threadId: group.threadId, title: group.name, createdAt: group.createdAt }]).map((task) => {
    const { waiting, unread } = roomThreadAttention(group, task, state.bots);
    return { ...task, busy: roomThreadWorking(group, task.threadId), unread, activity: waiting ? "waiting-on-you" as const : undefined, closedBy: undefined };
  });
  const bulk = useBulkSelect();
  // A closed room thread stays in the list, marked; only the feed folds them.
  const visible = orderedThreadList(visibleSidebarThreads(tasks, group.threadId, query, [], showAll || bulk.active))
    .map((task) => ({ ...task, closedBy: threadRowCloser(task) }));
  const selection = bulk.forRows(visible);
  useRevealedThreadRow(state.revealThread, selected ? group.threadId : null);
  const latest = useRef(group);
  latest.current = group;
  const groupId = group.id;
  const actions = useMemo(() => ({
    onSelect: (task: { threadId: string }) => {
      if (task.threadId !== latest.current.threadId) dispatch({ type: "switchGroupTask", groupId, threadId: task.threadId });
      else dispatch({ type: "select", id: groupId });
    },
    ...roomThreadRowActions(groupId, dispatch),
  }), [groupId, dispatch]);
  const locale = activeLocale();
  return <div className="mb-2 space-y-0.5" role="group" aria-label={t("task.namedList", { name: group.name })}>
    {bulk.active && <BulkSelectFilters rows={visible} selected={selection} now={now} onChange={bulk.setSelected} onDone={bulk.finish} />}
    {visible.map((task) => <SidebarThreadRow key={task.threadId} task={task} ownerId={group.id} current={selected && task.threadId === group.threadId}
      now={stampClock(threadRecency(task), now)} locale={locale} {...actions} selectMode={bulk.active} checked={selection.has(task.threadId)} onToggleSelect={bulk.toggle} />)}
    <ThreadListFooter bulk={bulk} rows={visible} selected={selection} total={tasks.length} canShowAll={!query && !showAll && tasks.length > visible.length} canSelect={tasks.length > 1 && !group.dm}
      onShowAll={() => setShowAll(true)} maxDeletable={tasks.length - 1} freshConversation={false} onDelete={(threadIds) => deleteThreadsInBulk({ groupId }, threadIds, dispatch)} />
  </div>;
}
