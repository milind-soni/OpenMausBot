import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { t } from "@/lib/i18n";
import { archivedIds, chunkIds, clearSelection, clickRow, isTickable, olderThanIds, selectAll, summarizeDelete, type DeleteResponse, type SelectableRow } from "@/lib/bulk-select";
import { api, type Action, type BotAnnouncement, type Group } from "@/state/store";
import { ConfirmDialog } from "./ConfirmDialog";

export type BulkDeleteResult = { responses: DeleteResponse[]; error?: string };
type Selection = ReadonlySet<string>;

/** One request per chunk, in order; a failed chunk stops the rest, and earlier chunks stay deleted. */
export async function deleteThreadsInBulk(owner: { botId: string } | { groupId: string }, threadIds: string[], dispatch: (action: Action) => void): Promise<BulkDeleteResult> {
  const url = "botId" in owner ? `/api/bots/${owner.botId}/tasks/delete` : `/api/groups/${owner.groupId}/tasks/delete`;
  const responses: DeleteResponse[] = [];
  try {
    for (const part of chunkIds(threadIds)) {
      const response = await api<DeleteResponse & { bot?: BotAnnouncement; group?: Partial<Group> & { id: string } }>(url, { method: "POST", body: JSON.stringify({ threadIds: part }) });
      responses.push(response);
      if (response.bot) dispatch({ type: "botPatched", bot: response.bot });
      if (response.group) dispatch({ type: "groupPatched", group: response.group });
    }
    return { responses };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dispatch({ type: "error", message });
    return { responses, error: message };
  }
}

export function bulkDeleteBody(rows: readonly SelectableRow[], selected: Selection, freshConversation: boolean): string {
  const pinned = rows.filter((row) => selected.has(row.threadId) && row.pinned === true).length;
  const everything = rows.length > 0 && rows.every((row) => selected.has(row.threadId));
  return [
    t("task.bulk.confirmBody"),
    pinned > 0 ? t("task.bulk.pinnedNote", { count: pinned }) : null,
    freshConversation && everything ? t("task.bulk.freshNote") : null,
  ].filter(Boolean).join(" ");
}

export function bulkDeleteOutcome(outcome: BulkDeleteResult): string {
  const done = summarizeDelete(outcome.responses);
  return [
    t("task.bulk.result", { count: done.deleted }),
    done.busy > 0 ? t("task.bulk.resultBusy", { count: done.busy }) : null,
    done.missing > 0 ? t("task.bulk.resultMissing", { count: done.missing }) : null,
    outcome.error ? t("task.bulk.resultError", { message: outcome.error }) : null,
  ].filter(Boolean).join(" ");
}

const OLDER_DAYS = 30;

const chip = "rounded-full border border-hairline/50 px-2.5 py-0.5 text-[11px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40";

/** Each render hands `forRows` the rows the list shows, in display order, so ranges and filters touch only visible rows. */
export function useBulkSelect() {
  const [active, setActive] = useState(false);
  const [picked, setPicked] = useState<Selection>(new Set());
  const anchor = useRef<string | null>(null);
  const shown = useRef<readonly SelectableRow[]>([]);
  const toggle = useCallback((task: { threadId: string }, shiftKey: boolean) => {
    const from = anchor.current;
    anchor.current = task.threadId;
    setPicked((previous) => clickRow(previous, shown.current, from, task.threadId, shiftKey));
  }, []);
  const start = useCallback(() => setActive(true), []);
  const finish = useCallback(() => { setActive(false); setPicked(new Set()); anchor.current = null; }, []);
  const forRows = (rows: readonly SelectableRow[]): Selection => {
    shown.current = rows;
    return new Set(rows.filter((row) => picked.has(row.threadId) && isTickable(row)).map((row) => row.threadId));
  };
  return { active, start, finish, forRows, setSelected: setPicked, toggle };
}

