/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type,
 * anti-slop/no-runtime-typeof, anti-slop/no-conditional-empty-object-spread
 * -- Plaud CLI/archive output is an untrusted external boundary; the module
 * constrains IDs, files, transcripts, and cursor records before persistence. */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, extname, join, relative, resolve, sep } from "node:path";

import type { BrowserCaptureReceipt } from "./browser-capture.ts";
import { execCli } from "./procs.ts";
import { redactSecretsInText } from "./redact.ts";

const AUDIO_EXTENSIONS = new Set([".mp3", ".m4a", ".wav", ".aac", ".flac", ".ogg", ".mp4"]);
const NOTE_EXTENSIONS = new Set([".md", ".txt"]);
const MAX_AUDIO_BYTES = 500 * 1024 * 1024;
const MAX_FILES = 500;

export interface PlaudAudioCursor {
  files: Record<string, { digest: string; status: "noted" | "transcribed"; transcriptId?: string }>;
}

export interface PlaudTranscriptItem {
  sourceId: "plaud";
  fileId: string;
  title: string;
  text: string;
  occurredAt: number;
  evidenceRef: string;
  transcriptId: string;
}

export type PlaudAudioResult =
  | { status: "ok" | "empty"; items: PlaudTranscriptItem[]; cursor: PlaudAudioCursor }
  | { status: "needs-config" | "failed"; items: []; cursor: PlaudAudioCursor; error: string };

export interface PlaudTranscription {
  id: string;
  text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeCursor(value: unknown): PlaudAudioCursor {
  if (!isRecord(value) || !isRecord(value.files)) return { files: {} };
  const files: PlaudAudioCursor["files"] = {};
  for (const [fileId, raw] of Object.entries(value.files)) {
    if (!isRecord(raw) || typeof raw.digest !== "string" || (raw.status !== "noted" && raw.status !== "transcribed")) continue;
    files[fileId] = {
      digest: raw.digest,
      status: raw.status,
      ...(typeof raw.transcriptId === "string" ? { transcriptId: raw.transcriptId } : {}),
    };
  }
  return { files };
}

/** Return the cloud id embedded in an Archive filename, or a stable local id. */
export function plaudFileIdForPath(name: string): string {
  const stem = basename(name, extname(name));
  const id = stem.match(/(?:^|_)([a-f0-9]{8,64}(?:-[a-f0-9]{4,64}){1,4})$/i)?.[1]
    ?? stem.match(/(?:^|_)([a-f0-9]{8,64})$/i)?.[1];
  return id?.toLowerCase()
    ?? createHash("sha256").update(stem.toLocaleLowerCase(), "utf8").digest("hex").slice(0, 24);
}

function meaningfulNote(text: string): boolean {
  const content = text
    .replace(/^---[\s\S]*?---/m, "")
    .replace(/^\s*#+\s.*$/gm, "")
    .replace(/^\s*[-*]\s*(?:title|date|duration|id)\s*:.*$/gim, "")
    .trim();
  return content.length >= 20;
}

interface SafeFile {
  path: string;
  relativePath: string;
  size: number;
  modifiedAt: number;
}

function safeFiles(directory: string): SafeFile[] {
  const root = realpathSync(resolve(directory));
  const files: SafeFile[] = [];
  const visit = (folder: string): void => {
    if (files.length >= MAX_FILES) return;
    for (const name of readdirSync(folder)) {
      if (files.length >= MAX_FILES) return;
      const candidate = join(folder, name);
      const info = lstatSync(candidate);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        visit(candidate);
        continue;
      }
      if (!info.isFile()) continue;
      const actual = realpathSync(candidate);
      const relativePath = relative(root, actual);
      if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`)) continue;
      files.push({ path: actual, relativePath: relativePath.replaceAll(sep, "/"), size: info.size, modifiedAt: info.mtimeMs });
    }
  };
  visit(root);
  return files;
}

export async function scanPlaudAudio(
  directory: string,
  previousCursor: unknown,
  transcribe: (audioPath: string) => Promise<PlaudTranscription>,
): Promise<PlaudAudioResult> {
  const cursor = normalizeCursor(previousCursor);
  if (!directory.trim() || !existsSync(directory)) {
    return { status: "needs-config", items: [], cursor, error: "Plaud Archive folder was not found" };
  }
  try {
    const files = safeFiles(directory);
    const notes = new Map<string, string>();
    for (const file of files) {
      if (!NOTE_EXTENSIONS.has(extname(file.path).toLowerCase())) continue;
      notes.set(plaudFileIdForPath(file.relativePath), readFileSync(file.path, "utf8").slice(0, 2_000_000));
    }
    const next: PlaudAudioCursor = { files: { ...cursor.files } };
    const items: PlaudTranscriptItem[] = [];
    for (const file of files) {
      if (!AUDIO_EXTENSIONS.has(extname(file.path).toLowerCase())) continue;
      if (file.size <= 0 || file.size > MAX_AUDIO_BYTES) continue;
      const fileId = plaudFileIdForPath(file.relativePath);
      const digest = createHash("sha256").update(readFileSync(file.path)).digest("hex");
      const note = notes.get(fileId);
      if (note && meaningfulNote(note)) {
        next.files[fileId] = { digest, status: "noted" };
        continue;
      }
      const prior = cursor.files[fileId];
      if (prior?.digest === digest && prior.status === "transcribed") continue;
      const transcript = await transcribe(file.path);
      // Plaud transcripts are user content, but can still contain a copied
      // API key or bearer token. Redact credential-shaped values before the
      // transcript enters Capture memory or a delegated bot context.
      const text = redactSecretsInText(transcript.text.trim());
      if (!text) throw new Error(`Plaud transcription ${transcript.id} completed without text`);
      next.files[fileId] = { digest, status: "transcribed", transcriptId: transcript.id };
      items.push({
        sourceId: "plaud",
        fileId,
        title: basename(file.relativePath, extname(file.relativePath)).slice(0, 240),
        text: text.slice(0, 100_000),
        occurredAt: file.modifiedAt,
        evidenceRef: `plaud-audio://${encodeURIComponent(file.relativePath)}?id=${fileId}`,
        transcriptId: transcript.id,
      });
    }
    return { status: items.length ? "ok" : "empty", items, cursor: next };
  } catch (error) {
    return { status: "failed", items: [], cursor, error: error instanceof Error ? error.message : String(error) };
  }
}

