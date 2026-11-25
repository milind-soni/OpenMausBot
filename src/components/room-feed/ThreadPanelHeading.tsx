import { useMemo, useRef, useState } from "react";
import { Check, Copy, Download, MoreHorizontal, Search, Timer } from "lucide-react";
import { requestChatFind } from "@/lib/chat-find";
import { copyTranscriptToClipboard, downloadMarkdownTranscript, formatTranscriptMarkdown, slugifyTranscriptFilename } from "@/lib/export-transcript";
import { t } from "@/lib/i18n";
import { localizedTaskTitle } from "@/lib/task-title";
import { threadRowCloser } from "@/lib/room-thread-close";
import type { Group, GroupTask, Message } from "@/state/store";
import { useStoreRef } from "@/state/store-ref";
import { PRESET_TURN_LIMITS, useConversationTurnLimit } from "../ConversationTurnLimit";
import { roomThreadRowActions } from "../SidebarGroupThreadList";
import { THREAD_MENU_WIDTH, threadMenuAt, threadUpdatedLabel, useRelativeNow, useThreadRowMenu, type ThreadMenuAt } from "../SidebarThreadRow";
import { ThreadRenameField } from "./ThreadRenameField";

const ITEM = "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[14px] leading-[18px] text-ink hover:bg-menu-hover disabled:opacity-40";

/** The title of a room thread open beside its feed, and its menu: what the feed row's menu offers, and what the room's
 * header and menu offered for its one thread before the feed: find, the export (its lines are loaded here) and its
 * time per turn. */
export function ThreadPanelHeading({ group, task, messages, working }: { group: Group; task: GroupTask; messages: readonly Message[]; working: boolean }) {
  const store = useStoreRef();
  const dispatch = store.dispatch;
  const [menu, setMenu] = useState<ThreadMenuAt | null>(null);
  const [renaming, setRenaming] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const title = localizedTaskTitle(task.title);
  const closer = useMemo(() => threadRowCloser(task), [task]);
  const row = useMemo(() => ({ threadId: task.threadId, title: task.title, pinned: task.pinned, archivedAt: task.archivedAt, busy: working, closedBy: closer }),
    [task.threadId, task.title, task.pinned, task.archivedAt, working, closer]);
  const now = useRelativeNow();
  const actions = useMemo(() => roomThreadRowActions(group.id, dispatch), [group.id, dispatch]);
  const close = () => dispatch({ type: "closeForkPanel" });
  const markdown = () => formatTranscriptMarkdown({ title: task.title, messages, isGroup: true });
  const limit = useConversationTurnLimit({ ...group, threadId: task.threadId });
  const limits: Array<{ key: string; minutes: number | null; label: string }> = [
    { key: "default", minutes: null, label: t("room.turnLimit.default", { minutes: limit.globalMinutes }) },
    ...PRESET_TURN_LIMITS.map((minutes) => ({ key: String(minutes), minutes, label: t("room.turnLimit.minutes", { minutes }) })),
    ...(limit.saved !== null && !(PRESET_TURN_LIMITS as readonly number[]).includes(limit.saved) ? [{ key: "custom", minutes: limit.saved, label: t("room.turnLimit.minutes", { minutes: limit.saved }) }] : []),
  ];
  const menuSheet = useThreadRowMenu({
    task: row, displayTitle: title, ownerId: group.id, menu, setMenu, actionRef: moreRef,
    onStartRename: () => { setMenu(null); setRenaming(true); },
    onDelete: (thread) => { close(); actions.onDelete(thread); },
    onPin: actions.onPin,
    onSetClosed: actions.onSetClosed,
    onArchive: (thread, archivedAt) => { if (archivedAt !== null) close(); actions.onArchive(thread, archivedAt); },
    deletable: (group.tasks?.length ?? 1) > 1,
    extra: (done) => <>
      <button type="button" data-thread-find="" className={ITEM} onClick={() => { done(); requestChatFind(task.threadId); }}>
        <Search size={16} aria-hidden="true" />{t("chat.find")}
      </button>
      <button type="button" disabled={messages.length === 0} className={ITEM} onClick={() => { done(); void copyTranscriptToClipboard(markdown()); }}>
        <Copy size={16} aria-hidden="true" />{t("chat.export.copy")}
      </button>
      <button type="button" disabled={messages.length === 0} className={ITEM}
        onClick={() => { done(); downloadMarkdownTranscript(slugifyTranscriptFilename(task.title || group.name), markdown()); }}>
        <Download size={16} aria-hidden="true" />{t("chat.export.download")}
      </button>
      <div data-thread-turn-limit="" className="px-2 pt-1">
        <span className="flex items-center gap-2 text-[12px] font-medium text-ink-secondary"><Timer size={16} aria-hidden="true" />{t("room.panel.turnLimit")}</span>
        <div className="mt-0.5 flex flex-col">
          {limits.map((option) => (
            <button key={option.key} type="button" aria-pressed={limit.saved === option.minutes} className={ITEM} onClick={() => { done(); limit.save(option.minutes); }}>
              <Check size={14} aria-hidden="true" className={limit.saved === option.minutes ? "" : "invisible"} />{option.label}
            </button>
          ))}
        </div>
      </div>
    </>,
  });
  return <>
    <div className="min-w-0 flex-1">
      {renaming
        ? <ThreadRenameField title={task.title} className="block h-5 w-full px-1 py-0 text-[15px] font-semibold leading-5" onDone={(next) => { setRenaming(false); if (next) actions.onRename(task, next); }} />
        : <h2 dir="auto" title={title} className="truncate text-[15px] font-semibold leading-5 text-ink">{title}</h2>}
      {closer
        ? <p data-thread-closed="" className="truncate text-[12px] leading-4 text-ink-tertiary">
          {t("room.thread.closedBy", { name: closer.name, when: threadUpdatedLabel(closer.at, now) })}
        </p>
        : <p dir="auto" className="truncate text-[12px] leading-4 text-ink-secondary">{group.name}</p>}
    </div>
    {closer && <button type="button" data-thread-reopen="" className="ui-button ui-button-sm shrink-0" onClick={() => actions.onSetClosed(task, false)}>{t("task.reopenThread")}</button>}
    <button ref={moreRef} type="button" aria-label={t("task.actions", { title })} title={t("task.actions", { title })} aria-expanded={Boolean(menu)}
      className="ui-icon-button shrink-0"
      onClick={(event) => { if (menu) { setMenu(null); return; } const rect = event.currentTarget.getBoundingClientRect(); setMenu(threadMenuAt(rect.right - THREAD_MENU_WIDTH, rect.bottom)); }}>
      <MoreHorizontal size={16} aria-hidden="true" />
    </button>
    {menuSheet}
  </>;
}
