import type { DatabaseSync } from "node:sqlite";

export interface SearchHit {
  threadId: string;
  messageId: string;
  at: number;
  role: string;
  kind: string;
  snippet: string;
  matchStart: number;
  matchLength: number;
  from?: string;
}

function matchSpan(text: string, needle: string): { start: number; length: number } | null {
  const folded = text.toLowerCase();
  const hit = folded.indexOf(needle);
  if (hit < 0) return null;
  if (folded.length === text.length) return { start: hit, length: needle.length };
  let at = 0, foldedAt = 0, start: number | undefined;
  for (const character of text) {
    const next = at + character.length;
    const foldedNext = foldedAt + character.toLowerCase().length;
    if (start === undefined && hit < foldedNext) start = at;
    if (hit + needle.length <= foldedNext) return { start: start!, length: next - start! };
    at = next;
    foldedAt = foldedNext;
  }
  return null;
}

export function searchMessagesInDatabase(database: DatabaseSync, query: string, limit = 40, threadId?: string): SearchHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  // SQLite's built-in lower() folds ASCII only; match the query and snippet's Unicode lowercase rules.
  database.function("omb_search_lower", { deterministic: true }, (value) => typeof value === "string" ? value.toLowerCase() : null);
  const pattern = `%${needle.replace(/([\\%_])/g, "\\$1")}%`;
  const scope = threadId ? "thread_id = ? AND " : "";
  const statement = database.prepare(
    "SELECT thread_id, id, at, role, kind, text, json_extract(json, '$.tool.name') AS tool_name, json_extract(json, '$.from.name') AS from_name FROM messages " +
      `WHERE ${scope}((kind = 'text' AND text IS NOT NULL AND omb_search_lower(text) LIKE ? ESCAPE '\\') ` +
      "   OR (kind = 'activity' AND tool_name IS NOT NULL AND omb_search_lower(tool_name) LIKE ? ESCAPE '\\')) " +
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
    const hit = matchSpan(haystack, needle) ?? { start: 0, length: 0 };
    const start = Math.max(0, hit.start - 60);
    const end = Math.min(haystack.length, hit.start + hit.length + 90);
    const head = start > 0 ? "…" : "";
    const body = haystack.slice(start, end).replace(/\s+/g, " ").trim();
    const snippet = head + body + (end < haystack.length ? "…" : "");
    const folded = needle.replace(/\s+/g, " ");
    const match = matchSpan(snippet, folded);
    return {
      threadId: row.thread_id,
      messageId: row.id,
      at: row.at,
      role: row.role,
      kind: row.kind,
      snippet,
      matchStart: match?.start ?? head.length,
      matchLength: match?.length ?? 0,
      ...(row.from_name ? { from: row.from_name } : {}),
    };
  });
}
