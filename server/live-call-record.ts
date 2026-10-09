// How a Live call is recorded in its chat (docs/superpowers/specs/
// 2026-09-25-live-call-bar-design.md, "The call id and the call row"):
// every request spoken on a call carries the call's id, and a call that
// went live leaves one "call" row when it ends. Neither ever holds anything
// said on the call beyond the requests the bot already received.
//
// server/steer-queue.ts imports this module at runtime, so keep it light: no
// store, index or title machinery. Types come in as `import type`, the one
// runtime import is the pure shared/live-call.ts (it imports nothing), and
// everything that touches the store or makes a title (the excerpt, the
// one-shot, the scrub) arrives through injected deps.
import { liveCallRowText } from "../shared/live-call.ts";
import type { LiveCallRecord } from "../shared/wire.ts";
import type { Message } from "./store.ts";

/** The Live-call fields a user line is stored with: `via: "call"` when it
 * was spoken on a call, and that call's id only alongside it. A typed, API
 * or relayed line never carries a call id, even one handed in by mistake. */
export function spokenLineFields(
  via: "api" | "call" | undefined,
  callId: string | undefined,
): { via?: "call"; callId?: string } {
  if (via !== "call") return {};
  return callId ? { via, callId } : { via };
}

/** What writing a call's row needs from the store: narrow, so tests fake it. */
export interface LiveCallRecordDeps {
  /** Whether the call's chat still exists. A call that ended because its
   * chat or its bot was deleted leaves no row. */
  chatExists(botId: string, threadId: string): boolean;
  appendMessage(threadId: string, message: Omit<Message, "id" | "at">): Message;
}

/** The one row a finished call that went live leaves in its chat, appended
 * at the active leaf: its record, and a line for clients that do not know
 * kind "call". Null, with nothing written, when the chat is gone. */
export function recordLiveCall(
  deps: LiveCallRecordDeps,
  input: { threadId: string; botName: string; record: LiveCallRecord },
): Message | null {
  const { threadId, botName, record } = input;
  if (!deps.chatExists(record.botId, threadId)) return null;
  return deps.appendMessage(threadId, {
    role: "bot",
    kind: "call",
    text: liveCallRowText(botName, record.seconds),
    call: record,
  });
}

/** What titling a call's row needs: narrow, so tests fake it. */
export interface LiveCallTitleDeps {
  messagesFor(threadId: string): readonly Message[];
  patchMessage(threadId: string, messageId: string, patch: Partial<Message>): Message | null;
  /** The title one-shot's input for `callId`: the requests spoken on it among
   * `messages`, scrubbed and capped (thread-title's callTitleExcerpt). Empty
   * when nothing was asked. */
  excerpt(messages: readonly Message[], callId: string): string;
  /** A one-shot title from the bot's own engine for `excerpt`, or null
   * (without calling anything) when generated titles are off or the engine
   * cannot make one: the thread-title gates. Resolves null on failure. */
  title(botId: string, threadId: string, excerpt: string): Promise<string | null> | null;
  /** Scrubs secrets from a title (redactSecretsInText). */
  scrub(text: string): string;
}

/** Names a call's row from what was asked on it. The row is already
 * written; a title, when one comes, patches it (a `message.patch`). A
 * harness that is shutting down starts no one-shot, and neither does a call
 * where nothing was asked. Never throws: the row stands without a title.
 * `store.patchMessage` does not scrub what the bot's engine wrote, so the
 * title is scrubbed here as well as when a row is appended. */
export async function titleLiveCall(deps: LiveCallTitleDeps, input: { threadId: string; row: Message }): Promise<void> {
  const record = input.row.call;
  if (!record || record.endReason === "shutdown") return;
  try {
    const excerpt = deps.excerpt(deps.messagesFor(input.threadId), record.callId);
    if (!excerpt) return;
    const title = await deps.title(record.botId, input.threadId, excerpt);
    if (!title) return;
    const current = deps.messagesFor(input.threadId).find((message) => message.id === input.row.id);
    if (!current?.call) return;
    deps.patchMessage(input.threadId, input.row.id, { call: { ...current.call, title: deps.scrub(title) } });
  } catch {
    // a title is a nicety: the row stands without one
  }
}
