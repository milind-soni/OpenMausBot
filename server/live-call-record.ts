// Never holds anything said on a call beyond the requests the bot already received.
// steer-queue.ts imports this at runtime, so it stays light: store and title machinery arrive as injected deps.
import { liveCallRowText } from "../shared/live-call.ts";
import type { LiveCallRecord } from "../shared/wire.ts";
import type { Message } from "./store.ts";

export function spokenLineFields(
  via: "api" | "call" | undefined,
  callId: string | undefined,
): { via?: "call"; callId?: string } {
  if (via !== "call") return {};
  return callId ? { via, callId } : { via };
}

export interface LiveCallRecordDeps {
  chatExists(botId: string, threadId: string): boolean;
  appendMessage(threadId: string, message: Omit<Message, "id" | "at">): Message;
}

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

export interface LiveCallTitleDeps {
  messagesFor(threadId: string): readonly Message[];
  patchMessage(threadId: string, messageId: string, patch: Partial<Message>): Message | null;
  excerpt(messages: readonly Message[], callId: string): string;
  title(botId: string, threadId: string, excerpt: string): Promise<string | null> | null;
  scrub(text: string): string;
}

/** `store.patchMessage` does not scrub what the engine wrote, so the title is scrubbed here too. */
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
  }
}
