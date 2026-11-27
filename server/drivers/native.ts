// Tees every provider-native message beside the canonical stream, so protocol drift shows up in a diff. Lines are held
// per thread and appended together every FLUSH_MS, when a caller flushes, and at exit.
import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { NATIVE_DIR } from "../config.ts";
import { redactSecrets } from "../redact.ts";
import { capThreadLog, currentThreadLogCap } from "../thread-log-rotation.ts";

const INLINE_DATA_CHARS = 1024;
const DATA_URL = /^data:[^,;]{0,100};base64,/;
const FLUSH_MS = 250;
const MAX_HELD_CHARS = 256 * 1024;

const held = new Map<string, string[]>();
let heldChars = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

function carriesBase64(record: Record<string, unknown>): boolean {
  return record.type === "base64" || record.type === "image" || imageMedia(record);
}

function imageMedia(record: Record<string, unknown>): boolean {
  const media = record.media_type ?? record.mimeType ?? record.mime_type;
  return typeof media === "string" && media.startsWith("image/");
}

/** Screenshots and files inline as base64 carry no protocol shape, only their length. */
function withoutInlineData(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length > INLINE_DATA_CHARS && DATA_URL.test(value) ? `[data URL: ${value.length} chars]` : value;
  }
  if (depth > 12 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    let changed = false;
    const items = value.map((item) => {
      const next = withoutInlineData(item, depth + 1);
      changed ||= next !== item;
      return next;
    });
    return changed ? items : value;
  }
  const record = value as Record<string, unknown>;
  let copy: Record<string, unknown> | undefined;
  for (const [key, child] of Object.entries(record)) {
    const next = key === "data" && typeof child === "string" && child.length > INLINE_DATA_CHARS && carriesBase64(record)
      ? `[${record.type === "image" || imageMedia(record) ? "image" : "base64"} data: ${child.length} base64 chars]`
      : withoutInlineData(child, depth + 1);
    if (next !== child) (copy ??= { ...record })[key] = next;
  }
  return copy ?? value;
}

/** A fragment a later record of the same protocol carries whole: Claude Code's content_block_delta stream events (then
 * the assistant message), Codex app-server item deltas (then item/completed), Pi's message and tool updates (then
 * message_end and tool_execution_end). */
export function streamedFragment(source: string, msg: unknown): boolean {
  if (msg === null || typeof msg !== "object") return false;
  const record = msg as Record<string, unknown>;
  if (source === "claude.sdk.message") return record.type === "stream_event" && (record.event as { type?: unknown } | undefined)?.type === "content_block_delta";
  if (source === "codex.app-server") return typeof record.method === "string" && record.method.startsWith("item/") && /delta$/i.test(record.method);
  if (source === "pi.rpc") return record.type === "message_update" || record.type === "tool_execution_update";
  return false;
}

export function appendNative(threadId: string, entry: { dir: "in" | "out"; source: string; msg: unknown }) {
  if (streamedFragment(entry.source, entry.msg)) return;
  let line: string;
  try {
    // Session setup carries agent credentials (boat/comms tokens, MCP headers) and
    // people paste these logs into bug reports, so values are masked.
    line = JSON.stringify({ at: new Date().toISOString(), ...entry, msg: redactSecrets(withoutInlineData(entry.msg)) }) + "\n";
  } catch {
    return;
  }
  const lines = held.get(threadId);
  if (lines) lines.push(line);
  else held.set(threadId, [line]);
  heldChars += line.length;
  // What OpenMausBot sent is a few lines a turn, and the line a bug report most needs: it lands at once.
  if (entry.dir === "out") flushNativeLog(threadId);
  else if (heldChars >= MAX_HELD_CHARS) flushNativeLogs();
  else if (!timer) {
    timer = setTimeout(flushNativeLogs, FLUSH_MS);
    timer.unref?.();
  }
}

export function flushNativeLog(threadId: string): void {
  const lines = take(threadId);
  if (!lines) return;
  const file = join(NATIVE_DIR, `${threadId}.ndjson`);
  try {
    appendFileSync(file, lines.join(""), { mode: 0o600 });
    capThreadLog(file, currentThreadLogCap());
  } catch {}
}

export function flushNativeLogs(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  for (const threadId of Array.from(held.keys())) flushNativeLog(threadId);
}

/** A deleted thread's held lines are dropped, so a later flush cannot recreate its log. */
export function discardNativeLog(threadId: string): void {
  take(threadId);
}

function take(threadId: string): string[] | undefined {
  const lines = held.get(threadId);
  if (!lines) return undefined;
  held.delete(threadId);
  for (const line of lines) heldChars -= line.length;
  return lines;
}

process.once("exit", flushNativeLogs);
