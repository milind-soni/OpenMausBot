import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Search, X } from "lucide-react";
import { useModalDialog } from "@/hooks/use-modal-dialog";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { localizedTaskTitle } from "@/lib/task-title";
import type { BotProject, Task } from "@/state/store";
import { orderedThreadList, threadByline, threadRecency, threadUpdatedLabel, useRelativeNow, visibleSidebarThreads } from "./SidebarThreadRow";

type BrowserThread = Pick<Task, "threadId" | "title" | "createdAt" | "updatedAt" | "projectId" | "pinned" | "lastThreadOrderAt" | "openedBy" | "closedBy" | "archivedAt" | "snoozedUntil" | "busy" | "activity" | "unread">;
type BrowserProps = {
  tasks: BrowserThread[];
  folders?: BotProject[];
  name: string;
  currentThreadId: string;
  onOpen: (threadId: string) => void;
};

export function ThreadBrowser(props: BrowserProps) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" onClick={() => setOpen(true)} className="inline-flex min-h-8 items-center gap-1 rounded px-1 text-[13px] font-medium text-ink-secondary hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus">
      {t("task.switch")} <span className="text-[11px] tabular-nums text-ink-tertiary">{props.tasks.length}</span>
    </button>
    {open && <ThreadBrowserDialog {...props} onClose={() => setOpen(false)} />}
  </>;
}

function ThreadBrowserDialog({ tasks, folders = [], name, currentThreadId, onOpen, onClose }: BrowserProps & { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const dialog = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const titleId = useId();
  useModalDialog(dialog, onClose);
  useEffect(() => { input.current?.focus(); }, []);
  const now = useRelativeNow();
  const matches = orderedThreadList(visibleSidebarThreads(tasks, currentThreadId, query, folders, true));
  const openThread = (threadId: string) => { onOpen(threadId); onClose(); };

  return createPortal(<div data-thread-overlay className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
    onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialog} role="dialog" tabIndex={-1} aria-modal="true" aria-labelledby={titleId}
      className="flex max-h-[min(85dvh,700px)] w-full max-w-[520px] flex-col overflow-hidden rounded-2xl border border-hairline/50 bg-panel text-ink shadow-2xl">
      <div className="flex items-center justify-between gap-3 border-b border-hairline/40 px-4 py-3">
        <div className="min-w-0">
          <h2 id={titleId} className="text-[15px] font-semibold">{t("task.switch")}</h2>
          <p dir="auto" className="truncate text-[12px] text-ink-secondary">{name}</p>
        </div>
        <button type="button" onClick={onClose} aria-label={t("common.close")} className="shrink-0 rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink"><X size={16} /></button>
      </div>
      <div className="px-4 py-3">
        <div className="flex items-center gap-2 rounded-lg border border-hairline/50 bg-inset px-2 focus-within:border-focus">
          <Search size={14} aria-hidden="true" className="shrink-0 text-ink-secondary" />
          <input ref={input} value={query} onChange={(event) => setQuery(event.target.value)} aria-label={t("task.search")} placeholder={t("task.search")}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing && matches[0]) { event.preventDefault(); openThread(matches[0].threadId); }
            }} className="min-w-0 flex-1 bg-transparent py-2 text-[14px] text-ink placeholder:text-ink-tertiary focus:outline-none" />
          {query && <button type="button" aria-label={t("task.bulk.clear")} onClick={() => { setQuery(""); input.current?.focus(); }} className="rounded p-1 text-ink-secondary hover:bg-raised"><X size={14} /></button>}
        </div>
        <p role="status" className="mt-2 text-[11px] text-ink-secondary">{query.trim() ? t("task.matching", { count: matches.length }) : `${t("task.list")} · ${matches.length}`}</p>
      </div>
      <div className="min-h-0 overflow-y-auto px-2 pb-2" role="group" aria-label={t("task.list")}>
        {matches.length === 0 && <p className="px-2 py-8 text-center text-[13px] text-ink-secondary">{tasks.length ? t("task.noMatch", { query: query.trim() }) : t("task.empty")}</p>}
        {matches.map((task) => {
          const current = task.threadId === currentThreadId;
          const folder = folders.find((entry) => entry.id === task.projectId);
          const byline = threadByline(task);
          return <button key={task.threadId} type="button" data-thread-browser-row={task.threadId} aria-current={current ? "page" : undefined}
            onClick={() => openThread(task.threadId)} className={cn("flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus", current ? "bg-raised" : "hover:bg-raised/50")}>
            <Check size={14} aria-hidden="true" className={cn("mt-0.5 shrink-0", current ? "text-accent" : "opacity-0")} />
            <span className="min-w-0 flex-1">
              <span dir="auto" className="block break-words text-[14px] leading-5">{localizedTaskTitle(task.title)}</span>
              <span className="block text-[11px] text-ink-secondary">{[folder?.name, byline, threadUpdatedLabel(threadRecency(task), now)].filter(Boolean).join(" · ")}</span>
            </span>
          </button>;
        })}
      </div>
    </div>
  </div>, document.body);
}
