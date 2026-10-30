// Tees every provider-native message beside the canonical stream, so protocol drift shows up in a diff.
import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { NATIVE_DIR } from "../config.ts";
import { redactSecrets } from "../redact.ts";
import { capThreadLog, currentThreadLogCap } from "../thread-log-rotation.ts";

const INLINE_DATA_CHARS = 1024;
const DATA_URL = /^data:[^,;]{0,100};base64,/;

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

export function appendNative(threadId: string, entry: { dir: "in" | "out"; source: string; msg: unknown }) {
  const file = join(NATIVE_DIR, `${threadId}.ndjson`);
  try {
    // Session setup carries agent credentials (boat/comms tokens, MCP headers) and
    // people paste these logs into bug reports, so values are masked.
    appendFileSync(
      file,
      JSON.stringify({ at: new Date().toISOString(), ...entry, msg: redactSecrets(withoutInlineData(entry.msg)) }) + "\n",
      { mode: 0o600 },
    );
    capThreadLog(file, currentThreadLogCap());
  } catch {}
}
