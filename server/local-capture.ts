import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { extname, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import type { JsonValue } from "./schema.ts";

export type LocalCaptureStatus = "ok" | "empty" | "failed" | "needs-config";

export interface LocalCaptureItem {
  sourceId: "anvil-bi" | "chrome-history" | "hevy" | "local-inbox" | "mercury" | "telegram-relay" | "whoop";
  title: string;
  text?: string;
  capturedAt: string;
  evidenceRef: string;
  metadata?: Record<string, string | number | boolean>;
}

export interface LocalCaptureResult<TCursor = JsonValue> {
  status: LocalCaptureStatus;
  items: LocalCaptureItem[];
  cursor: TCursor | null;
  error?: string;
  truncated?: boolean;
  deletedPaths?: string[];
}

export interface LocalCaptureEvidence {
  sourceId: LocalCaptureItem["sourceId"];
  title: string;
  text?: string;
  evidenceRef: string;
}

export interface ChromeHistoryCursor {
  /** String because Chrome's microsecond timestamp exceeds JS safe-integer range. */
  lastVisitTime: string;
  urlId: number;
}

export interface ChromeHistoryOptions {
  limit?: number;
  /** Keep URL paths out of receipts. The default is intentionally metadata-only. */
  includeTitles?: boolean;
}

export interface InboxCursor {
  files: Record<string, { modifiedAt: number; size: number; digest: string }>;
}

export interface LocalInboxOptions {
  maxDepth?: number;
  maxFiles?: number;
  maxBytesPerFile?: number;
  maxTotalBytes?: number;
  textExtensions?: readonly string[];
}

export interface WhoopCursor {
  files: Record<string, { modifiedAt: number; size: number; digest: string }>;
}

export interface WhoopOptions {
  maxFiles?: number;
  maxBytesPerFile?: number;
  maxTotalBytes?: number;
}

export interface LocalHealthOptions {
  /** Injectable for deterministic tests; production uses the global fetch. */
  fetcher?: typeof fetch;
  endpoint?: string;
  timeoutMs?: number;
  now?: () => number;
}

export interface AnvilBiMercuryCursor {
  accountHashes: Record<string, string>;
  transactionIds: string[];
}

export interface AnvilBiMercuryOptions {
  /** Injectable so tests never invoke Node or a financial API. */
  run?: (projectPath: string) => Promise<string>;
}

const DEFAULT_HEALTH_TIMEOUT_MS = 2_000;
const ANVIL_MERCURY_TIMEOUT_MS = 30_000;
const ANVIL_MERCURY_MAX_OUTPUT_BYTES = 5_000_000;

const anvilMercurySnapshotSchema = z.object({
  capturedAt: z.string().refine((value) => Number.isFinite(Date.parse(value)), "invalid capture timestamp"),
  cashAccounts: z.array(z.object({
    id: z.string().min(1).max(500),
    source: z.literal("mercury"),
    name: z.string().min(1).max(500),
    balanceCents: z.number().int().safe(),
    availableCents: z.number().int().safe(),
  })).max(100),
  transactions: z.array(z.object({
    id: z.string().min(1).max(500),
    source: z.literal("mercury"),
    accountId: z.string().min(1).max(500),
    amountCents: z.number().int().safe(),
    postedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    description: z.string().min(1).max(2_000),
  })).max(2_000),
  notes: z.array(z.string().max(2_000)).max(50),
});

const ANVIL_MERCURY_EVAL = `
import { createMercuryAdapter } from "./apps/server/src/integrations/mercury.ts";
const adapter = createMercuryAdapter();
if (!adapter.configured) throw new Error("Mercury is not configured in Anvil BI");
const capturedAt = new Date().toISOString();
const result = await adapter.fetch(capturedAt.slice(0, 10));
process.stdout.write(JSON.stringify({
  capturedAt,
  cashAccounts: result.payload.cashAccounts ?? [],
  transactions: result.payload.transactions ?? [],
  notes: result.notes,
}));
`;

const DEFAULT_TEXT_EXTENSIONS = [".txt", ".md", ".markdown", ".json", ".csv", ".log"] as const;
const DEFAULT_MAX_DEPTH = 5;
const DEFAULT_MAX_FILES = 500;
const DEFAULT_MAX_BYTES_PER_FILE = 1_000_000;
const DEFAULT_MAX_TOTAL_BYTES = 10_000_000;
const SENSITIVE_KEY = /(token|secret|password|passwd|credential|authorization|cookie|bearer|private.?key|client.?secret|refresh.?token|access.?token|api.?key)/i;
const SENSITIVE_TEXT = [
  /\b(?:sk|xai|ghp|gho|eyJ)[A-Za-z0-9_-]{12,}\b/gi,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gi,
  /\bAIza[0-9A-Za-z_-]{30,}\b/gi,
  /\bxox[abposr]-[A-Za-z0-9-]{20,}\b/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b(?:authorization|api[ _-]?key|access[ _-]?token|refresh[ _-]?token|client[ _-]?secret)\s*[:=-]\s*\S+/gi,
  /\b(?:otp|one[- ]?time password|verification code|security code)\s*[:=-]?\s*\d{4,10}\b/gi,
];

function limited(value: string, max: number): string {
  return SENSITIVE_TEXT.reduce((result, pattern) => result.replace(pattern, "[redacted]"), value).trim().slice(0, max);
}

function asCursor<T>(value: unknown, guard: (value: unknown) => value is T): T | null {
  return value !== null && value !== undefined && guard(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isChromeCursor(value: unknown): value is ChromeHistoryCursor {
  if (!isUnknownRecord(value)) return false;
  return typeof value.lastVisitTime === "string" && /^\d+$/.test(value.lastVisitTime)
    && typeof value.urlId === "number" && Number.isSafeInteger(value.urlId);
}

function isFileCursor(value: unknown): value is InboxCursor {
  if (!isUnknownRecord(value) || !isUnknownRecord(value.files)) return false;
  return Object.values(value.files).every((entry) => isUnknownRecord(entry)
    && typeof entry.modifiedAt === "number" && typeof entry.size === "number" && typeof entry.digest === "string");
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  return Math.max(1, Math.min(Math.floor(value ?? fallback), fallback));
}

/** Chrome timestamps are microseconds since 1601-01-01, not Unix time. */
function chromeTimeToUnixMs(value: bigint): number {
  const unixMicros = value - 11_644_473_600_000_000n;
  return Math.max(0, Number(unixMicros / 1_000n));
}

function copyAndOpenSqlite(path: string): { database: DatabaseSync; cleanup: () => void } {
  const source = resolve(path);
  if (!existsSync(source) || !lstatSync(source).isFile()) throw new Error("Chrome History database was not found");
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "openmausbot-chrome-history-"));
  const copy = join(temporaryDirectory, "History");
  try {
    // Chrome keeps the live file open. Querying an immutable copy avoids locks,
    // WAL races, and any possibility of mutating the browser profile.
    copyFileSync(source, copy);
    const database = new DatabaseSync(copy, { readOnly: true, readBigInts: true });
    return { database, cleanup: () => { database.close(); rmSync(temporaryDirectory, { recursive: true, force: true }); } };
  } catch (error) {
    rmSync(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}

export function defaultChromeHistoryPath(profile = "Default"): string {
  const localAppData = process.env.LOCALAPPDATA;
  const base = localAppData && localAppData.trim() ? localAppData : join(homedir(), "AppData", "Local");
  return join(base, "Google", "Chrome", "User Data", profile, "History");
}

/** Read newly visited domains from a copied Chrome database. */
export function readChromeHistory(
  historyPath = defaultChromeHistoryPath(),
  previousCursor: unknown = null,
  options: ChromeHistoryOptions = {},
): LocalCaptureResult<ChromeHistoryCursor> {
  const cursor = asCursor(previousCursor, isChromeCursor);
  let opened: { database: DatabaseSync; cleanup: () => void };
  try { opened = copyAndOpenSqlite(historyPath); } catch (error) {
    return { status: "failed", items: [], cursor, error: error instanceof Error ? error.message : String(error) };
  }
  try {
    const limit = normalizeLimit(options.limit, 500);
    const rows = opened.database.prepare(`
      SELECT id, url, title, last_visit_time
      FROM urls
      WHERE last_visit_time > ? OR (last_visit_time = ? AND id > ?)
      ORDER BY last_visit_time ASC, id ASC
      LIMIT ?
    `).all(cursor ? BigInt(cursor.lastVisitTime) : -1n, cursor ? BigInt(cursor.lastVisitTime) : -1n, cursor?.urlId ?? -1, limit) as Array<Record<string, unknown>>;
    const items: LocalCaptureItem[] = [];
    let next = cursor;
    for (const row of rows) {
      const id = typeof row.id === "number" ? row.id : Number(row.id);
      const visitTime = typeof row.last_visit_time === "bigint" ? row.last_visit_time : BigInt(String(row.last_visit_time));
      if (!Number.isSafeInteger(id) || typeof row.url !== "string") continue;
      let host: string;
      try {
        const url = new URL(row.url);
        if (url.protocol !== "http:" && url.protocol !== "https:") continue;
        host = url.hostname.toLowerCase();
      } catch { continue; }
      if (!host) continue;
      const capturedAt = new Date(chromeTimeToUnixMs(visitTime)).toISOString();
      const item: LocalCaptureItem = {
        sourceId: "chrome-history",
        title: options.includeTitles === false ? host : limited(typeof row.title === "string" && row.title ? row.title : host, 240),
        capturedAt,
        evidenceRef: `chrome-history://${encodeURIComponent(host)}?id=${id}`,
        metadata: { domain: host, urlId: id },
      };
      items.push(item);
      next = { lastVisitTime: visitTime.toString(), urlId: id };
    }
    return { status: items.length ? "ok" : "empty", items, cursor: next };
  } catch (error) {
    return { status: "failed", items: [], cursor, error: "Chrome History database could not be read" };
  } finally { opened.cleanup(); }
}

function rootAndRelativePath(directory: string, candidate: string): { root: string; path: string; relativePath: string } | null {
  try {
    const root = realpathSync(resolve(directory));
    const path = realpathSync(candidate);
    const relativePath = relative(root, path);
    if (!relativePath || relativePath.startsWith(`..${sep}`) || relativePath === ".." || resolve(root, relativePath) !== path) return null;
    return { root, path, relativePath };
  } catch { return null; }
}

interface LocalFile {
  path: string;
  relativePath: string;
  size: number;
  modifiedAt: number;
}

function listSafeFiles(directory: string, maxDepth: number, maxFiles: number): { files: LocalFile[]; truncated: boolean; root: string } {
  const root = realpathSync(resolve(directory));
  const files: LocalFile[] = [];
  let truncated = false;
  const visit = (folder: string, depth: number): void => {
    if (depth > maxDepth || files.length >= maxFiles) { truncated = true; return; }
    for (const name of readdirSync(folder)) {
      if (files.length >= maxFiles) { truncated = true; return; }
      const candidate = join(folder, name);
      let info;
      try { info = lstatSync(candidate); } catch { continue; }
      // Symlinks/reparse points are intentionally ignored, even when they
      // happen to resolve inside the selected folder.
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) { visit(candidate, depth + 1); continue; }
      if (!info.isFile()) continue;
      const safe = rootAndRelativePath(root, candidate);
      if (!safe) continue;
      files.push({ path: safe.path, relativePath: safe.relativePath.replaceAll(sep, "/"), size: info.size, modifiedAt: info.mtimeMs });
    }
  };
  visit(root, 0);
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return { files, truncated, root };
}

function digestFile(path: string, maxBytes: number): string {
  const hash = createHash("sha256");
  const bytes = readFileSync(path);
  hash.update(bytes.subarray(0, maxBytes));
  return hash.digest("hex");
}

function normalizedFileCursor(value: unknown): InboxCursor | null {
  return asCursor(value, isFileCursor);
}

/** Reconcile the entire selected folder on every run, then emit only changed files. */
export function readLocalInbox(
  directory: string | null,
  previousCursor: unknown = null,
  options: LocalInboxOptions = {},
): LocalCaptureResult<InboxCursor> {
  const cursor = normalizedFileCursor(previousCursor);
  if (!directory?.trim()) return { status: "needs-config", items: [], cursor, error: "Select a local inbox folder" };
  try {
    const maxDepth = Math.max(0, Math.min(Math.floor(options.maxDepth ?? DEFAULT_MAX_DEPTH), 12));
    const maxFiles = normalizeLimit(options.maxFiles, DEFAULT_MAX_FILES);
    const maxBytesPerFile = normalizeLimit(options.maxBytesPerFile, DEFAULT_MAX_BYTES_PER_FILE);
    const maxTotalBytes = normalizeLimit(options.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES);
    const extensions = new Set((options.textExtensions ?? DEFAULT_TEXT_EXTENSIONS).map((extension) => extension.toLowerCase()));
    const listed = listSafeFiles(directory, maxDepth, maxFiles);
    const files: Record<string, { modifiedAt: number; size: number; digest: string }> = {};
    const items: LocalCaptureItem[] = [];
    const seen = new Set<string>();
    let totalBytes = 0;
    let truncated = listed.truncated;
    for (const file of listed.files) {
      const digest = digestFile(file.path, maxBytesPerFile);
      files[file.relativePath] = { modifiedAt: file.modifiedAt, size: file.size, digest };
      seen.add(file.relativePath);
      const prior = cursor?.files[file.relativePath];
      if (prior?.modifiedAt === file.modifiedAt && prior.size === file.size && prior.digest === digest) continue;
      const extension = extname(file.relativePath).toLowerCase();
      const capturedAt = new Date(file.modifiedAt).toISOString();
      const item: LocalCaptureItem = {
        sourceId: "local-inbox",
        title: limited(file.relativePath, 240),
        capturedAt,
        evidenceRef: `local-inbox://${encodeURIComponent(file.relativePath)}`,
        metadata: { relativePath: file.relativePath, size: file.size, modifiedAt: file.modifiedAt },
      };
      if (extensions.has(extension) && totalBytes + Math.min(file.size, maxBytesPerFile) <= maxTotalBytes) {
        const text = readFileSync(file.path, "utf8");
        item.text = limited(text, 8_000);
        totalBytes += Math.min(file.size, maxBytesPerFile);
      } else if (file.size > maxBytesPerFile || totalBytes >= maxTotalBytes) {
        truncated = true;
      }
      items.push(item);
    }
    const deletedPaths = cursor ? Object.keys(cursor.files).filter((path) => !seen.has(path)) : [];
    return { status: items.length || deletedPaths.length ? "ok" : "empty", items, cursor: { files }, truncated, deletedPaths };
  } catch (error) {
    return { status: "failed", items: [], cursor, error: error instanceof Error ? error.message : "Local inbox could not be read" };
  }
}

function isWhoopCursor(value: unknown): value is WhoopCursor { return isFileCursor(value); }

function safeRecord(value: JsonValue, depth = 0): JsonValue | undefined {
  if (depth > 4) return undefined;
  if (typeof value === "string") return limited(value, 500);
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((entry) => safeRecord(entry, depth + 1)).filter((entry): entry is JsonValue => entry !== undefined);
  const output: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) continue;
    const cleaned = safeRecord(entry, depth + 1);
    if (cleaned !== undefined) output[limited(key, 80)] = cleaned;
  }
  return output;
}

