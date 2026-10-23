import { ApiError, api } from "@/state/store";

export const MEMORY_INDEX = "MEMORY.md";

export interface MemoryCapacity {
  lines: number;
  bytes: number;
  maxLines: number;
  maxBytes: number;
  loadedLines: number;
  loadedBytes: number;
  truncated: boolean;
  hash: string;
}

export interface MemoryFileInfo {
  path: string;
  name: string;
  bytes: number;
  modifiedAt: number;
}

export interface MemoryOverview {
  lendingReview?: LendingReview;
  botId: string;
  workspacePath: string;
  index: MemoryCapacity;
  topics: MemoryFileInfo[];
  logs: MemoryFileInfo[];
}

export interface MemoryDoc {
  path: string;
  text: string;
  hash: string;
  exists: boolean;
}

export type MemoryActor = "bot" | "person" | "import" | "upkeep";

export interface MemoryJournalRow {
  id: string;
  at: number;
  botId: string;
  path: string;
  actor: MemoryActor;
  via: string;
  threadId?: string;
  threadTitle?: string;
  kind: "created" | "edited" | "deleted";
  beforeHash: string | null;
  afterHash: string | null;
  diff: string;
  added: number;
  removed: number;
  canRevert: boolean;
  revertUnavailableReason?: string;
}

export type SaveResult =
  | { ok: true; doc: MemoryDoc; overview: MemoryOverview }
  | { ok: false; conflict: true; current: string; currentHash: string };

export function fetchMemoryOverview(botId: string): Promise<MemoryOverview> {
  return api(`/api/bots/${botId}/memory`);
}

export function fetchMemoryDoc(botId: string, path: string): Promise<MemoryDoc> {
  return api(`/api/bots/${botId}/memory/file?path=${encodeURIComponent(path)}`);
}

export async function saveMemoryDoc(botId: string, path: string, text: string, expectedHash: string | undefined): Promise<SaveResult> {
  const response = await fetch(`/api/bots/${botId}/memory/file`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, text, expectedHash }),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (response.status === 409 && typeof body.current === "string" && typeof body.currentHash === "string") {
    return { ok: false, conflict: true, current: body.current, currentHash: body.currentHash };
  }
  if (!response.ok) throw new ApiError(typeof body.error === "string" ? body.error : `${response.status} ${response.statusText}`, response.status);
  const saved = body as unknown as MemoryDoc & { overview: MemoryOverview };
  return { ok: true, doc: { path: saved.path, text: saved.text, hash: saved.hash, exists: saved.exists }, overview: saved.overview };
}

export function deleteMemoryDoc(botId: string, path: string): Promise<{ overview: MemoryOverview }> {
  return api(`/api/bots/${botId}/memory/file?path=${encodeURIComponent(path)}`, { method: "DELETE" });
}

export async function fetchMemoryJournal(botId: string, limit = 50): Promise<MemoryJournalRow[]> {
  const result: { entries: MemoryJournalRow[] } = await api(`/api/bots/${botId}/memory/journal?limit=${limit}`);
  return result.entries;
}

export function revertMemoryChange(botId: string, entryId: string): Promise<MemoryDoc & { overview: MemoryOverview }> {
  return api(`/api/bots/${botId}/memory/journal/${encodeURIComponent(entryId)}/revert`, { method: "POST" });
}

export interface TidyReport {
  at: number;
  expired: number;
  duplicates: number;
  superseded: number;
  deferred: number;
  organized?: number;
  contradictionsChecked: boolean;
  note?: string;
}

export interface CaptureReport {
  at: number;
  added: number;
  topics?: number;
  aboutMe?: number;
  note?: string;
}

export interface DreamReport {
  at: number;
  conversations: number;
  learned: { text: string; where: string }[];
  outdated: { was: string; now: string }[];
  ideas: string[];
  aboutMe: number;
  note?: string;
}

export interface UpkeepStatus {
  enabled: boolean;
  modelSteps: boolean;
  lastTidy?: TidyReport;
  lastCapture?: CaptureReport;
  /** Dream every night; absent from a server without dreaming. */
  dreams?: boolean;
  lastDream?: DreamReport;
}

export function noticedCount(report: CaptureReport | undefined): number {
  return report ? report.added + (report.topics ?? 0) : 0;
}

export function fetchUpkeepStatus(botId: string): Promise<UpkeepStatus> {
  return api(`/api/bots/${botId}/memory/upkeep`);
}

export interface LendingReview {
  token: string;
  changed: string[];
}

export function markMemoryReviewed(botId: string, token: string): Promise<{ ok: true; lendingReview: false }> {
  return api(`/api/bots/${botId}/memory/reviewed`, { method: "POST", body: JSON.stringify({ token }) });
}

export function tidyMemoryNow(botId: string): Promise<{ report: TidyReport; overview: MemoryOverview }> {
  return api(`/api/bots/${botId}/memory/tidy`, { method: "POST" });
}

export function dreamNow(botId: string): Promise<{ report: DreamReport; overview: MemoryOverview }> {
  return api(`/api/bots/${botId}/memory/dream`, { method: "POST" });
}

export function setNightlyDreams(botId: string, nightly: boolean): Promise<UpkeepStatus> {
  return api(`/api/bots/${botId}/memory/dream`, { method: "PATCH", body: JSON.stringify({ nightly }) });
}

export function tidySummary(report: TidyReport): string {
  const parts: string[] = [];
  if (report.expired) parts.push(`archived ${report.expired} expired note${report.expired === 1 ? "" : "s"}`);
  if (report.duplicates) parts.push(`merged ${report.duplicates} duplicate${report.duplicates === 1 ? "" : "s"}`);
  if (report.superseded) parts.push(`crossed out ${report.superseded} contradicted note${report.superseded === 1 ? "" : "s"}`);
  if (report.organized) parts.push(`filed ${report.organized} note${report.organized === 1 ? "" : "s"} into topics`);
  const head = parts.length ? parts.join(", ") : "nothing to tidy";
  return head.charAt(0).toUpperCase() + head.slice(1);
}