export interface PlaudCliRunResult {
  stdout: string;
  stderr: string;
}

export type PlaudCliRunner = (args: readonly string[]) => Promise<PlaudCliRunResult>;

function defaultPlaudCliRunner(args: readonly string[]): Promise<PlaudCliRunResult> {
  return new Promise((resolveResult, reject) => {
    execCli(
      "plaud",
      [...args],
      { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error("Plaud CLI transcript request failed"));
          return;
        }
        resolveResult({ stdout, stderr: stderr ?? "" });
      },
    );
  });
}

function stripAnsi(value: string): string {
  const escapeCharacter = String.fromCharCode(0x1b);
  const ansiPattern = new RegExp(`${escapeCharacter}\\[[0-?]*[ -/]*[@-~]`, "g");
  return value.replace(ansiPattern, "");
}

export interface PlaudCliRecording {
  id: string;
  title: string;
  date: string;
  duration: string;
}

/** Parse the stable table emitted by `plaud recent` without depending on its
 * progress spinner or summary wording. Titles may themselves contain spaces. */
export function parsePlaudCliRecordings(output: string): PlaudCliRecording[] {
  const row = /^\s*([a-f0-9]{16,64})\s{2,}(.+?)\s{2,}(\d{4}-\d{2}-\d{2})\s{2,}([0-9hms]+)\s*$/i;
  return stripAnsi(output).replaceAll("\r", "").split("\n").flatMap((line) => {
    const match = row.exec(line);
    if (!match?.[1] || !match[2] || !match[3] || !match[4]) return [];
    return [{
      id: match[1].toLowerCase(),
      title: match[2].trim(),
      date: match[3],
      duration: match[4],
    }];
  });
}

function plaudDetailField(output: string, field: "name" | "created_at" | "start_at" | "transcript"): string | null {
  return stripAnsi(output).replaceAll("\r", "").match(new RegExp(`^\\s*${field}:\\s*(.+?)\\s*$`, "mi"))?.[1]?.trim() ?? null;
}

export interface PlaudCliPollOptions {
  run?: PlaudCliRunner;
  days?: number;
  /** Bound work per routine. Unprocessed ids remain absent from the durable
   * cursor and are naturally resumed by the next overlapping recent poll. */
  maxRecordings?: number;
}

/** Poll Plaud's authenticated cloud API through its installed CLI. Only
 * recording metadata and Plaud-native transcripts are requested; audio is
 * never downloaded or uploaded. The durable id cursor makes the poll
 * delta-only even when `plaud recent` returns an overlapping time window. */
