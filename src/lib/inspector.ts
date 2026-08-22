// Turning the inspector's two record shapes into one-line summaries. Pure
// so the panel stays a thin renderer and the labels can be tested.
import type { RuntimeEvent } from "../../server/contracts.ts";
import type { InspectorEntry, NativeRecord } from "../../server/thread-events.ts";
export type { InspectorEntry, InspectorPage, NativeRecord } from "../../server/thread-events.ts";

interface FoldPreview {
  text: string;
  pendingSpace: boolean;
  overflow: boolean;
}

/** A row in the panel: adjacent content.delta events fold into one so a
 * streamed paragraph is one line, not three hundred. */
export interface InspectorRow {
  key: string;
  kind: "runtime" | "native";
  at: string;
  /** short badge — the event type, or in/out for native */
  tag: string;
  /** what happened, in one line */
  summary: string;
  /** visual weight: a turn boundary, a failure, or plain */
  tone: "boundary" | "error" | "plain";
  /** the record(s) behind the row, for the expanded view */
  data: unknown;
  /** > 1 when deltas were folded */
  count: number;
  /** bounded, incrementally normalized preview for a folded delta run */
  preview?: FoldPreview;
}

const clip = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const FOLD_PREVIEW_CHARS = 119;

function appendPreview(previous: FoldPreview | undefined, delta: string): FoldPreview {
  const next: FoldPreview = previous ? { ...previous } : { text: "", pendingSpace: false, overflow: false };
  if (next.overflow) return next;
  for (const char of delta) {
    if (/\s/.test(char)) {
      if (next.text) next.pendingSpace = true;
      continue;
    }
    if (next.pendingSpace) {
      if (next.text.length >= FOLD_PREVIEW_CHARS) {
        next.overflow = true;
        break;
      }
      next.text += " ";
      next.pendingSpace = false;
    }
    if (next.text.length >= FOLD_PREVIEW_CHARS) {
      next.overflow = true;
      break;
    }
    next.text += char;
  }
  return next;
}

const previewText = (preview: FoldPreview) => `${preview.text}${preview.overflow ? "…" : ""}`;

export function summarizeRuntime(e: RuntimeEvent): { summary: string; tone: InspectorRow["tone"] } {
  switch (e.type) {
    case "session.started":
      return { summary: `session ${e.sessionId ?? "(none)"}${e.model ? ` · ${e.model}` : ""}`, tone: "plain" };
    case "session.exited":
      return { summary: `session exited${e.reason ? ` · ${e.reason}` : ""}`, tone: "plain" };
    case "turn.started":
      return { summary: `turn started${e.turnId ? ` · ${e.turnId.slice(0, 8)}` : ""}`, tone: "boundary" };
    case "turn.completed": {
      const parts = [e.ok ? "turn ok" : "turn failed"];
      if (e.stopReason) parts.push(e.stopReason);
      if (typeof e.cost === "number") parts.push(`$${e.cost.toFixed(4)}`);
      if (e.denials?.length) parts.push(`${e.denials.length} denied`);
      return { summary: parts.join(" · "), tone: e.ok ? "boundary" : "error" };
    }
    case "item.started":
      return { summary: `${e.itemType}${e.title ? `: ${clip(oneLine(e.title))}` : " started"}`, tone: "plain" };
    case "item.updated":
      return { summary: `${e.itemType} updated${typeof e.tokens === "number" ? ` · ${e.tokens} tok` : ""}`, tone: "plain" };
    case "item.completed":
      if (e.itemType === "assistant_text") return { summary: `assistant: ${clip(oneLine(e.text))}`, tone: "plain" };
      return { summary: `tool ${e.ok ? "ok" : "failed"}`, tone: e.ok ? "plain" : "error" };
    case "content.delta":
      return { summary: `${e.streamKind}: ${clip(oneLine(e.delta))}`, tone: "plain" };
    case "request.opened":
      return { summary: `${e.requestType}: ${e.tool} — ${clip(oneLine(e.summary))}`, tone: "plain" };
    case "request.resolved":
      return { summary: `resolved ${e.behavior} · ${e.source}`, tone: "plain" };
    case "thread.token-usage.updated":
      return { summary: `tokens in ${e.input} · out ${e.output}`, tone: "plain" };
    case "runtime.error":
      return { summary: `${e.setup ? "setup: " : ""}${clip(oneLine(e.message))}`, tone: "error" };
    default:
      return { summary: (e as { type: string }).type, tone: "plain" };
  }
}

export function summarizeNative(r: NativeRecord): string {
  const msg = r.msg as Record<string, unknown> | null;
  if (!msg || typeof msg !== "object") return String(r.msg);
  const method = typeof msg.method === "string" ? msg.method : undefined;
  const type = typeof msg.type === "string" ? msg.type : undefined;
  const id = msg.id !== undefined ? ` #${String(msg.id)}` : "";
  if (method) return `${method}${id}`;
  // antigravity's stream keys on `event`, with the outcome under result.status
  if (typeof msg.event === "string") {
    const status = (msg.result as Record<string, unknown> | undefined)?.status;
    return typeof status === "string" ? `${msg.event} · ${status}` : msg.event;
  }
  if (type) {
    // claude stream-json: surface the role/subtype so a user turn and an
    // assistant chunk don't both read as "message"
    const inner = msg.message as Record<string, unknown> | undefined;
    const role = typeof inner?.role === "string" ? ` · ${inner.role}` : "";
    const subtype = typeof msg.subtype === "string" ? ` · ${msg.subtype}` : "";
    return `${type}${subtype}${role}`;
  }
  if (msg.result !== undefined) return `result${id}`;
  if (msg.error !== undefined) return `error${id}`;
  return clip(oneLine(JSON.stringify(msg)));
}

/** Entries → rows, folding runs of content.delta on the same stream. */
export function toRows(entries: InspectorEntry[]): InspectorRow[] {
  const rows: InspectorRow[] = [];
  for (const [i, entry] of entries.entries()) {
    if (entry.kind === "native") {
      rows.push({
        key: `n${i}`,
        kind: "native",
        at: entry.at,
        tag: entry.data.dir === "out" ? "→ out" : "← in",
        summary: `${entry.data.source} · ${summarizeNative(entry.data)}`,
        tone: "plain",
        data: entry.data,
        count: 1,
      });
      continue;
    }
    const e = entry.data;
    const last = rows.at(-1);
    if (
      e.type === "content.delta" &&
      last?.kind === "runtime" &&
      last.tag === "content.delta" &&
      (last.data as RuntimeEvent[])[0]?.type === "content.delta" &&
      ((last.data as RuntimeEvent[])[0] as { streamKind: string }).streamKind === e.streamKind
    ) {
      const list = last.data as RuntimeEvent[];
      list.push(e);
      last.count = list.length;
      last.preview = appendPreview(last.preview, e.delta);
      last.summary = `${e.streamKind}: ${previewText(last.preview)}`;
      continue;
    }
    const { summary, tone } = summarizeRuntime(e);
    const preview = e.type === "content.delta" ? appendPreview(undefined, e.delta) : undefined;
    const streamKind = e.type === "content.delta" ? e.streamKind : undefined;
    rows.push({
      key: e.eventId || `r${i}`,
      kind: "runtime",
      at: entry.at,
      tag: e.type,
      summary: preview && streamKind ? `${streamKind}: ${previewText(preview)}` : summary,
      tone,
      data: e.type === "content.delta" ? [e] : e,
      count: 1,
      preview,
    });
  }
  return rows;
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}
