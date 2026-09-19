// Stream-json frame → harness event mapping for the Claude driver: one CLI
// stdout line in, RuntimeEvents out. Split out of drivers/claude.ts.
import type { RuntimeEvent } from "../../contracts.ts";
import type { DriverEventBase } from "../driver-runtime.ts";
import { appendNative } from "../native.ts";
import { commandSummary, toolDetailPreview } from "../../tool-summary.ts";
import { claudeAuthFailure } from "./env-auth.ts";
import { firstText } from "./decode.ts";
import type { Session } from "./session.ts";

/** Everything the frame mapper needs from the turn that owns the child. */
export interface ClaudeStreamDeps {
  session: Session;
  threadId: string;
  settle: (
    ok: boolean,
    stopReason: string | null,
    cost?: number | null,
    usage?: { input: number; output: number; cachedInput?: number },
  ) => void;
  emit: (event: RuntimeEvent) => void;
  base: (threadId: string, turnId: string) => DriverEventBase;
  currentTurnId: () => string;
  /** True while the session being announced was rebuilt from recoveryText
   * (a rejected resume), so session.started can flag it as rebuilt. */
  isRebuiltSession?: () => boolean;
}

export function handleLine(line: string, deps: ClaudeStreamDeps): void {
  const { session, threadId, settle, emit, base, currentTurnId } = deps;
  if (session.closing) return;
  let o: any;
  try {
    o = JSON.parse(line);
  } catch {
    return;
  }
  appendNative(threadId, { dir: "in", source: "claude.sdk.message", msg: o });
  switch (o.type) {
    case "system":
      if (o.subtype === "init") {
        session.sawInit = true;
        session.nativePermissionMode = typeof o.permissionMode === "string" ? o.permissionMode : null;
        if (typeof o.session_id === "string") session.sessionId = o.session_id;
        emit({ ...base(threadId, currentTurnId()), type: "session.started", sessionId: o.session_id, model: o.model, ...(deps.isRebuiltSession?.() ? { rebuilt: true } : {}) });
      } else if (o.subtype === "thinking_tokens") {
        emit({ ...base(threadId, currentTurnId()), type: "item.updated", itemType: "reasoning", tokens: o.estimated_tokens });
      }
      break;
    case "stream_event": {
      // subagent narration is dropped — N parallel Tasks would
      // interleave their prose into one bubble (upstream-verified bug)
      if (o.parent_tool_use_id) break;
      const ev = o.event ?? {};
      if (ev.type !== "content_block_delta") break;
      const d = ev.delta ?? {};
      if (d.type === "text_delta" && typeof d.text === "string" && d.text) {
        if (session.turn) session.turn.sawStreamDelta = true;
        emit({ ...base(threadId, currentTurnId()), type: "content.delta", streamKind: "assistant_text", delta: d.text });
      } else if (d.type === "thinking_delta" && typeof d.thinking === "string" && d.thinking) {
        emit({ ...base(threadId, currentTurnId()), type: "content.delta", streamKind: "reasoning_text", delta: d.thinking });
      }
      break;
    }
    case "assistant": {
      const msg = o.message ?? {};
      const text = firstText(msg.content);
      // An unauthenticated turn comes back as an api-error frame whose
      // only content is the CLI's own "run /login" instruction — a
      // command this app has no terminal to run, so relaying it as a
      // reply strands the user. Every other engine reports this as a
      // setup error; that is what routes them to the sign-in card.
      if (claudeAuthFailure(o, text)) {
        if (session.turn) session.turn.authFailed = true;
        emit({ ...base(threadId, currentTurnId()), type: "runtime.error", message: text, setup: true });
        break;
      }
      if (text.trim()) {
        // The CLI's own report of any other API error is still shown,
        // but marked: the model never produced it.
        const synthetic = o.is_api_error_message === true || typeof o.error === "string" ? { synthetic: true } : {};
        // fallback delta for CLIs/paths that never streamed the block
        if (!session.turn?.sawStreamDelta) {
          emit({ ...base(threadId, currentTurnId()), ...synthetic, type: "content.delta", streamKind: "assistant_text", delta: text });
        }
        if (session.turn) session.turn.sawStreamDelta = false;
        emit({ ...base(threadId, currentTurnId()), ...synthetic, type: "item.completed", itemType: "assistant_text", text });
      }
      for (const b of Array.isArray(msg.content) ? msg.content : []) {
        if (b.type === "tool_use") {
          emit({
            ...base(threadId, currentTurnId()),
            type: "item.started",
            itemType: "tool",
            itemId: b.id,
            title: b.name,
            summary: commandSummary(b.input),
            input: toolDetailPreview(b.input),
          });
        }
      }
      if (msg.usage) {
        emit({
          ...base(threadId, currentTurnId()),
          type: "thread.token-usage.updated",
          input: (msg.usage.input_tokens || 0) + (msg.usage.cache_read_input_tokens || 0),
          output: msg.usage.output_tokens || 0,
          ...(typeof msg.usage.cache_read_input_tokens === "number"
            ? { cachedInput: msg.usage.cache_read_input_tokens }
            : {}),
          // one assistant message = one model call, and its prompt is
          // everything in the window: fresh text, cache reads and writes
          contextTokens: (msg.usage.input_tokens || 0) + (msg.usage.cache_read_input_tokens || 0) + (msg.usage.cache_creation_input_tokens || 0),
        });
      }
      break;
    }
    case "user":
      for (const b of Array.isArray(o.message?.content) ? o.message.content : []) {
        if (b.type === "tool_result") {
          emit({ ...base(threadId, currentTurnId()), type: "item.completed", itemType: "tool", itemId: b.tool_use_id, ok: !b.is_error, output: toolDetailPreview(b.content) });
        }
      }
      break;
    case "result":
      // A synthetic background completion is not the result of the
      // submitted user turn. Settling it would revoke browser access
      // and deny approvals while that user turn is still running.
      if (o.origin?.kind === "task-notification") break;
      // result.usage is this invocation's total — one process per turn,
      // so it is the turn's figure. cache reads count as input: they
      // are billed (at the cache rate) and they fill the window — but
      // they are reported separately too, so the UI can show how much
      // of the figure was context re-read rather than new text.
      settle(
        o.is_error !== true,
        session.turn?.authFailed ? "auth_required" : o.stop_reason ?? o.terminal_reason ?? null,
        o.total_cost_usd ?? null,
        o.usage
          ? {
              input: (o.usage.input_tokens || 0) + (o.usage.cache_read_input_tokens || 0) + (o.usage.cache_creation_input_tokens || 0),
              output: o.usage.output_tokens || 0,
              ...(typeof o.usage.cache_read_input_tokens === "number"
                ? { cachedInput: o.usage.cache_read_input_tokens }
                : {}),
            }
          : undefined,
      );
      break;
  }
}
