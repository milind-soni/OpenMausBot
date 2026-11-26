import { useMemo, useRef, useState } from "react";
import { Copy, Download, MoreHorizontal } from "lucide-react";
import { copyTranscriptToClipboard, downloadMarkdownTranscript, formatTranscriptMarkdown, slugifyTranscriptFilename } from "@/lib/export-transcript";
import { t } from "@/lib/i18n";
import { localizedTaskTitle } from "@/lib/task-title";
import type { Group, GroupTask, Message } from "@/state/store";
import { useStoreRef } from "@/state/store-ref";
import { roomThreadRowActions } from "../SidebarGroupThreadList";
import { THREAD_MENU_WIDTH, threadMenuAt, useThreadRowMenu, type ThreadMenuAt } from "../SidebarThreadRow";
import { ThreadRenameField } from "./ThreadRenameField";

const ITEM = "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[14px] leading-[18px] text-ink hover:bg-menu-hover disabled:opacity-40";

/** The title of a room thread open beside its feed, and its menu: what the feed row's menu offers, and the thread's
 * export, since its lines are loaded here. */
export function ThreadPanelHeading({ group, task, messages, working }: { group: Pick<Group, "id" | "name" | "tasks">; task: GroupTask; messages: readonly Message[]; working: boolean }) {
  const store = useStoreRef();
  const dispatch = store.dispatch;
  const [menu, setMenu] = useState<ThreadMenuAt | null>(null);
  const [renaming, setRenaming] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const title = localizedTaskTitle(task.title);
  const row = useMemo(() => ({ threadId: task.threadId, title: task.title, pinned: task.pinned, archivedAt: task.archivedAt, busy: working }),
    [task.threadId, task.title, task.pinned, task.archivedAt, working]);
  const actions = useMemo(() => roomThreadRowActions(group.id, dispatch), [group.id, dispatch]);
  const close = () => dispatch({ type: "closeForkPanel" });
  const markdown = () => formatTranscriptMarkdown({ title: task.title, messages, isGroup: true });
  const menuSheet = useThreadRowMenu({
    task: row, displayTitle: title, ownerId: group.id, menu, setMenu, actionRef: moreRef,
    onStartRename: () => { setMenu(null); setRenaming(true); },
    onDelete: (thread) => { close(); actions.onDelete(thread); },
    onPin: actions.onPin,
    onArchive: (thread, archivedAt) => { if (archivedAt !== null) close(); actions.onArchive(thread, archivedAt); },
    deletable: (group.tasks?.length ?? 1) > 1,
    extra: (done) => <>
      <button type="button" disabled={messages.length === 0} className={ITEM} onClick={() => { done(); void copyTranscriptToClipboard(markdown()); }}>
        <Copy size={16} aria-hidden="true" />{t("chat.export.copy")}
      </button>
      <button type="button" disabled={messages.length === 0} className={ITEM}
        onClick={() => { done(); downloadMarkdownTranscript(slugifyTranscriptFilename(task.title || group.name), markdown()); }}>
        <Download size={16} aria-hidden="true" />{t("chat.export.download")}
      </button>
    </>,
  });
  return <>
    <div className="min-w-0 flex-1">
      {renaming
        ? <ThreadRenameField title={task.title} className="block h-5 w-full px-1 py-0 text-[15px] font-semibold leading-5" onDone={(next) => { setRenaming(false); if (next) actions.onRename(task, next); }} />
        : <h2 dir="auto" title={title} className="truncate text-[15px] font-semibold leading-5 text-ink">{title}</h2>}
      <p dir="auto" className="truncate text-[12px] leading-4 text-ink-secondary">{group.name}</p>
    </div>
    <button ref={moreRef} type="button" aria-label={t("task.actions", { title })} title={t("task.actions", { title })} aria-expanded={Boolean(menu)}
      className="ui-icon-button shrink-0"
      onClick={(event) => { if (menu) { setMenu(null); return; } const rect = event.currentTarget.getBoundingClientRect(); setMenu(threadMenuAt(rect.right - THREAD_MENU_WIDTH, rect.bottom)); }}>
      <MoreHorizontal size={16} aria-hidden="true" />
    </button>
    {menuSheet}
  </>;
}