function csvRecords(text: string): Array<Record<string, JsonValue>> {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"' && quoted && text[i + 1] === '"') { cell += '"'; i += 1; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (char === "," && !quoted) { row.push(cell); cell = ""; continue; }
    if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cell); cell = ""; if (row.some((value) => value.trim())) rows.push(row); row = []; continue;
    }
    cell += char;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const headers = rows.shift() ?? [];
  return rows.map((values) => Object.fromEntries(headers.map((header, index) => [header.trim(), values[index] ?? ""])));
}

function recordTitle(record: Record<string, JsonValue>, fallback: string): string {
  for (const key of ["type", "activity_type", "sport_name", "name", "date", "start", "start_time"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return limited(`${key.replaceAll("_", " ")}: ${value}`, 240);
  }
  return fallback;
}

function recordSummary(record: Record<string, JsonValue>): string | undefined {
  const pairs = Object.entries(record).filter(([key, value]) => !SENSITIVE_KEY.test(key) && (typeof value === "string" || typeof value === "number" || typeof value === "boolean"));
  if (!pairs.length) return undefined;
  return limited(pairs.slice(0, 30).map(([key, value]) => `${key}: ${String(value)}`).join("; "), 4_000);
}

function whoopRecords(content: string, extension: string): Array<Record<string, JsonValue>> {
  if (extension === ".csv") return csvRecords(content).map((record) => safeRecord(record)).filter((record): record is Record<string, JsonValue> => isRecord(record));
  const parsed: JsonValue = JSON.parse(content);
  if (Array.isArray(parsed)) return parsed.map((record) => safeRecord(record)).filter((record): record is Record<string, JsonValue> => isRecord(record));
  if (isRecord(parsed)) {
    const array = Object.values(parsed).find((value): value is JsonValue[] => Array.isArray(value));
    if (array) return array.map((record) => safeRecord(record)).filter((record): record is Record<string, JsonValue> => isRecord(record));
    const clean = safeRecord(parsed); return clean && isRecord(clean) ? [clean] : [];
  }
  return [];
}

/** Read user-exported WHOOP JSON/CSV files. Tokens and credential-shaped keys are dropped. */
export function readWhoopExport(
  sourcePath: string | null,
  previousCursor: unknown = null,
  options: WhoopOptions = {},
): LocalCaptureResult<WhoopCursor> {
  const cursor = asCursor(previousCursor, isWhoopCursor);
  if (!sourcePath?.trim()) return { status: "needs-config", items: [], cursor, error: "Select a WHOOP JSON/CSV export file or folder" };
  try {
    const maxFiles = normalizeLimit(options.maxFiles, 100);
    const maxBytesPerFile = normalizeLimit(options.maxBytesPerFile, DEFAULT_MAX_BYTES_PER_FILE);
    const maxTotalBytes = normalizeLimit(options.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES);
    const path = resolve(sourcePath);
    const info = lstatSync(path);
    const candidates = info.isDirectory() ? listSafeFiles(path, 3, maxFiles).files : info.isFile() ? [{ path, relativePath: extname(path).toLowerCase(), size: info.size, modifiedAt: info.mtimeMs }] : [];
    const files: Record<string, { modifiedAt: number; size: number; digest: string }> = {};
    const items: LocalCaptureItem[] = [];
    let totalBytes = 0;
    for (const file of candidates.slice(0, maxFiles)) {
      const extension = extname(file.path).toLowerCase();
      if (extension !== ".json" && extension !== ".csv") continue;
      const digest = digestFile(file.path, maxBytesPerFile);
      files[file.relativePath] = { modifiedAt: file.modifiedAt, size: file.size, digest };
      const prior = cursor?.files[file.relativePath];
      if (prior?.modifiedAt === file.modifiedAt && prior.size === file.size && prior.digest === digest) continue;
      if (totalBytes + Math.min(file.size, maxBytesPerFile) > maxTotalBytes) continue;
      const records = whoopRecords(readFileSync(file.path, "utf8").slice(0, maxBytesPerFile), extension);
      totalBytes += Math.min(file.size, maxBytesPerFile);
      records.slice(0, 500).forEach((record, index) => {
        const title = recordTitle(record, `${file.relativePath} #${index + 1}`);
        const item: LocalCaptureItem = { sourceId: "whoop", title, capturedAt: new Date(file.modifiedAt).toISOString(), evidenceRef: `whoop://${encodeURIComponent(file.relativePath)}#record=${index + 1}`, metadata: { relativePath: file.relativePath, record: index + 1 } };
        const summary = recordSummary(record); if (summary) item.text = summary;
        items.push(item);
      });
    }
    return { status: items.length ? "ok" : "empty", items, cursor: { files } };
  } catch (error) {
    return { status: "failed", items: [], cursor, error: error instanceof Error ? error.message : "WHOOP export could not be read" };
  }
}

/** Read the same token-free export shape for the Hevy source. The WHOOP
 * collector writes a combined WHOOP/Hevy snapshot, so keeping this small
 * source-specific wrapper preserves independent ledger/source accounting
 * without accepting Hevy credentials or making a second network request. */
export function readHevyExport(
  sourcePath: string | null,
  previousCursor: unknown = null,
  options: WhoopOptions = {},
): LocalCaptureResult<WhoopCursor> {
  const result = readWhoopExport(sourcePath, previousCursor, options);
  return {
    ...result,
    items: result.items.map((item) => ({ ...item, sourceId: "hevy" as const })),
  };
}

function loopbackHealthUrl(value: string): URL | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1" && parsed.hostname !== "[::1]" && parsed.hostname !== "::1") return null;
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    return parsed;
  } catch {
    return null;
  }
}