export async function pollPlaudCliRecordings(
  previousCursor: unknown,
  options: PlaudCliPollOptions = {},
): Promise<PlaudAudioResult> {
  const cursor = normalizeCursor(previousCursor);
  const run = options.run ?? defaultPlaudCliRunner;
  const requestedDays = options.days ?? 14;
  const days = Number.isInteger(requestedDays) && requestedDays >= 1 && requestedDays <= 31 ? requestedDays : 14;
  const requestedMax = options.maxRecordings ?? 4;
  const maxRecordings = Number.isInteger(requestedMax) && requestedMax >= 1 && requestedMax <= 20 ? requestedMax : 4;
  try {
    const listing = await run(["recent", "--days", String(days)]);
    const recordings = parsePlaudCliRecordings(listing.stdout)
      .filter((recording) => cursor.files[recording.id]?.status !== "transcribed")
      .slice(0, maxRecordings);
    const next: PlaudAudioCursor = { files: { ...cursor.files } };
    const items: PlaudTranscriptItem[] = [];
    for (const recording of recordings) {
      const digest = createHash("sha256")
        .update(JSON.stringify([recording.id, recording.title, recording.date, recording.duration]))
        .digest("hex");
      const details = await run(["file", recording.id]);
      const transcriptState = plaudDetailField(details.stdout, "transcript")?.toLowerCase();
      // A new recording may remain in Plaud's processing queue briefly. Leave
      // it out of the cursor so the next bounded poll tries it again.
      if (transcriptState !== "available") continue;
      const transcript = await run(["transcript", "--polished", recording.id]);
      const text = redactSecretsInText(parsePlaudCliTranscript(transcript.stdout));
      if (!text) continue;
      const preciseDate = plaudDetailField(details.stdout, "start_at")
        ?? plaudDetailField(details.stdout, "created_at")
        ?? `${recording.date}T12:00:00`;
      const occurredAt = Date.parse(preciseDate);
      next.files[recording.id] = { digest, status: "transcribed", transcriptId: recording.id };
      items.push({
        sourceId: "plaud",
        fileId: recording.id,
        title: (plaudDetailField(details.stdout, "name") ?? recording.title).slice(0, 240),
        text: text.slice(0, 100_000),
        occurredAt: Number.isFinite(occurredAt) ? occurredAt : Date.parse(`${recording.date}T12:00:00`),
        evidenceRef: `plaud://recording/${encodeURIComponent(recording.id)}`,
        transcriptId: recording.id,
      });
    }
    return { status: items.length ? "ok" : "empty", items, cursor: next };
  } catch {
    return { status: "failed", items: [], cursor, error: "Plaud CLI recording poll failed" };
  }
}

/** Parse the human CLI output without ever asking the CLI to download audio. */
export function parsePlaudCliTranscript(output: string): string {
  const clean = stripAnsi(output).replaceAll("\r", "");
  if (/^\s*No [^\n]*transcript/i.test(clean)) return "";
  const marker = clean.match(/^\s*Transcript:\s*[^\n]*\n([\s\S]*)$/im);
  const body = marker?.[1] ?? clean;
  return body
    .split("\n")
    .filter((line) => !/^\s*Fetching transcript\.\.\.\s*$/i.test(line))
    .join("\n")
    .trim();
}

/** Transcript provider backed by the installed Plaud CLI's API client. */
export function createPlaudCliTranscriber(options: { run?: PlaudCliRunner } = {}): (audioPath: string) => Promise<PlaudTranscription> {
  const run = options.run ?? defaultPlaudCliRunner;
  return async (audioPath) => {
    const id = plaudFileIdForPath(audioPath);
    const result = await run(["transcript", id]);
    const text = parsePlaudCliTranscript(result.stdout);
    if (!text) throw new Error(`Plaud transcript is unavailable for ${id}`);
    return { id, text };
  };
}

/** One-shot name for callers that do not need to retain a provider instance. */
export function transcribePlaudWithLocalCli(
  audioPath: string,
  options: { run?: PlaudCliRunner } = {},
): Promise<PlaudTranscription> {
  return createPlaudCliTranscriber(options)(audioPath);
}

/** Convert only validated Plaud browser receipts into transcript items. */
export function plaudReceiptsToTranscriptItems(receipts: readonly BrowserCaptureReceipt[]): PlaudTranscriptItem[] {
  return receipts.flatMap((receipt) => receipt.items.flatMap((item, index) => {
    const text = item.text?.trim() ?? "";
    if (!text) return [];
    const occurredAt = Date.parse(receipt.capturedAt);
    if (!Number.isFinite(occurredAt)) return [];
    const transcriptId = receipt.captureId;
    const transcriptItem: PlaudTranscriptItem = {
      sourceId: "plaud",
      fileId: `receipt-${receipt.captureId}-${index}`,
      title: item.title.slice(0, 240),
      text: text.slice(0, 100_000),
      occurredAt,
      evidenceRef: `${receipt.url}#capture=${receipt.captureId}`,
      transcriptId,
    };
    return [transcriptItem];
  }));
}
