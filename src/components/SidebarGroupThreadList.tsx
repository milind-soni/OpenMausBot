import { useMemo, useRef, useState } from "react";
import { useStore, type Group } from "@/state/store";
import { activeLocale, t } from "@/lib/i18n";
import { roomThreadSpeakerId, roomThreadWorking } from "@/lib/room-threads";
import type { SidebarDensity } from "@/lib/sidebar-preferences";
import { BulkSelectFilters, ThreadListFooter, deleteThreadsInBulk, useBulkSelect } from "./BulkSelectBar";
import { orderedThreadList, SidebarThreadRow, stampClock, threadRecency, useRelativeNow, useRevealedThreadRow, visibleSidebarThreads } from "./SidebarThreadRow";

export function GroupThreadList({ group, selected, density = "comfortable", query = "" }: { group: Group; selected: boolean; density?: SidebarDensity; query?: string }) {
  const { state, dispatch } = useStore();
  const now = useRelativeNow();
  const [showAll, setShowAll] = useState(false);
  const tasks = (group.tasks ?? [{ threadId: group.threadId, title: group.name, createdAt: group.createdAt }]).map((task) => {
    const speakerId = roomThreadSpeakerId(group, task.threadId);
    const waiting = Boolean(speakerId) && state.bots.find((bot) => bot.id === speakerId)?.activity === "waiting-on-you";
    return {
      ...task, busy: roomThreadWorking(group, task.threadId), unread: task.threadId === group.threadId && group.unread,
      activity: waiting ? "waiting-on-you" as const : undefined,
    };
  });
  const bulk = useBulkSelect();
  const visible = orderedThreadList(visibleSidebarThreads(tasks, group.threadId, query, [], showAll || bulk.active));
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
    onRename: (task: { threadId: string }, title: string) => dispatch({ type: "renameGroupTask", groupId, threadId: task.threadId, title }),
    onDelete: (task: { threadId: string }) => dispatch({ type: "deleteGroupTask", groupId, threadId: task.threadId }),
    onPin: (task: { threadId: string; title: string }, pinned: boolean) => dispatch({ type: "pinGroupTask", groupId, threadId: task.threadId, pinned, title: task.title }),
  }), [groupId, dispatch]);
  const locale = activeLocale();
  return <div className="mb-2 space-y-0.5" role="group" aria-label={t("task.namedList", { name: group.name })}>
    {bulk.active && <BulkSelectFilters rows={visible} selected={selection} now={now} onChange={bulk.setSelected} onDone={bulk.finish} />}
    {visible.map((task) => <SidebarThreadRow key={task.threadId} task={task} ownerId={group.id} current={selected && task.threadId === group.threadId} compact={density === "compact"}
      now={stampClock(threadRecency(task), now)} locale={locale} {...actions} selectMode={bulk.active} checked={selection.has(task.threadId)} onToggleSelect={bulk.toggle} />)}
    <ThreadListFooter bulk={bulk} rows={visible} selected={selection} total={tasks.length} canShowAll={!query && !showAll && tasks.length > visible.length} canSelect={tasks.length > 1 && !group.dm}
      onShowAll={() => setShowAll(true)} maxDeletable={tasks.length - 1} freshConversation={false} onDelete={(threadIds) => deleteThreadsInBulk({ groupId }, threadIds, dispatch)} />
  </div>;
}
