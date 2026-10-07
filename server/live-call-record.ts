// How a Live call is recorded in its chat (docs/superpowers/specs/
// 2026-09-25-live-call-bar-design.md, "The call id and the call row"):
// every request spoken on a call carries the call's id, and a call that
// went live leaves one "call" row when it ends. Neither ever holds anything
// said on the call beyond the requests the bot already received.
//
// server/steer-queue.ts imports this module at runtime, so keep it light: no
// store, index or title machinery. Types come in as `import type`, the one
// runtime import is the pure shared/live-call.ts (it imports nothing), and
// everything that touches the store arrives through injected deps.
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
