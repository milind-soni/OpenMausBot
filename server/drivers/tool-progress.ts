// Each engine's own report of a tool call in progress, read into the status line's turn.progress. Claude Code streams a
// call's input as it is generated (stream-json with --include-partial-messages); Codex streams an apply_patch as
// item/fileChange/patchUpdated; ACP agents describe a call in tool_call and tool_call_update. Engines that report none
// of these leave the chat on its elapsed timer.
import { progressFile, type TurnProgressActivity, type TurnProgressFields } from "../../shared/turn-progress.ts";

const CLAUDE_TOOLS: Record<string, TurnProgressActivity> = {
  Write: "write",
  Edit: "edit",
  MultiEdit: "edit",
  NotebookEdit: "edit",
  Bash: "command",
  WebSearch: "web",
  WebFetch: "fetch",
  Read: "read",
  Grep: "search",
  Glob: "search",
  LS: "search",
};

interface ClaudeDraft {
  id: string;
  name: string;
  bytes: number;
  head: string;
  file?: string;
}

/** Only the start of a call's input is searched for its path: Write and Edit name the file first. */
const HEAD_MAX = 4096;
const PATH_FIELD = /"(?:file_path|notebook_path|path)"\s*:\s*"((?:[^"\\]|\\.)*)"/;

const claudeDrafts = new WeakMap<object, Map<number, ClaudeDraft>>();

function report(activity: TurnProgressActivity, tool: string, fields: Omit<TurnProgressFields, "type" | "activity" | "tool">): TurnProgressFields {
  return { type: "turn.progress", activity, ...(activity === "tool" ? { tool: tool.slice(0, 80) } : {}), ...fields };
}

function claudeReport(draft: ClaudeDraft): TurnProgressFields {
  return report(CLAUDE_TOOLS[draft.name] ?? "tool", draft.name, { itemId: draft.id, bytes: draft.bytes, ...(draft.file ? { file: draft.file } : {}) });
}

/** One Claude stream event: a tool_use block opening, or more of its input JSON. `owner` keys the open blocks (one CLI
 * session); a new message starts them over. */
export function claudeToolDraft(owner: object, event: unknown): TurnProgressFields | null {
  const ev = event as { type?: unknown; index?: unknown; content_block?: any; delta?: any } | null;
  if (!ev || typeof ev !== "object") return null;
  if (ev.type === "message_start") {
    claudeDrafts.delete(owner);
    return null;
  }
  if (typeof ev.index !== "number") return null;
  let open = claudeDrafts.get(owner);
  if (ev.type === "content_block_start") {
    const block = ev.content_block;
    if (block?.type !== "tool_use" || typeof block.id !== "string" || typeof block.name !== "string") return null;
    if (!open) claudeDrafts.set(owner, (open = new Map()));
    const draft: ClaudeDraft = { id: block.id, name: block.name, bytes: 0, head: "" };
    open.set(ev.index, draft);
    return claudeReport(draft);
  }
  const draft = open?.get(ev.index);
  if (!draft) return null;
  if (ev.type === "content_block_stop") {
    open!.delete(ev.index);
    return null;
  }
  const json = ev.type === "content_block_delta" && ev.delta?.type === "input_json_delta" ? ev.delta.partial_json : undefined;
  if (typeof json !== "string" || !json) return null;
  draft.bytes += Buffer.byteLength(json);
  if (draft.file === undefined && draft.head.length < HEAD_MAX) {
    draft.head += json;
    const match = PATH_FIELD.exec(draft.head);
    if (match) {
      try {
        draft.file = progressFile(JSON.parse(`"${match[1]}"`)) ?? "";
      } catch {
        draft.file = "";
      }
      draft.head = "";
    }
  }
  return claudeReport(draft);
}

/** Codex's item/fileChange/patchUpdated: the patch so far, file by file. Every file new is a write; anything else an edit. */
export function codexPatchProgress(params: unknown): TurnProgressFields | null {
  const p = params as { itemId?: unknown; changes?: unknown } | null;
  const changes = Array.isArray(p?.changes) ? (p.changes as Array<{ path?: unknown; kind?: { type?: unknown }; diff?: unknown }>) : [];
  if (!changes.length) return null;
  const bytes = changes.reduce((sum, change) => sum + (typeof change?.diff === "string" ? Buffer.byteLength(change.diff) : 0), 0);
  const activity = changes.every((change) => change?.kind?.type === "add") ? "write" : "edit";
  const file = progressFile(changes[0]?.path);
  return report(activity, "edit", { bytes, ...(file ? { file } : {}), ...(typeof p?.itemId === "string" ? { itemId: p.itemId } : {}) });
}

const ACP_KINDS: Record<string, TurnProgressActivity> = {
  edit: "edit",
  delete: "edit",
  move: "edit",
  execute: "command",
  search: "search",
  read: "read",
  fetch: "fetch",
  other: "tool",
};

/** An ACP tool_call or tool_call_update still running. A call with a diff reports the new text's size; a diff with no
 * old text is a new file. An update that names no kind and carries no diff says nothing new. */
export function acpToolProgress(update: unknown): TurnProgressFields | null {
  const u = update as { sessionUpdate?: unknown; toolCallId?: unknown; kind?: unknown; title?: unknown; status?: unknown; content?: unknown; locations?: unknown } | null;
  if (u?.sessionUpdate !== "tool_call" && u?.sessionUpdate !== "tool_call_update") return null;
  if (u.status === "completed" || u.status === "failed") return null;
  const diffs = (Array.isArray(u.content) ? u.content : []).filter(
    (part): part is { path?: unknown; oldText?: unknown; newText?: unknown } => part?.type === "diff",
  );
  const kind = typeof u.kind === "string" ? ACP_KINDS[u.kind] : undefined;
  if (!kind && !diffs.length) return null;
  const activity: TurnProgressActivity = diffs.length
    ? diffs.every((diff) => typeof diff.oldText !== "string" || !diff.oldText) ? "write" : "edit"
    : kind!;
  const locations = Array.isArray(u.locations) ? (u.locations as Array<{ path?: unknown }>) : [];
  const file = progressFile(diffs[0]?.path ?? locations[0]?.path);
  const bytes = diffs.reduce((sum, diff) => sum + (typeof diff.newText === "string" ? Buffer.byteLength(diff.newText) : 0), 0);
  return report(activity, typeof u.title === "string" ? u.title : "tool", {
    ...(diffs.length ? { bytes } : {}),
    ...(file ? { file } : {}),
    ...(typeof u.toolCallId === "string" && u.toolCallId ? { itemId: u.toolCallId } : {}),
  });
}
