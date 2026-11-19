import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Check, Inbox, Maximize2, Minimize2, Search, X } from "lucide-react";
import type { InboxRow, InboxTab } from "../../../shared/inbox";
import { cn } from "@/lib/cn";
import { useAdvancedMode } from "@/lib/interface-mode";
import { t } from "@/lib/i18n";
import { PHONE_LAYOUT, useMediaQuery } from "@/lib/use-media-query";
import { closeInbox, markAllInboxRead, readInboxLine, readInboxRow, useInboxMarkingAll, useInboxPanel, useInboxView, widenInbox } from "@/state/inbox";
import { useStore } from "@/state/store";
import { InboxActive, inboxAttentionEntries, inboxOpenThread, readNewsThreads, unreadConversations } from "./InboxActive";
import { attentionJumpAction, attentionUnpinAction } from "../SidebarBotActivity";
import { InboxReading } from "./InboxReading";
import { InboxRowItem } from "./InboxRow";
import { FinishedThreads } from "./FinishedThreads";
import { PinnedThreads, pinnedThreadRows } from "./PinnedThreads";
import { matchesSearch, nextAfter } from "./inbox-answer";
import { listedRows, rowsIn, waitingCount } from "./inbox-view";
import { useInboxActions } from "./use-inbox-actions";
import { Select } from "../Select";
import { roundButtonCls } from "../bot-panel/rows";

const STATUS_LABELS = {
  all: "inbox.status.all",
  "needs-you": "needsYou.title",
  info: "inbox.status.info",
  done: "common.done",
} as const satisfies Record<InboxTab | "all", string>;

type StatusFilter = keyof typeof STATUS_LABELS;