export function BulkSelectFilters({ rows, selected, now, onChange, onDone }: {
  rows: readonly SelectableRow[];
  selected: Selection;
  now: number;
  onChange: Dispatch<SetStateAction<Selection>>;
  onDone: () => void;
}) {
  const add = (ids: string[]) => onChange(new Set([...selected, ...ids]));
  return <div className="flex flex-wrap items-center gap-1 px-2 pb-1.5 pt-1" role="group" aria-label={t("task.bulk.select")}>
    <button type="button" className={chip} onClick={() => onChange(selectAll(rows))}>{t("task.bulk.selectAll")}</button>
    <button type="button" className={chip} onClick={() => add(olderThanIds(rows, OLDER_DAYS, now))}>{t("task.bulk.older", { days: OLDER_DAYS })}</button>
    <button type="button" className={chip} onClick={() => add(archivedIds(rows))}>{t("task.bulk.archived")}</button>
    <button type="button" className={chip} disabled={selected.size === 0} onClick={() => onChange(clearSelection())}>{t("task.bulk.clear")}</button>
    <button type="button" onClick={onDone} className="ml-auto rounded px-1.5 py-0.5 text-[11px] font-medium text-accent hover:underline">{t("task.bulk.done")}</button>
  </div>;
}

export function BulkSelectBar({ rows, selected, maxDeletable, freshConversation, onChange, onDelete }: {
  rows: readonly SelectableRow[];
  selected: Selection;
  /** A channel must keep one thread; omit for no limit. */
  maxDeletable?: number;
  /** Deleting every thread of a bot starts a new empty conversation. */
  freshConversation: boolean;
  onChange: Dispatch<SetStateAction<Selection>>;
  onDelete: (threadIds: string[]) => Promise<BulkDeleteResult>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const count = selected.size;
  const overLimit = maxDeletable !== undefined && count > maxDeletable;
  const body = bulkDeleteBody(rows, selected, freshConversation);
  const run = () => {
    const ids = [...selected];
    setPending(true);
    setResult(null);
    void onDelete(ids).then((outcome) => {
      const gone = new Set(outcome.responses.flatMap((response) => response.deleted));
      onChange((previous) => new Set([...previous].filter((id) => !gone.has(id))));
      setResult(bulkDeleteOutcome(outcome));
      setPending(false);
      setConfirming(false);
    });
  };
  return <div className="sticky bottom-0 z-10 -mx-1 border-t border-hairline/40 bg-panel px-2 py-1.5">
    <span role="status" className="block text-[11px] text-ink-secondary">
      {result ?? (overLimit ? t("task.bulk.channelLimit") : "")}
    </span>
    <div className="flex items-center gap-2">
      <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink">{t("task.bulk.selected", { count })}</span>
      <button type="button" disabled={count === 0 || pending} onClick={() => onChange(clearSelection())}
        className="rounded-md px-2.5 py-1 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40">{t("task.bulk.cancel")}</button>
      <button type="button" disabled={count === 0 || overLimit || pending} aria-busy={pending || undefined} onClick={() => setConfirming(true)}
        className="rounded-md bg-danger px-2.5 py-1 text-[12px] font-medium text-white hover:brightness-110 disabled:opacity-40">
        {pending ? t("task.bulk.deleting") : t("task.bulk.delete", { count })}
      </button>
    </div>
    <ConfirmDialog open={confirming} title={t("task.bulk.confirmTitle", { count })} body={body} confirmLabel={t("task.bulk.delete", { count })}
      pending={pending} onCancel={() => { if (!pending) setConfirming(false); }} onConfirm={run} />
  </div>;
}

export function ThreadListFooter({ bulk, rows, selected, total, canShowAll, canSelect, onShowAll, maxDeletable, freshConversation, onDelete }: {
  bulk: ReturnType<typeof useBulkSelect>;
  rows: readonly SelectableRow[];
  selected: Selection;
  total: number;
  canShowAll: boolean;
  canSelect: boolean;
  onShowAll: () => void;
  maxDeletable?: number;
  freshConversation: boolean;
  onDelete: (threadIds: string[]) => Promise<BulkDeleteResult>;
}) {
  if (bulk.active) {
    return <BulkSelectBar rows={rows} selected={selected} maxDeletable={maxDeletable} freshConversation={freshConversation} onChange={bulk.setSelected} onDelete={onDelete} />;
  }
  if (!canShowAll && !canSelect) return null;
  const link = "inline-flex h-7 items-center text-[13px] font-medium leading-4 text-ink-secondary hover:text-ink";
  return <div className="flex items-center justify-between pl-6 pr-2">
    {canShowAll ? <button type="button" onClick={onShowAll} className={link}>{t("task.showAll", { count: total })}</button> : <span />}
    {canSelect && <button type="button" onClick={bulk.start} className={link}>{t("task.bulk.select")}</button>}
  </div>;
}
