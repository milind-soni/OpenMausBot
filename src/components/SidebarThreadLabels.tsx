import { useLayoutEffect, useRef, useState, type Dispatch, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ChevronRight, Clock3, Loader2, Pin, Plus, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { nextRename } from "@/lib/rename";
import { localizedTaskTitle } from "@/lib/task-title";
import { setThreadsUnfolded, useThreadsUnfolded } from "@/lib/thread-fold-preferences";
import type { Action, AppState, Bot } from "@/state/store";
import { botOpensTo } from "@/state/thread-navigation";
import { canUnfold, openThreadPinned, threadLabels, type LabelRow } from "./sidebar-thread-labels";
import { isWorking } from "./SidebarThreadRow";
import { showAllConversations } from "./bot-panel/Conversations";
import { reducedMotion } from "./MenuMotion";
import { UndoToast, useUndoToast } from "./UndoToast";
import { MainThreadMark } from "./SidebarRowMarkers";

const SLOT = "pointer-events-none absolute end-[30px] top-1.5 flex size-6 items-center justify-center rounded-lg text-ink-secondary opacity-0 transition-opacity hover:bg-raised hover:text-ink group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 max-md:hidden touch:pointer-events-auto touch:opacity-70 motion-reduce:transition-none";
const ROW = "group/label relative flex h-8 w-full min-w-0 items-center gap-2 rounded-lg ps-2.5 pe-2 text-start text-[13px] leading-[18px] outline-none transition-colors duration-[120ms] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus motion-reduce:transition-none";
/** Below tablet width a row's hover controls show at rest, so the fold chevron does too, under the row's ⋯ (its time
 * sits where it is on a wide row): a bot unfolded in a wide window can still be folded after the window narrows. */
const FOLD_SLOT = cn(SLOT, "max-md:flex max-md:pointer-events-auto max-md:opacity-70 max-md:top-auto max-md:bottom-1.5 max-md:end-[3px]");
const FOLD_MS = 200;
const STAGGER_MS = 25;
/** Rows past the fourth arrive with it, so the slide stays near 250ms however many there are. */
const STAGGER_STEPS = 3;
const YIELDS = "group-hover/label:[mask-image:linear-gradient(to_left,transparent_20px,black_36px)] rtl:group-hover/label:[mask-image:linear-gradient(to_right,transparent_20px,black_36px)]";

type FoldBot = Pick<Bot, "id" | "name" | "tasks">;
type FillBot = FoldBot & Pick<Bot, "threadId" | "switchingTo">;

export const threadLabelsId = (botId: string) => `thread-labels-${botId}`;

/** Simple mode's chevron on a bot row: unfolds the bot's threads under it. A bot with one thread gets New thread here. */
export function ThreadFoldChevron({ bot, dispatch }: { bot: FoldBot; dispatch: Dispatch<Action> }) {
  const unfolded = useThreadsUnfolded(bot.id);
  if (!canUnfold(bot)) {
    return <button type="button" data-bot-new-thread={bot.id} aria-label={t("task.newShort")} title={t("task.newShort")}
      onClick={() => dispatch({ type: "newTask", botId: bot.id })} className={SLOT}><Plus size={14} /></button>;
  }
  const label = t(unfolded ? "task.collapseNamed" : "task.expandNamed", { name: bot.name });
  return (
    <button type="button" data-bot-threads-fold={bot.id} aria-expanded={unfolded} aria-controls={unfolded ? threadLabelsId(bot.id) : undefined}
      aria-label={label} title={label} onClick={() => setThreadsUnfolded(bot.id, !unfolded)}
      className={cn(FOLD_SLOT, unfolded && "pointer-events-auto opacity-100")}>
      <ChevronRight size={14} aria-hidden="true" className={cn("transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none rtl:-scale-x-100", unfolded && "rotate-90 rtl:-rotate-90")} />
    </button>
  );
}

/** Whether one of the rows under the bot carries the selected fill instead of its row (it is unfolded, or the open thread
 * is pinned): not while its blank New thread chat (`drafting`) is open, which has no row of its own yet. */
export function useFillOnLabel(bot: FillBot, drafting = false): boolean {
  return ((useThreadsUnfolded(bot.id) && canUnfold(bot)) || openThreadPinned(bot)) && !drafting;
}

function StatusMark({ row }: { row: LabelRow }) {
  switch (row.status) {
    case "waiting": return <span className="shrink-0 text-[12px] leading-4 text-warning">{t("task.waiting")}</span>;
    case "working": return <Loader2 size={14} role="img" aria-label={t("chat.activity.working")} className="shrink-0 animate-spin text-success motion-reduce:animate-none" />;
    case "teammate": return <Clock3 size={14} role="img" aria-label={t("task.waitingOnTeammate")} className="shrink-0 text-warning" />;
    case "queued": return <Clock3 size={14} role="img" aria-label={t("task.queued")} className="shrink-0 text-ink-tertiary" />;
    case "unread": return <span role="img" aria-label={t("task.unread")} className="size-1.5 shrink-0 rounded-full bg-accent" />;
    default: return null;
  }
}

/** The rows under a bot in Simple mode's sidebar: what is going on while folded, the bot's active threads unfolded. */
export function SidebarThreadLabels({ bot, selected, drafting = false, rowThreadId, pendingQueued, dispatch }: {
  bot: Bot; selected: boolean; drafting?: boolean; rowThreadId: string; pendingQueued: AppState["pendingQueued"]; dispatch: Dispatch<Action>;
}) {
  const unfolded = useThreadsUnfolded(bot.id) && canUnfold(bot);
  const current = selected && !drafting ? bot.switchingTo ?? bot.threadId : undefined;
  const { rows, more, runningMore } = threadLabels(bot, pendingQueued, { unfolded, current, rowThreadId, now: Date.now() });
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [toast, setToast] = useUndoToast();
  const [focusAt, setFocusAt] = useState<number | null>(null);
  const finishing = useRef(false);
  const tree = useRef<HTMLDivElement>(null);
  // Folding plays the unfold backwards: the rows that go fade out in place before the list shortens. So does a row
  // that leaves because it was unpinned.
  const shown = useRef({ unfolded, rows, more });
  const [leaving, setLeaving] = useState<{ rows: LabelRow[]; gone: ReadonlySet<string>; more: number } | null>(null);
  const pins = rows.filter((row) => row.pinned).map((row) => row.task.threadId).join("\n");
  useLayoutEffect(() => {
    const was = shown.current;
    const kept = new Set(rows.map((row) => row.task.threadId));
    const folding = was.unfolded && !unfolded;
    const gone = was.rows.filter((row) => !kept.has(row.task.threadId) && (folding || row.pinned));
    if (!gone.length || reducedMotion()) { setLeaving(null); return; }
    setLeaving({ rows: was.rows, gone: new Set(gone.map((row) => row.task.threadId)), more: was.more });
    const timer = window.setTimeout(() => setLeaving(null), FOLD_MS);
    return () => window.clearTimeout(timer);
  }, [unfolded, pins]);
  useLayoutEffect(() => { shown.current = { unfolded, rows, more }; });
  if (!rows.length && !more && !runningMore && !toast && !leaving) return null;

  const items = () => Array.from(tree.current?.querySelectorAll<HTMLElement>("[role=treeitem]") ?? []);
  const focusItem = (index: number) => { setFocusAt(index); items()[index]?.focus(); };
  const open = (threadId: string) => dispatch({ type: "switchTask", botId: bot.id, threadId });
  const openPanel = () => {
    showAllConversations(bot.id);
    dispatch({ type: "toggleSettings", open: true, botId: bot.id });
    requestAnimationFrame(() => requestAnimationFrame(() => document.querySelector('[data-panel-card="conversations"]')?.scrollIntoView({ block: "nearest" })));
  };
  const hideable = (row: LabelRow) => !row.main && !row.task.sharedChat && !isWorking(row.task);
  const hide = (row: LabelRow) => {
    if (!hideable(row)) return;
    if (row.current) open(botOpensTo(bot, false));
    dispatch({ type: "updateTask", botId: bot.id, threadId: row.task.threadId, patch: { archivedAt: Date.now() } });
    setToast({ text: t("sidebar.threads.hidden"), undo: () => dispatch({ type: "updateTask", botId: bot.id, threadId: row.task.threadId, patch: { archivedAt: null } }) });
  };
  const startRename = (row: LabelRow) => {
    if (row.task.sharedChat) return;
    finishing.current = false;
    setDraft(row.task.title);
    setRenaming(row.task.threadId);
  };
  const finishRename = (row: LabelRow, save: boolean, refocus: boolean) => {
    if (finishing.current) return;
    finishing.current = true;
    const title = save ? nextRename(row.task.title, draft) : null;
    setRenaming(null);
    if (title) dispatch({ type: "renameTask", botId: bot.id, threadId: row.task.threadId, title });
    if (refocus) requestAnimationFrame(() => tree.current?.querySelector<HTMLElement>(`[data-thread-label="${CSS.escape(row.task.threadId)}"]`)?.focus());
  };
  const onKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (renaming || event.target instanceof HTMLInputElement) return;
    const list = items(), at = list.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    const to = event.key === "ArrowDown" ? Math.min(at + 1, list.length - 1) : event.key === "ArrowUp" ? Math.max(at - 1, 0)
      : event.key === "Home" ? 0 : event.key === "End" ? list.length - 1 : null;
    if (to !== null) { event.preventDefault(); focusItem(to); return; }
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); list[at]?.click(); return; }
    if (event.key === "ArrowLeft" && unfolded) {
      event.preventDefault();
      setThreadsUnfolded(bot.id, false);
      document.querySelector<HTMLElement>(`[data-bot-threads-fold="${CSS.escape(bot.id)}"]`)?.focus();
      return;
    }
    const row = rows[at];
    if (!row) return;
    if (event.key === "F2") { event.preventDefault(); startRename(row); }
    else if (event.key === "Delete") { event.preventDefault(); hide(row); }
  };
  const stop = Math.min(focusAt ?? Math.max(0, rows.findIndex((row) => row.current)), rows.length + Number(more > 0) + Number(runningMore > 0) - 1);
  const roving = (index: number) => (index === stop ? 0 : -1);
  const stagger = (index: number) => ({ animationDelay: `${Math.min(index, STAGGER_STEPS) * STAGGER_MS}ms` });
  const FOLDING = "pointer-events-none animate-pop-out motion-reduce:animate-none";
  const QUIET = cn(ROW, "animate-msg-in text-ink-tertiary [animation-fill-mode:backwards] hover:bg-ink/[0.06] hover:text-ink-secondary motion-reduce:animate-none");

  return <>
    <div ref={tree} id={threadLabelsId(bot.id)} role="tree" aria-label={t("task.namedList", { name: bot.name })} data-thread-labels={bot.id}
      onKeyDown={onKey} className="mb-1 ms-11 me-1 flex flex-col gap-0.5">
      {(leaving?.rows ?? rows).map((row, index) => {
        const title = localizedTaskTitle(row.task.title);
        const gone = leaving?.gone.has(row.task.threadId) === true;
        return (
          <div key={row.task.threadId} role="treeitem" aria-hidden={gone || undefined} inert={gone || undefined} aria-level={1} aria-selected={row.current} aria-current={row.current ? "page" : undefined}
            data-thread-label={row.task.threadId} data-sidebar-activity-row={row.task.threadId} tabIndex={roving(index)} title={title}
            onClick={() => { if (renaming !== row.task.threadId) open(row.task.threadId); }}
            onDoubleClick={() => startRename(row)} onFocus={() => setFocusAt(index)} style={stagger(index)}
            className={cn(ROW, gone ? FOLDING : "animate-msg-in cursor-default [animation-fill-mode:backwards] motion-reduce:animate-none",
              row.current ? "bg-raised font-medium text-ink" : "text-ink-secondary hover:bg-ink/[0.06] hover:text-ink",
              row.status === "waiting" && !row.current && "text-warning")}>
            {renaming === row.task.threadId ? (
              <input autoFocus dir="auto" value={draft} maxLength={80} aria-label={t("task.renameAria")}
                onFocus={(event) => event.currentTarget.select()} onChange={(event) => setDraft(event.target.value)}
                onBlur={() => finishRename(row, true, false)} onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); finishRename(row, true, true); }
                  if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finishRename(row, false, true); }
                }}
                className="-ms-1.5 h-7 min-w-0 flex-1 rounded-md border border-focus bg-transparent px-1.5 text-[13px] text-ink outline-none" />
            ) : <>
              <span className={cn("flex min-w-0 flex-1 items-center gap-1.5", hideable(row) && YIELDS)}>
                <span dir="auto" className="min-w-0 truncate">{title}</span>
                {row.pinned && <Pin size={10} role="img" aria-label={t("task.pinned")} className="shrink-0 text-ink-tertiary" />}
              </span>
              {row.task.threadId === bot.mainThreadId && <MainThreadMark />}
              <span className={cn("flex shrink-0 items-center", hideable(row) && "transition-opacity duration-[120ms] group-hover/label:opacity-0 motion-reduce:transition-none")}>
                <StatusMark row={row} />
              </span>
              {hideable(row) && (
                <button type="button" tabIndex={-1} aria-label={t("sidebar.threads.hide", { title })} title={t("sidebar.threads.hideShort")}
                  onClick={(event) => { event.stopPropagation(); hide(row); }}
                  className="pointer-events-none absolute end-1 flex size-6 items-center justify-center rounded-md text-ink-tertiary opacity-0 hover:bg-ink/[0.06] hover:text-ink group-hover/label:pointer-events-auto group-hover/label:opacity-100 group-focus-within/label:opacity-100">
                  <X size={14} aria-hidden="true" />
                </button>
              )}
            </>}
          </div>
        );
      })}
      {runningMore > 0 && (
        <div role="treeitem" aria-level={1} aria-selected={false} tabIndex={roving(rows.length)} onClick={openPanel} onFocus={() => setFocusAt(rows.length)}
          style={stagger(rows.length)} className={QUIET}>
          <span className="min-w-0 flex-1 truncate">{t("sidebar.threads.running", { count: runningMore })}</span>
          <Loader2 size={14} aria-hidden="true" className="shrink-0 animate-spin text-success motion-reduce:animate-none" />
        </div>
      )}
      {leaving && leaving.more > 0 && (
        <div aria-hidden="true" className={cn(ROW, FOLDING, "text-ink-tertiary")}><span className="truncate">{t("sidebar.threads.more", { count: leaving.more })}</span></div>
      )}
      {!leaving && more > 0 && (
        <div role="treeitem" aria-level={1} aria-selected={false} tabIndex={roving(rows.length + Number(runningMore > 0))} onClick={openPanel}
          onFocus={() => setFocusAt(rows.length + Number(runningMore > 0))} style={stagger(rows.length + Number(runningMore > 0))} className={QUIET}>
          <span className="truncate">{t("sidebar.threads.more", { count: more })}</span>
        </div>
      )}
    </div>
    <UndoToast toast={toast} onDone={() => setToast(null)} />
  </>;
}
