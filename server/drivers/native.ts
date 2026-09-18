// Native (un-normalized) protocol tee — the debugging trick from upstream's
// EventNdjsonLogger and agentcal's onRaw: provider-native envelopes are kept
// next to the canonical stream, with private cursors, paths, integrations, and
// prompt bodies removed before they become durable diagnostics.
import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { NATIVE_DIR } from "../config.ts";
import { redactSecrets } from "../redact.ts";
import { capThreadLog, currentThreadLogCap } from "../thread-log-rotation.ts";

const PRIVATE_SESSION_KEYS = new Set([
  "sessionId", "session_id", "sessionPath", "sessionFile", "session_file",
  "resumeCursor", "resume_cursor", "cursor",
  // Provider-native thread/run ids are just as reusable as a session cursor
  // (Codex threadId, Box promptId, and similar values). Keep them out of
  // diagnostics even when they are nested under a response envelope.
  "threadId", "thread_id", "promptId", "prompt_id", "promptRunId", "prompt_run_id",
  "runId", "run_id", "taskId", "task_id", "turnId", "turn_id",
]);
const PRIVATE_PATH_KEYS = new Set(["cwd", "workingDirectory", "workspace", "workspacePath", "savedPath"]);
const PRIVATE_RUN_CONTAINER_KEYS = new Set(["promptRun", "prompt_run", "thread", "turn"]);
const PROMPT_STRING_KEYS = new Set(["text", "content", "prompt", "message", "input"]);

function byteCount(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function promptSummary(value: unknown, stringIsPrompt = true): unknown {
  if (typeof value === "string") {
    return stringIsPrompt ? `[prompt omitted · ${byteCount(value)} bytes]` : value;
  }
  if (Array.isArray(value)) return value.map((entry) =>
    typeof entry === "string" ? `[prompt omitted · ${byteCount(entry)} bytes]` : promptSummary(entry, false));
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (record.type === "text" && typeof record.text === "string") {
    const { text: _text, ...shape } = record;
    return { ...shape, bytes: byteCount(record.text) };
  }
  if (record.type === "image") {
    const data = typeof record.data === "string" ? record.data : undefined;
    const source = record.source && typeof record.source === "object" ? record.source as Record<string, unknown> : undefined;
    const sourceData = source && typeof source.data === "string" ? source.data : undefined;
    if (data !== undefined) return { ...record, data: /^\[image data: \d+ base64 chars\]$/.test(data) ? data : `[image data: ${data.length} base64 chars]` };
    if (sourceData !== undefined) {
      return {
        ...record,
        source: {
          ...source,
          data: /^\[image data: \d+ base64 chars\]$/.test(sourceData)
            ? sourceData
            : `[image data: ${sourceData.length} base64 chars]`,
        },
      };
    }
  }
  // Preserve protocol shape while dropping nested text-bearing prompt blocks.
  return Object.fromEntries(Object.entries(record).map(([key, entry]) =>
    PROMPT_STRING_KEYS.has(key) && typeof entry === "string"
      ? [key, `[prompt omitted · ${byteCount(entry)} bytes]`]
      : [key, promptSummary(entry, false)]));
}

function sanitizeMcpServers(_value: unknown): unknown {
  // Even after credential masking, server names, commands, args, headers,
  // and environment shape can disclose private integrations or filesystem
  // layout. Prompt-plan receipts intentionally carry no MCP details.
  return "[MCP configuration omitted]";
}

/** Native traces are diagnostic artifacts, not a second transcript. Keep
 * protocol method/shape metadata while removing prompt bodies, native
 * session cursors, working paths, and MCP payloads before they hit disk or
 * the inspector. The provider still receives the original message. */
export function sanitizeNativeMessage(source: string, message: unknown): unknown {
  const root = message && typeof message === "object" && !Array.isArray(message)
    ? message as Record<string, unknown>
    : null;
  const method = typeof root?.method === "string" ? root.method : "";
  const isAcpPrompt = method === "session/prompt";
  const isPiPrompt = root?.type === "prompt";
  const isClaudeUser = root?.type === "user" && root.message && typeof root.message === "object";
  const isBoxPrompt = source === "box.prompt";
  const isCodexTurn = method === "turn/start" || method === "turn/steer";
  const isOpenAiRequest = Array.isArray(root?.messages);
  const visit = (value: unknown, prompt = false, depth = 0, privateRun = false): unknown => {
    if (depth > 16 || value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((entry) => visit(entry, prompt, depth + 1, privateRun));
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) {
      if (privateRun && key === "id") {
        out[key] = "[native run id omitted]";
      } else if (PRIVATE_SESSION_KEYS.has(key)) {
        out[key] = "[native session id omitted]";
      } else if (PRIVATE_PATH_KEYS.has(key)) {
        out[key] = "[private path omitted]";
      } else if (key === "mcpServers") {
        out[key] = sanitizeMcpServers(entry);
      } else if (PRIVATE_RUN_CONTAINER_KEYS.has(key)) {
        out[key] = visit(entry, prompt, depth + 1, true);
      } else if (isAcpPrompt && key === "prompt") {
        out[key] = promptSummary(entry);
      } else if (isPiPrompt && key === "message") {
        out[key] = promptSummary(entry);
      } else if (isBoxPrompt && key === "prompt") {
        out[key] = promptSummary(entry);
      } else if (isClaudeUser && key === "content") {
        out[key] = promptSummary(entry);
      } else if (isCodexTurn && key === "input") {
        out[key] = promptSummary(entry);
      } else if (isOpenAiRequest && key === "messages") {
        out[key] = promptSummary(entry);
      } else if (method === "session/update" && key === "content" &&
        record.sessionUpdate === "user_message_chunk") {
        out[key] = promptSummary(entry);
      } else if (prompt && key === "text" && typeof entry === "string") {
        out[key] = `[prompt omitted · ${byteCount(entry)} bytes]`;
      } else {
        out[key] = visit(entry, prompt, depth + 1, privateRun);
      }
    }
    return out;
  };
  return visit(message, false);
}

export function appendNative(threadId: string, entry: { dir: "in" | "out"; source: string; msg: unknown }) {
  const file = join(NATIVE_DIR, `${threadId}.ndjson`);
  try {
    // The session-setup messages carry the credentials the agent is handed —
    // the box and comms tokens ride inside session/new's mcpServers env, and
    // an MCP header can carry a Composio key. These files are ordinary
    // 0644 files people paste into bug reports, so values are masked while
    // the shape stays intact.
    appendFileSync(
      file,
      JSON.stringify({ at: new Date().toISOString(), ...entry, msg: redactSecrets(sanitizeNativeMessage(entry.source, entry.msg)) }) + "\n",
      { mode: 0o600 },
    );
    // Best-effort size cap (#1280) — same rule as the write itself: never
    // let logging break the run it is observing.
    capThreadLog(file, currentThreadLogCap());
  } catch {
    /* never let logging break a run */
  }
}
