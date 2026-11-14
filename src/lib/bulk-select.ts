export type SelectableRow = {
  threadId: string;
  busy?: boolean;
  activity?: string;
  pinned?: boolean;
  archivedAt?: number;
  updatedAt?: number;
  createdAt?: number;
};

export type DeleteRefusal = { threadId: string; reason: "not-found" | "busy" };
export type DeleteResponse = { deleted: string[]; refused: DeleteRefusal[] };

export const BULK_DELETE_CHUNK = 200;

const DAY_MS = 86_400_000;

/** The server refuses a running thread, so the row cannot be ticked. */
export const isTickable = (row: Pick<SelectableRow, "busy" | "activity">): boolean =>
  row.activity !== "working" && !row.busy;

export function toggleId(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (!next.delete(id)) next.add(id);
  return next;
}

/** An unknown anchor degrades to the target alone. */
export function rangeSelect(selected: ReadonlySet<string>, rows: readonly SelectableRow[], anchor: string | null, target: string, check: boolean): Set<string> {
  const next = new Set(selected);
  const to = rows.findIndex((row) => row.threadId === target);
  if (to < 0) return next;
  const from = anchor === null ? -1 : rows.findIndex((row) => row.threadId === anchor);
  const [low, high] = from < 0 ? [to, to] : [Math.min(from, to), Math.max(from, to)];
  for (const row of rows.slice(low, high + 1)) {
    if (!isTickable(row)) continue;
    if (check) next.add(row.threadId); else next.delete(row.threadId);
  }
  return next;
}

/** Shift-click sets the whole range from the anchor to the state the clicked row is moving to. */
export function clickRow(selected: ReadonlySet<string>, rows: readonly SelectableRow[], anchor: string | null, threadId: string, shiftKey: boolean): Set<string> {
  return shiftKey && anchor !== null
    ? rangeSelect(selected, rows, anchor, threadId, !selected.has(threadId))
    : toggleId(selected, threadId);
}

const recency = (row: SelectableRow): number | undefined => {
  if (typeof row.updatedAt === "number" && Number.isFinite(row.updatedAt) && row.updatedAt > 0) return row.updatedAt;
  if (typeof row.createdAt === "number" && Number.isFinite(row.createdAt) && row.createdAt > 0) return row.createdAt;
  return undefined;
};

/** Quick filters never grab a pinned thread: a pin is the person saying keep it. */
export function olderThanIds(rows: readonly SelectableRow[], days: number, now: number): string[] {
  const cutoff = now - days * DAY_MS;
  return rows.filter((row) => {
    const at = recency(row);
    return at !== undefined && at < cutoff && row.pinned !== true && isTickable(row);
  }).map((row) => row.threadId);
}

export const archivedIds = (rows: readonly SelectableRow[]): string[] =>
  rows.filter((row) => row.archivedAt !== undefined && row.pinned !== true && isTickable(row)).map((row) => row.threadId);

export const selectAll = (rows: readonly SelectableRow[]): Set<string> =>
  new Set(rows.filter(isTickable).map((row) => row.threadId));

export const clearSelection = (): Set<string> => new Set();

export function chunkIds(ids: readonly string[], size = BULK_DELETE_CHUNK): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size));
  return chunks;
}

export function summarizeDelete(responses: readonly DeleteResponse[]): { deleted: number; busy: number; missing: number } {
  const summary = { deleted: 0, busy: 0, missing: 0 };
  for (const response of responses) {
    summary.deleted += response.deleted.length;
    for (const refusal of response.refused) {
      if (refusal.reason === "busy") summary.busy++; else summary.missing++;
    }
  }
  return summary;
}

export const opensRowMenuFromKey = (key: string, shiftKey: boolean, selectMode: boolean): boolean =>
  !selectMode && (key === "ContextMenu" || (shiftKey && key === "F10"));