export function InboxPanel() {
  const view = useInboxView();
  const { state, dispatch } = useStore();
  const panel = useInboxPanel();
  const markingAll = useInboxMarkingAll();
  const phone = useMediaQuery(PHONE_LAYOUT);
  const simple = !useAdvancedMode();
  const { run, openInChat } = useInboxActions(view);
  const [now, setNow] = useState(() => Date.now());
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const statusControl = useRef<HTMLSelectElement>(null);
  const doneId = useId();
  const [showDone, setShowDone] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    if (panel.reading) readInboxLine(null);
    else closeInbox();
  };
  const reading = panel.reading ? view?.rows.find((row) => row.id === panel.reading) : undefined;
  const openDetail = (row: InboxRow) => {
    readInboxRow(row);
    readInboxLine(row.id);
  };
  const open = (row: InboxRow) => {
    if (row.tab === "needs-you" || row.replies) openDetail(row);
    else openInChat(row);
  };
  const searching = Boolean(query.trim());
  const filtering = searching || status !== "all";
  const rows = useMemo(() => listedRows(view).filter((row) => (status === "all" || row.tab === status) && matchesSearch(row, query)), [view, status, query]);
  const done = useMemo(() => status === "all" || status === "done"
    ? rowsIn(view, "done").filter((row) => matchesSearch(row, query)).sort((a, b) => b.at - a.at)
    : [], [view, status, query]);
  const forceDoneOpen = status === "done" || searching;
  const doneOpen = forceDoneOpen || showDone;
  const visible = useMemo(() => doneOpen ? [...rows, ...done] : rows, [doneOpen, rows, done]);
  const at = visible.findIndex((row) => row.id === panel.reading);

  const previous = useRef<{ reading: InboxRow | undefined; visible: InboxRow[]; status: StatusFilter; query: string }>(null);
  useEffect(() => {
    const before = previous.current;
    previous.current = { reading, visible, status, query };
    if (!panel.open) return;
    if (!panel.reading) {
      if (before?.reading && document.activeElement === document.body) statusControl.current?.focus();
      return;
    }
    if (reading?.tab === "done" && before?.reading?.id === reading.id && before.reading.tab !== "done"
      && before.status === status && before.query === query) {
      const ids = new Set(visible.map((row) => row.id));
      const order = before.visible.filter((row) => row.id === reading.id || ids.has(row.id)).map((row) => row.id);
      const next = nextAfter(order, reading.id);
      const row = visible.find((item) => item.id === next);
      if (row) {
        readInboxRow(row);
        readInboxLine(row.id);
        if (document.activeElement === document.body) statusControl.current?.focus();
        return;
      }
      statusControl.current?.focus();
      readInboxLine(null);
    } else if (view && at < 0) {
      if (document.activeElement === document.body) statusControl.current?.focus();
      readInboxLine(null);
    }
  }, [at, panel.open, panel.reading, query, reading, status, view, visible]);

  const step = (by: -1 | 1) => {
    const row = at >= 0 ? visible[at + by] : undefined;
    if (row) open(row);
  };
  const pinnedThreads = new Set(pinnedThreadRows(state.bots, state.groups, state.pendingQueued).map((row) => row.task.threadId));
  const count = waitingCount(view) + unreadConversations(inboxAttentionEntries(state, view), view);
  const openThread = inboxOpenThread(state);
  const body = (
    <>
      <div className="flex h-[50px] shrink-0 items-start gap-2.5 px-[13px] pt-[13px]">
        <div data-inbox-tab-chip className="flex h-[34px] min-w-0 flex-1 items-center gap-2 ps-1 text-[14px]">
          <Inbox size={16} aria-hidden="true" className="shrink-0 text-ink-secondary" />
          <span className="min-w-0 truncate font-medium text-ink">{t("inbox.panel.title")}</span>
          {count > 0 && <span data-inbox-tab-count className="shrink-0 tabular-nums text-ink-tertiary">{count}</span>}
        </div>
        {view?.rows.some((row) => row.unread) && (
          <button type="button" data-inbox-mark-all onClick={markAllInboxRead} disabled={markingAll}
            className="mt-[9px] shrink-0 whitespace-nowrap text-[12px] text-accent hover:underline disabled:opacity-50 disabled:hover:no-underline">
            {t("inbox.markAllRead")}
          </button>
        )}
        {!phone && (
          <button type="button" onClick={() => widenInbox(!panel.wide)} aria-pressed={Boolean(panel.wide)} aria-label={t(panel.wide ? "inbox.action.narrow" : "inbox.action.widen")}
            title={t(panel.wide ? "inbox.action.narrow" : "inbox.action.widen")} className={roundButtonCls}>
            {panel.wide ? <Minimize2 size={15} aria-hidden="true" /> : <Maximize2 size={15} aria-hidden="true" />}
          </button>
        )}
        <button type="button" onClick={closeInbox} aria-label={t("inbox.action.closePanel")} title={t("inbox.action.closePanel")} className={roundButtonCls}>
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="mx-[13px] my-2.5 flex shrink-0 flex-wrap items-center gap-2">
          <label className="flex h-8 min-w-0 flex-1 basis-24 items-center gap-2 rounded-lg bg-ink/[0.045] px-2.5 ring-[0.5px] ring-ink/[0.12] focus-within:ring-focus">
            <Search size={14} aria-hidden="true" className="shrink-0 text-ink-tertiary" />
            <input dir="auto" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("inbox.search")} aria-label={t("inbox.search")}
              className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-tertiary [&::-webkit-search-cancel-button]:hidden" />
          </label>
          <Select ref={statusControl} aria-label={t("inbox.status")} value={status} size="sm" variant="quiet"
            className="max-w-full" onChange={(event) => setStatus(event.target.value as StatusFilter)}>
            {(Object.keys(STATUS_LABELS) as StatusFilter[]).map((value) => <option key={value} value={value}>{t(STATUS_LABELS[value])}</option>)}
          </Select>
        </div>
        {reading && view && at >= 0 ? (
          <InboxReading view={view} row={reading} now={now} position={{ index: at, count: visible.length }} onStep={step} />
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            {!searching && <PinnedThreads bots={state.bots} groups={state.groups} queued={state.pendingQueued} now={now} current={openThread} onOpen={(row) => dispatch(attentionJumpAction(row))} onUnpin={(row) => dispatch(attentionUnpinAction(row))} />}
            <div role="list" data-inbox-list aria-label={t("inbox.panel.title")} className="space-y-0.5 px-1.5 pb-1.5">
              {rows.length === 0 && done.length === 0
                ? filtering
                  ? <p role="status" className="px-4 py-8 text-center text-[13px] text-ink-secondary">{t("inbox.noMatch")}</p>
                  : (
                    <div data-inbox-empty className="mx-auto flex max-w-[16rem] flex-col items-center px-4 py-10 text-center">
                      <Inbox size={22} strokeWidth={1.5} aria-hidden="true" className="text-ink-tertiary" />
                      <p className="mt-3 text-[14px] font-medium text-ink">{t("inbox.empty")}</p>
                      <p className="mt-1 text-[13px] leading-[18px] text-ink-tertiary">{t("inbox.emptyHint")}</p>
                    </div>
                  )
                : rows.map((row) => <InboxRowItem key={row.id} row={row} now={now} onOpen={open} onAction={run} />)}
            </div>
            {!searching && <InboxActive view={view} current={openThread} exclude={pinnedThreads} />}
            {!searching && <FinishedThreads bots={state.bots} groups={state.groups} queued={state.pendingQueued} readThreads={readNewsThreads(view)} exclude={pinnedThreads} now={now} current={openThread} onOpen={(row) => dispatch(attentionJumpAction(row))} />}
            {done.length > 0 && (
              <section data-inbox-done className="px-1.5 pb-1.5">
                {forceDoneOpen ? (
                  <h2 className="flex items-center gap-1.5 px-2 py-1.5 text-[12px] font-medium text-ink-secondary">
                    <Check size={13} aria-hidden="true" />{t("common.done")}
                  </h2>
                ) : (
                  <button type="button" data-inbox-done-toggle aria-controls={doneId} aria-expanded={doneOpen} onClick={() => setShowDone(!showDone)}
                    className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-[12px] text-ink-tertiary hover:bg-raised/70 hover:text-ink-secondary">
                    <Check size={13} aria-hidden="true" className="shrink-0" />
                    <span className="font-medium">{t("common.done")}</span>
                    <span className="tabular-nums">{done.length}</span>
                  </button>
                )}
                <div id={doneId} hidden={!doneOpen}>
                  {doneOpen && done.map((row) => <InboxRowItem key={row.id} row={row} now={now} onOpen={open} onAction={run} />)}
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </>
  );
  if (phone) {
    return createPortal(
      <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/40" onMouseDown={(event) => { if (event.target === event.currentTarget) closeInbox(); }}>
        <section role="dialog" aria-modal="true" aria-label={t("inbox.panel.title")} data-inbox-panel="sheet" onKeyDown={onKeyDown}
          className="animate-pop-in motion-reduce:animate-none flex max-h-[85dvh] min-h-[50dvh] flex-col overflow-hidden rounded-t-2xl border-t border-hairline/50 bg-panel pb-[env(safe-area-inset-bottom)]">
          {body}
        </section>
      </div>,
      document.body,
    );
  }
  return (
    <aside aria-label={t("inbox.panel.title")} data-inbox-panel="side" data-look="inbox" data-wide={panel.wide ? "" : undefined} onKeyDown={onKeyDown}
      className={cn("animate-panel-in motion-reduce:animate-none flex h-full max-w-full shrink-0 flex-col max-md:absolute max-md:inset-y-0 max-md:right-0 max-md:z-30",
        simple ? "border-l-[0.5px] border-ink/[0.06] bg-app" : "border-l border-hairline/40 bg-panel",
        panel.wide ? "w-[min(640px,60vw)]" : simple ? "w-[320px]" : "w-[380px]")}>
      {body}
    </aside>
  );
}