function healthError(error: unknown, label: string): string {
  if (error instanceof Error && error.name === "TimeoutError") return `${label} health check timed out`;
  return `${label} health endpoint could not be read`;
}

function healthBody(value: unknown): { ok: boolean; db: boolean | null } {
  if (!isUnknownRecord(value)) return { ok: false, db: null };
  return {
    ok: value.ok === true || value.status === "ok" || value.status === "healthy" || value.status === "ready",
    db: typeof value.db === "boolean" ? value.db : null,
  };
}

async function readLoopbackHealth(
  sourceId: "anvil-bi" | "telegram-relay",
  label: string,
  endpoint: string | null,
  options: LocalHealthOptions = {},
): Promise<LocalCaptureResult<null>> {
  if (!endpoint?.trim()) return { status: "needs-config", items: [], cursor: null, error: `Select a local ${label} health endpoint` };
  const url = loopbackHealthUrl(endpoint.trim());
  if (!url) return { status: "needs-config", items: [], cursor: null, error: `${label} health endpoint must be a loopback HTTP URL without credentials` };
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = Math.max(250, Math.min(Math.floor(options.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS), 10_000));
  try {
    const response = await fetcher(url.toString(), {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { status: "failed", items: [], cursor: null, error: `${label} health endpoint returned HTTP ${response.status}` };
    const parsed: unknown = await response.json().catch(() => null);
    const health = healthBody(parsed);
    if (!health.ok || health.db === false) return { status: "failed", items: [], cursor: null, error: `${label} health response was not healthy` };
    const capturedAt = new Date(options.now?.() ?? Date.now()).toISOString();
    const metadata: Record<string, string | number | boolean> = {
      endpoint: `${url.origin}${url.pathname}`,
      healthy: true,
      statusCode: response.status,
    };
    if (health.db !== null) metadata.database = health.db;
    return {
      status: "ok",
      items: [{ sourceId, title: `${label} health`, capturedAt, evidenceRef: `${sourceId}://health`, metadata }],
      cursor: null,
    };
  } catch (error) {
    return { status: "failed", items: [], cursor: null, error: healthError(error, label) };
  }
}

/** Probe Anvil BI's documented local GET /api/health contract. The project
 * path is intentionally explicit and checked before network access so a
 * random local service cannot be mistaken for Anvil BI. */
export async function readAnvilBiHealth(
  projectPath: string | null,
  options: LocalHealthOptions = {},
): Promise<LocalCaptureResult<null>> {
  if (!projectPath?.trim()) return { status: "needs-config", items: [], cursor: null, error: "Select the local Anvil BI project folder" };
  try {
    const packagePath = join(resolve(projectPath), "package.json");
    const packageJson: unknown = JSON.parse(readFileSync(packagePath, "utf8"));
    if (!isUnknownRecord(packageJson) || packageJson.name !== "anvil-bi") {
      return { status: "failed", items: [], cursor: null, error: "Selected folder is not the Anvil BI project" };
    }
  } catch {
    return { status: "failed", items: [], cursor: null, error: "Anvil BI package manifest could not be read" };
  }
  // The Anvil BI Mercury adapter is a project-local, read-only connector. It
  // calls Mercury directly and does not require Anvil's optional web server.
  // In particular, do not silently probe the server's historical :8080 port:
  // that port is often occupied by another local model service and its
  // failure used to make a healthy direct Mercury connector look broken.
  if (!options.endpoint?.trim()) {
    const capturedAt = new Date(options.now?.() ?? Date.now()).toISOString();
    return {
      status: "ok",
      items: [{
        sourceId: "anvil-bi",
        title: "Anvil BI local adapter available",
        capturedAt,
        evidenceRef: "anvil-bi://adapter",
        metadata: { transport: "local-project", healthProbe: false },
      }],
      cursor: null,
    };
  }
  return readLoopbackHealth("anvil-bi", "Anvil BI", options.endpoint, options);
}

function isAnvilBiMercuryCursor(value: unknown): value is AnvilBiMercuryCursor {
  if (!isUnknownRecord(value) || !isUnknownRecord(value.accountHashes) || !Array.isArray(value.transactionIds)) return false;
  return Object.values(value.accountHashes).every((entry) => typeof entry === "string")
    && value.transactionIds.every((entry) => typeof entry === "string");
}

function validateAnvilBiProject(projectPath: string): string | null {
  try {
    const root = realpathSync(resolve(projectPath));
    const packageJson: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    if (!isUnknownRecord(packageJson) || packageJson.name !== "anvil-bi") return null;
    const adapterPath = join(root, "apps", "server", "src", "integrations", "mercury.ts");
    if (!existsSync(adapterPath) || !lstatSync(adapterPath).isFile()) return null;
    return root;
  } catch {
    return null;
  }
}

/** The Anvil helper may load its own project-local .env, but it must never
 * inherit provider or workspace credentials from the OpenMaus server. */
export function anvilChildEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {};
  for (const name of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "TEMP", "TMP", "LANG", "LC_ALL", "TZ"]) {
    const value = source[name];
    if (value) child[name] = value;
  }
  return child;
}