export type MemoryOpenTarget = "obsidian" | "folder";

export function openMemoryLocation(botId: string, target: MemoryOpenTarget): Promise<{ ok: boolean; workspacePath: string }> {
  return api(`/api/bots/${botId}/memory/open`, { method: "POST", body: JSON.stringify({ target }) });
}


export function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 102.4) / 10} KB`;
}

export function relativeTime(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(at).toLocaleDateString([], { month: "short", day: "numeric" });
}

export function localizedRelativeTime(at: number, locale: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (seconds < 45) return formatter.format(0, "second");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return formatter.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return formatter.format(-hours, "hour");
  const days = Math.round(hours / 24);
  if (days < 7) return formatter.format(-days, "day");
  return new Date(at).toLocaleDateString(locale, { month: "short", day: "numeric" });
}

export type CapacityLevel = "ok" | "near" | "over";

export interface CapacityStatus {
  level: CapacityLevel;
  lineShare: number;
  byteShare: number;
  sentence: string;
  warning: string | null;
}

export function capacityStatus(index: MemoryCapacity): CapacityStatus {
  const lineShare = index.maxLines ? index.lines / index.maxLines : 0;
  const byteShare = index.maxBytes ? index.bytes / index.maxBytes : 0;
  const level: CapacityLevel = index.truncated ? "over" : Math.max(lineShare, byteShare) >= 0.8 ? "near" : "ok";
  const sentence = `${index.lines} of ${index.maxLines} lines · ${formatBytes(index.bytes)} of ${formatBytes(index.maxBytes)} — only the first ${index.maxLines} lines load each turn.`;
  let warning: string | null = null;
  if (index.truncated) {
    const missingLines = index.lines - index.loadedLines;
    warning = missingLines > 0
      ? `${index.lines} lines saved, ${index.loadedLines} load into every conversation — ${missingLines} ${missingLines === 1 ? "line is" : "lines are"} not being loaded. Trim this file or move notes into a topic file.`
      : `${formatBytes(index.bytes)} saved, ${formatBytes(index.loadedBytes)} load into every conversation — the rest is not being loaded. Trim this file or move notes into a topic file.`;
  }
  return { level, lineShare, byteShare, sentence, warning };
}

export function fileLabel(path: string): string {
  if (path === MEMORY_INDEX) return "MEMORY.md";
  if (path.startsWith("memory/log/")) return path.slice("memory/log/".length).replace(/\.md$/, "");
  return path.replace(/^memory\//, "").replace(/\.md$/, "");
}

export function journalSummary(row: MemoryJournalRow, botName: string): string {
  const who = row.actor === "bot" ? botName : row.actor === "import" ? "An import" : row.actor === "upkeep" ? "Memory upkeep" : "You";
  const file = fileLabel(row.path);
  const isIndex = row.path === MEMORY_INDEX;
  const topic = isIndex ? file : row.path.startsWith("memory/log/") ? `the ${file} log` : `the ${file} topic`;
  if (row.kind === "created") return `${who} created ${topic}${row.added ? ` with ${plural(row.added, "line")}` : ""}`;
  if (row.kind === "deleted") return `${who} deleted ${topic}`;
  if (row.added && !row.removed) return `${who} added ${plural(row.added, "line")} to ${topic}`;
  if (row.removed && !row.added) return `${who} removed ${plural(row.removed, "line")} from ${topic}`;
  return `${who} rewrote ${plural(Math.max(row.added, row.removed), "line")} in ${topic}`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function journalSource(row: MemoryJournalRow): string | null {
  if (row.via === "revert") return "undo";
  if (row.via === "disk") return "changed outside the app";
  if (row.via === "tidy") return "tidy-up";
  if (row.via === "organize") return "filed into topics";
  if (row.via === "capture") return row.threadTitle ? `noticed in chat “${row.threadTitle}”` : "noticed in a chat";
  if (row.threadTitle) return `from chat “${row.threadTitle}”`;
  if (row.actor === "bot") return "during a task";
  if (row.via === "ui") return "in Settings";
  if (row.via === "api") return "through the API";
  return null;
}

export function journalSourceKey(row: MemoryJournalRow): "memory.source.undo" | "memory.source.disk" | "memory.source.tidy" | "memory.source.organize" | "memory.source.capture" | "memory.source.captureWithTitle" | "memory.source.chat" | "memory.source.task" | "memory.source.settings" | "memory.source.api" | null {
  if (row.via === "revert") return "memory.source.undo";
  if (row.via === "disk") return "memory.source.disk";
  if (row.via === "tidy") return "memory.source.tidy";
  if (row.via === "organize") return "memory.source.organize";
  if (row.via === "capture") return row.threadTitle ? "memory.source.captureWithTitle" : "memory.source.capture";
  if (row.threadTitle) return "memory.source.chat";
  if (row.actor === "bot") return "memory.source.task";
  if (row.via === "ui") return "memory.source.settings";
  if (row.via === "api") return "memory.source.api";
  return null;
}

export function fileManagerLabel(platform: string | undefined): string {
  if (platform === "darwin") return "Show in Finder";
  if (platform === "win32") return "Show in Explorer";
  return "Show in file manager";
}

export function topicFileName(input: string): string | null {
  const stem = input.trim().replace(/\.md$/i, "").replace(/[^\w .-]+/g, "-").replace(/^[^\w]+/, "").trim();
  if (!stem) return null;
  return `${stem}.md`;
}
