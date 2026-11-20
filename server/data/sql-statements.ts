import { DataFailure } from "./types.ts";

const fail = (code: "invalid_input", message: string, hint?: string) => new DataFailure({ code, message, ...(hint ? { hint } : {}) });

export type Token = { kind: "word" | "ident" | "punct" | "block"; text: string; raw: string };

export function singleStatement(sql: string): { tokens: Token[]; end: number } {
  const tokens: Token[] = [];
  let statements = 1;
  let ended = false;
  let depth = 0;
  let i = 0;
  const n = sql.length;
  let end = n;
  const push = (kind: Token["kind"], raw: string, text = raw) => { if (depth === 0) tokens.push({ kind, text, raw }); };
  while (i < n) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (ch === "-" && next === "-") { const end = sql.slice(i).search(/[\n\r]/); i = end === -1 ? n : i + end + 1; continue; }
    if (ch === "/" && next === "*") { i = blockCommentEnd(sql, i); continue; }
    if (ch === ";") { end = Math.min(end, i); ended = true; i++; continue; }
    if (ended && /\S/.test(ch)) { statements++; ended = false; }
    if (ch === "'") {
      push("word", "'…'");
      i = stringEnd(sql, i); continue;
    }
    if (ch === "$") {
      const delimiter = /\$(?:[A-Za-z_\u0080-\uffff][\w\u0080-\uffff]*)?\$/y;
      delimiter.lastIndex = i;
      const open = delimiter.exec(sql)?.[0];
      if (open) {
        const end = sql.indexOf(open, i + open.length);
        if (end === -1) throw fail("invalid_input", "Unterminated dollar-quoted string.");
        push("word", "'…'");
        i = end + open.length; continue;
      }
    }
    if (ch === '"') {
      let j = i + 1;
      for (;;) {
        const q = sql.indexOf('"', j);
        if (q === -1) throw fail("invalid_input", "Unterminated quoted identifier.");
        if (sql[q + 1] === '"') { j = q + 2; continue; }
        j = q + 1; break;
      }
      push("ident", sql.slice(i, j));
      i = j; continue;
    }
    if (ch === "(") { push("block", "(…)"); depth++; i++; continue; }
    if (ch === ")") { depth = Math.max(0, depth - 1); i++; continue; }
    if (/[A-Za-z_\u0080-\uffff]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$.\u0080-\uffff]/.test(sql[j]!)) j++;
      push("word", sql.slice(i, j), sql.slice(i, j).toUpperCase());
      i = j; continue;
    }
    if (ch === ",") { push("punct", ","); i++; continue; }
    i++;
  }
  if (statements > 1) throw fail("invalid_input", "One statement per call.", "Send each statement in its own data_sql call.");
  return { tokens, end };
}

/** DuckDB 1.5 nests block comments: `/* a /* b *\/ c *\/` is one comment. */
function blockCommentEnd(sql: string, start: number): number {
  let depth = 0;
  for (let i = start; i < sql.length - 1;) {
    if (sql[i] === "/" && sql[i + 1] === "*") { depth++; i += 2; continue; }
    if (sql[i] === "*" && sql[i + 1] === "/") { depth--; i += 2; if (!depth) return i; continue; }
    i++;
  }
  throw fail("invalid_input", "Unterminated comment.");
}

/**
 * DuckDB 1.5 reads backslash escapes in E'…' unless the E ends an identifier. After a digit the E may
 * end a number (`1E'…'`), so a literal the two readings end in different places is refused.
 */
function stringEnd(sql: string, quote: number): number {
  if (!/[eE]/.test(sql[quote - 1] ?? "")) return literalEnd(sql, quote, false);
  const before = sql[quote - 2] ?? "";
  if (!/[0-9]/.test(before)) return literalEnd(sql, quote, !/[A-Za-z_$\u0080-\uffff]/.test(before));
  const end = literalEnd(sql, quote, false);
  if (end !== literalEnd(sql, quote, true)) throw fail("invalid_input", "Put a space before E'…' so the string reads one way.");
  return end;
}

/** DuckDB 1.5 joins 'a' and 'b' separated by a line break into one literal that keeps the first one's escapes. */
const STRING_CONTINUES = /[ \t\f]*(?:--[^\n\r]*)?[\n\r](?:[ \t\n\r\f]|--[^\n\r]*[\n\r])*'/y;

function literalEnd(sql: string, quote: number, escapes: boolean): number {
  for (let j = quote + 1; j < sql.length; j++) {
    if (escapes && sql[j] === "\\") { j++; continue; }
    if (sql[j] !== "'") continue;
    if (sql[j + 1] === "'") { j++; continue; }
    STRING_CONTINUES.lastIndex = j + 1;
    if (!STRING_CONTINUES.test(sql)) return j + 1;
    j = STRING_CONTINUES.lastIndex - 1;
  }
  throw fail("invalid_input", "Unterminated string literal.");
}

export function queryRelation(sql: string): string {
  const { end } = singleStatement(sql);
  return `(${sql.slice(0, end)}\n)`;
}