function executeAnvilBiMercury(projectPath: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", ANVIL_MERCURY_EVAL],
      {
        cwd: projectPath,
        encoding: "utf8",
        maxBuffer: ANVIL_MERCURY_MAX_OUTPUT_BYTES,
        timeout: ANVIL_MERCURY_TIMEOUT_MS,
        windowsHide: true,
        env: anvilChildEnvironment(),
      },
      (error, stdout) => {
        if (error) rejectPromise(error);
        else resolvePromise(stdout);
      },
    );
  });
}

function accountDigest(account: { id: string; name: string; balanceCents: number; availableCents: number }): string {
  return createHash("sha256")
    .update(JSON.stringify([account.id, account.name, account.balanceCents, account.availableCents]))
    .digest("hex");
}

/** Pull Mercury through Anvil BI's existing read-only adapter. The child
 * loads Anvil's project-local environment without inheriting OpenMaus's
 * workspace credentials, and emits only normalized financial records.
 * Stable account hashes
 * and transaction ids make repeat polls deterministic and delta-only. */
export async function readAnvilBiMercury(
  projectPath: string | null,
  previousCursor: unknown = null,
  options: AnvilBiMercuryOptions = {},
): Promise<LocalCaptureResult<AnvilBiMercuryCursor>> {
  const cursor = asCursor(previousCursor, isAnvilBiMercuryCursor);
  if (!projectPath?.trim()) {
    return { status: "needs-config", items: [], cursor, error: "Select the local Anvil BI project folder" };
  }
  const root = validateAnvilBiProject(projectPath);
  if (!root) {
    return { status: "failed", items: [], cursor, error: "Selected folder is not a compatible Anvil BI project" };
  }

  try {
    const raw = await (options.run ?? executeAnvilBiMercury)(root);
    const parsedJson: unknown = JSON.parse(raw);
    const parsed = anvilMercurySnapshotSchema.safeParse(parsedJson);
    if (!parsed.success) {
      return { status: "failed", items: [], cursor, error: "Anvil BI returned an invalid Mercury capture payload" };
    }

    const accountIds = new Set<string>();
    for (const account of parsed.data.cashAccounts) {
      if (accountIds.has(account.id)) {
        return { status: "failed", items: [], cursor, error: "Anvil BI returned duplicate Mercury account ids" };
      }
      accountIds.add(account.id);
    }
    const transactionIds = new Set<string>();
    for (const transaction of parsed.data.transactions) {
      if (transactionIds.has(transaction.id)) {
        return { status: "failed", items: [], cursor, error: "Anvil BI returned duplicate Mercury transaction ids" };
      }
      transactionIds.add(transaction.id);
    }

    const previousTransactions = new Set(cursor?.transactionIds ?? []);
    const nextAccountHashes: Record<string, string> = {};
    const items: LocalCaptureItem[] = [];
    for (const account of parsed.data.cashAccounts) {
      const digest = accountDigest(account);
      nextAccountHashes[account.id] = digest;
      if (cursor?.accountHashes[account.id] === digest) continue;
      items.push({
        sourceId: "mercury",
        title: limited(`Mercury account: ${account.name}`, 240),
        text: `Current balance: ${account.balanceCents} cents; available balance: ${account.availableCents} cents.`,
        capturedAt: parsed.data.capturedAt,
        evidenceRef: `anvil-bi://mercury/account/${encodeURIComponent(account.id)}`,
        metadata: {
          kind: "account",
          externalId: account.id,
          balanceCents: account.balanceCents,
          availableCents: account.availableCents,
        },
      });
    }
    for (const previousAccountId of Object.keys(cursor?.accountHashes ?? {})) {
      if (accountIds.has(previousAccountId)) continue;
      items.push({
        sourceId: "mercury",
        title: "Mercury account no longer active",
        capturedAt: parsed.data.capturedAt,
        evidenceRef: `anvil-bi://mercury/account/${encodeURIComponent(previousAccountId)}`,
        metadata: { kind: "account-removed", externalId: previousAccountId },
      });
    }
    for (const transaction of parsed.data.transactions) {
      if (previousTransactions.has(transaction.id)) continue;
      items.push({
        sourceId: "mercury",
        title: limited(transaction.description, 240),
        text: `Posted ${transaction.postedDate}; amount: ${transaction.amountCents} cents.`,
        capturedAt: parsed.data.capturedAt,
        evidenceRef: `anvil-bi://mercury/transaction/${encodeURIComponent(transaction.id)}`,
        metadata: {
          kind: "transaction",
          externalId: transaction.id,
          accountId: transaction.accountId,
          amountCents: transaction.amountCents,
          postedDate: transaction.postedDate,
        },
      });
    }

    const nextCursor: AnvilBiMercuryCursor = {
      accountHashes: nextAccountHashes,
      transactionIds: [...transactionIds].sort(),
    };
    return { status: items.length ? "ok" : "empty", items, cursor: nextCursor };
  } catch (error) {
    const message = error instanceof Error && /not configured/i.test(error.message)
      ? "Mercury is not configured in Anvil BI"
      : "Anvil BI Mercury capture could not be read";
    return { status: "failed", items: [], cursor, error: message };
  }
}

/** Probe an explicitly configured local Telegram relay health endpoint. No
 * Bot API call, message send, browser login, or external URL is permitted. */
export async function readTelegramRelayHealth(
  endpoint: string | null,
  options: LocalHealthOptions = {},
): Promise<LocalCaptureResult<null>> {
  return readLoopbackHealth("telegram-relay", "Telegram relay", endpoint, options);
}

export function localCaptureToLedgerItems(items: readonly LocalCaptureItem[]): LocalCaptureEvidence[] {
  return items.map(({ sourceId, title, text, evidenceRef }) => ({ sourceId, title, ...(text ? { text } : {}), evidenceRef }));
}
