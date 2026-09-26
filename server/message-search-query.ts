import type { DatabaseSync } from "node:sqlite";

export interface SearchHit {
  threadId: string;
  messageId: string;
  at: number;
  role: string;
  kind: string;
  /** the matched text, trimmed to a window around the first hit */
  snippet: string;
  /** where the match sits inside `snippet`, for highlighting */
  matchStart: number;
  matchLength: number;
  /** room messages: which member said it */
  from?: string;
}

/** Shared query and snippet logic; the worker never calls the write-side open(). */
export function searchMessagesInDatabase(database: DatabaseSync, query: string, limit = 40, threadId?: string): SearchHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  // escape LIKE wildcards so a literal % or _ in the query stays literal
  const pattern = `%${needle.replace(/([\\%_])/g, "\\$1")}%`;
  // text messages by their text; activity chips by the tool name — "which
  // bot ran that migration" is a tool-name question. The chip's name lives
  // in the row's json; a JSON1 extract keeps this one query.
  const scope = threadId ? "thread_id = ? AND " : "";
  const statement = database.prepare(
    "SELECT thread_id, id, at, role, kind, text, json_extract(json, '$.tool.name') AS tool_name, json_extract(json, '$.from.name') AS from_name FROM messages " +
      `WHERE ${scope}((kind = 'text' AND text IS NOT NULL AND lower(text) LIKE ? ESCAPE '\\') ` +
      "   OR (kind = 'activity' AND tool_name IS NOT NULL AND lower(tool_name) LIKE ? ESCAPE '\\')) " +
      "ORDER BY at DESC LIMIT ?",
  );
  const rows = (threadId
    ? statement.all(threadId, pattern, pattern, limit)
    : statement.all(pattern, pattern, limit)) as Array<{
    thread_id: string;
    id: string;
    at: number;
    role: string;
    kind: string;
    text: string | null;
    tool_name: string | null;
    from_name: string | null;
  }>;
  return rows.map((row) => {
    const haystack = row.kind === "activity" ? (row.tool_name ?? "") : (row.text ?? "");
    const hitAt = Math.max(0, haystack.toLowerCase().indexOf(needle));
    const start = Math.max(0, hitAt - 60);
    const end = Math.min(haystack.length, hitAt + needle.length + 90);
    const head = start > 0 ? "…" : "";
    const body = haystack.slice(start, end).replace(/\s+/g, " ").trim();
    const snippet = head + body + (end < haystack.length ? "…" : "");
    // whitespace folding can shift the offset; find the match again inside
    const folded = needle.replace(/\s+/g, " ");
    const matchStart = snippet.toLowerCase().indexOf(folded);
    return {
      threadId: row.thread_id,
      messageId: row.id,
      at: row.at,
      role: row.role,
      kind: row.kind,
      snippet,
      matchStart: matchStart < 0 ? head.length : matchStart,
      // A defensive fallback must not mark arbitrary snippet text as the hit.
      matchLength: matchStart < 0 ? 0 : folded.length,
      ...(row.from_name ? { from: row.from_name } : {}),
    };
  });
}
