import { peerLine } from "../../src/lib/peer-message.ts";
import { isReceipt } from "../../src/lib/receipts.ts";
import type { MessagePage } from "../routes/threads.ts";

type Row = { id: string; role?: string; kind?: string; text?: string; tool?: unknown; parentId?: string | null };

/** The branch a client draws, oldest first: the chain up from the active leaf, or every row when the leaf is not held. */
function branchOf(rows: readonly Row[], leafId: string | null | undefined): readonly Row[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  if (!leafId || !byId.has(leafId)) return rows;
  const path: Row[] = [];
  for (let row = byId.get(leafId); row; row = row.parentId ? byId.get(row.parentId) : undefined) path.push(row);
  return path.reverse();
}

const isPerson = (row: Row) => row.role === "user" && !peerLine(row as Parameters<typeof peerLine>[0]);
const notReceipt = (row: Row) => !isReceipt({ kind: row.kind ?? "" });
const previewable = (row: Row) => notReceipt(row) && row.kind !== "screen";

/**
 * Where in `rows` each line lies that a client reads from a conversation it is not showing (-1 when `rows` has none):
 * the sidebar preview's newest line and the line it quotes, the person's last line or the read cursor (the unread
 * divider goes after the later of them), the newest person-role line and tool step, the newest non-receipt of the rows
 * and of the branch (the sidebar mascot and its failed mark), the active leaf, and the end of every other branch (where
 * another client switching branches moves the leaf).
 */
function readLines(rows: readonly Row[], leafId: string | null | undefined, cursorId: string | undefined): number[] {
  const at = new Map(rows.map((row, index) => [row.id, index]));
  const branch = branchOf(rows, leafId);
  const newest = (from: readonly Row[], test: (row: Row) => boolean) => {
    const row = from.findLast(test);
    return row ? at.get(row.id)! : -1;
  };
  const onBranch = new Set(branch);
  const parents = new Set(rows.map((row) => row.parentId));
  const otherEnds = rows.flatMap((row, index) => onBranch.has(row) || parents.has(row.id) ? [] : [index]);
  return [
    newest(branch, previewable),
    newest(branch, (row) => row.role === "user" || (previewable(row) && row.kind !== "activity")),
    Math.max(newest(branch, isPerson), newest(branch, (row) => row.id === cursorId)),
    newest(rows, (row) => row.role === "user"),
    newest(rows, (row) => row.kind === "activity" && Boolean(row.tool)),
    newest(rows, notReceipt),
    newest(branch, notReceipt),
    leafId ? at.get(leafId) ?? -1 : -1,
    ...otherEnds,
  ];
}

/**
 * A conversation's newest rows for a client that is not showing it: at least `floor`, and back far enough that every
 * line the client reads from it is the one it would read from the newest `limit` rows.
 */
export function heldTail<P extends MessagePage>(read: (limit: number) => P, floor: number, limit: number, cursorId?: string): P {
  const page = read(limit);
  let start = Math.max(0, page.messages.length - floor);
  for (const index of readLines(page.messages as Row[], page.activeLeafId, cursorId)) if (index >= 0) start = Math.min(start, index);
  return start === 0 ? page : { ...page, messages: page.messages.slice(start), hasMore: true };
}
