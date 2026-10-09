// Per-turn ask gate, adapted from the approval lifecycle in #780.
// Register before publishing: a harness listener may answer synchronously.
import { newId, type RequestOutcome } from "../contracts.ts";
import type { AskQuestion } from "../../shared/ask-question.ts";
import { isOutboundTool } from "../../shared/outbound.ts";

interface Ask { id: string; tool: string; summary: string; sessionKey: string | null }

const SESSION_KEY_MAX = 8_000;
const HOST_CONTROL = /^(?:computer|browser)_/;

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, stableJson(record[key])]));
  }
  return value;
}

/** The exact operation "Always allow this session" can remember. Null for a
 * question, a send, computer or browser control, a call with no mounted
 * server behind it, or a payload too large to keep. `server` names the exact
 * mounted server and the tool it runs (ChatToolCallView.grant), so a tool
 * with the same displayed name on another server, or on the same server name
 * after its command, address or settings change, never matches an old grant,
 * and a grant follows its server when a name collision renames the tool.
 * Two calls with the same fields in a different order share a key. */
export function chatSessionOperationKey(name: string, args: unknown, server: string | undefined): string | null {
  if (!name || name === "ask_user" || HOST_CONTROL.test(name) || isOutboundTool(name)) return null;
  if (!server) return null;
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  let encoded: string;
  try {
    encoded = JSON.stringify(stableJson(args));
  } catch {
    return null;
  }
  if (!encoded || encoded.length > SESSION_KEY_MAX) return null;
  return `${server}\n${encoded}`;
}

/** Threads and grants kept at most. The oldest goes first. */
export const SESSION_THREADS_MAX = 256;
export const SESSION_KEYS_PER_THREAD_MAX = 256;

/** In-memory exact operations for one runtime. Nothing is written to disk.
 * A deleted thread drops its grants (forget), disposing the runtime drops all
 * of them (clear), and both maps are capped so a long run can't grow them. */
export function createChatSessionMemory() {
  const threads = new Map<string, Set<string>>();
  return {
    has(threadId: string, key: string) {
      return threads.get(threadId)?.has(key) === true;
    },
    remember(threadId: string, key: string) {
      const keys = threads.get(threadId) ?? new Set<string>();
      threads.delete(threadId);
      keys.delete(key);
      keys.add(key);
      if (keys.size > SESSION_KEYS_PER_THREAD_MAX) keys.delete(keys.values().next().value!);
      threads.set(threadId, keys);
      if (threads.size > SESSION_THREADS_MAX) threads.delete(threads.keys().next().value!);
    },
    forget(threadId: string) {
      threads.delete(threadId);
    },
    clear() {
      threads.clear();
    },
    get threadCount() {
      return threads.size;
    },
  };
}
type Source = "user" | "timeout" | "system";

interface Card {
  kind: "permission" | "question";
  ask: Ask;
  /** Exactly-once: a second finish is a no-op because the card left the map. */
  finish(source: Source, decision?: { allowed?: boolean; message?: string }): void;
}

export function createChatToolApproval(options: {
  signal: AbortSignal;
  open(ask: Ask): void;
  resolved(ask: Ask, allowed: boolean, source: Source): void;
  openQuestion(ask: Ask, questions: AskQuestion[]): void;
  resolvedQuestion(ask: Ask, answered: boolean, source: Source): void;
  /** Called only when the person picks Always allow this session. */
  remember?(sessionKey: string): void;
  timeoutMs?: number;
}) {
  const pending = new Map<string, Card>();
  let closed = false;
  return {
    ask(tool: string, summary: string, sessionKey: string | null = null): Promise<boolean> {
      if (closed || options.signal.aborted) return Promise.resolve(false);
      const ask = { id: newId(), tool, summary, sessionKey };
      return new Promise((resolve) => {
        let timer: ReturnType<typeof setTimeout>;
        const card: Card = {
          kind: "permission",
          ask,
          finish(source, decision) {
            if (!pending.delete(ask.id)) return;
            clearTimeout(timer);
            options.signal.removeEventListener("abort", abort);
            const allowed = decision?.allowed === true;
            options.resolved(ask, allowed, source);
            resolve(allowed);
          },
        };
        const abort = () => card.finish("system");
        timer = setTimeout(() => card.finish("timeout"), options.timeoutMs ?? 15 * 60_000);
        timer.unref?.();
        pending.set(ask.id, card);
        options.signal.addEventListener("abort", abort, { once: true });
        options.open(ask);
      });
    },
    question(tool: string, summary: string, questions: AskQuestion[]): Promise<string | null> {
      if (closed || options.signal.aborted) return Promise.resolve(null);
      const ask = { id: newId(), tool, summary, sessionKey: null };
      return new Promise((resolve) => {
        let timer: ReturnType<typeof setTimeout>;
        const card: Card = {
          kind: "question",
          ask,
          finish(source, decision) {
            if (!pending.delete(ask.id)) return;
            clearTimeout(timer);
            options.signal.removeEventListener("abort", abort);
            // Only the person's reply resolves a question; a timeout or
            // abort resolves null so no system note can occupy the answer
            // slot the model reads as the person's words.
            const reply = typeof decision?.message === "string" && decision.message.length > 0 ? decision.message : null;
            options.resolvedQuestion(ask, reply !== null, source);
            resolve(reply);
          },
        };
        const abort = () => card.finish("system");
        timer = setTimeout(() => card.finish("timeout"), options.timeoutMs ?? 15 * 60_000);
        timer.unref?.();
        pending.set(ask.id, card);
        options.signal.addEventListener("abort", abort, { once: true });
        options.openQuestion(ask, questions);
      });
    },
    answer(id: string, behavior: "allow" | "deny" | "answer", message?: string, always?: boolean): RequestOutcome {
      const card = pending.get(id);
      if (!card || options.signal.aborted) return "unavailable";
      if (behavior === "deny") {
        card.finish("user");
        return "rejected";
      }
      if (card.kind === "permission") {
        // An answer is not a permission: only allow or deny settles it.
        if (behavior !== "allow") return "unavailable";
        if (always === true && card.ask.sessionKey) options.remember?.(card.ask.sessionKey);
        card.finish("user", { allowed: true });
        return "allowed-once";
      }
      // And an allow is not an answer: a question settles only on a real
      // reply, never a blank the model would have to interpret.
      if (behavior === "answer" && typeof message === "string" && message.trim()) {
        card.finish("user", { message });
        return "answered";
      }
      return "unavailable";
    },
    close() {
      closed = true;
      for (const card of pending.values()) card.finish("system");
    },
  };
}
