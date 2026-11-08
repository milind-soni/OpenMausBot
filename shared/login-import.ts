import { LOGIN_FIELD_MAX, loginPageCheck, normalizeLoginHost } from "./logins.ts";

export const LOGIN_IMPORT_MAX_BYTES = 5 * 1024 * 1024;
export const LOGIN_IMPORT_MAX_ROWS = 5000;

/** Passwords stay in memory until the person confirms the import; never render or log these records. */
export interface ImportedLogin { site: string; username: string; password: string }
export type LoginImportError = "size" | "csv" | "headers" | "rows";
export type LoginImportResult = { ok: true; entries: ImportedLogin[]; invalidRows: number[]; duplicates: number } | { ok: false; error: LoginImportError };

function csvRows(text: string): string[][] | null {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false, closed = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { quoted = false; closed = true; }
      } else field += char;
      continue;
    }
    if (char === '"') {
      if (field || closed) return null;
      quoted = true;
    } else if (char === "," || char === "\n" || char === "\r") {
      row.push(field); field = ""; closed = false;
      if (row.length > 64) return null;
      if (char !== ",") {
        if (row.some((value) => value !== "")) rows.push(row);
        row = [];
        if (char === "\r" && text[i + 1] === "\n") i++;
        if (rows.length > LOGIN_IMPORT_MAX_ROWS + 1) return null;
      }
    } else {
      if (closed) return null;
      field += char;
    }
  }
  if (quoted) return null;
  row.push(field);
  if (row.some((value) => value !== "")) rows.push(row);
  return rows;
}

export function validImportedLogin(value: unknown): value is ImportedLogin {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  if (typeof row.site !== "string" || typeof row.username !== "string" || typeof row.password !== "string") return false;
  return row.site.length <= 2048 && normalizeLoginHost(row.site) !== null && loginPageCheck(row.site).ok &&
    row.username.length <= LOGIN_FIELD_MAX && row.password.length > 0 && row.password.length <= LOGIN_FIELD_MAX;
}

export function parseLoginCsv(text: string): LoginImportResult {
  if (new TextEncoder().encode(text).length > LOGIN_IMPORT_MAX_BYTES) return { ok: false, error: "size" };
  const rows = csvRows(text.replace(/^\uFEFF/u, ""));
  if (!rows) return { ok: false, error: "csv" };
  const headers = rows.shift()?.map((value) => value.trim().toLowerCase()) ?? [];
  const columns = ["url", "username", "password"].map((key) => headers.indexOf(key));
  if (columns.some((index) => index < 0) || new Set(headers).size !== headers.length) return { ok: false, error: "headers" };
  if (rows.length > LOGIN_IMPORT_MAX_ROWS) return { ok: false, error: "rows" };
  const entries: ImportedLogin[] = [], invalidRows: number[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  for (const [index, row] of rows.entries()) {
    const entry = { site: row[columns[0]!] ?? "", username: row[columns[1]!] ?? "", password: row[columns[2]!] ?? "" };
    if (row.length !== headers.length || !validImportedLogin(entry)) { invalidRows.push(index + 2); continue; }
    entry.site = `https://${normalizeLoginHost(entry.site)!}`;
    entry.username = entry.username.trim();
    const key = JSON.stringify([entry.site, entry.username.toLowerCase()]);
    if (seen.has(key)) { duplicates++; continue; }
    seen.add(key); entries.push(entry);
  }
  return { ok: true, entries, invalidRows, duplicates };
}
