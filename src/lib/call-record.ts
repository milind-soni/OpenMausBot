import type { Message } from "@/state/store";
import { isToolStep } from "@/lib/activity-runs";

export type CallRecordLine =
  | { kind: "step"; id: string; tool: NonNullable<Message["tool"]> }
  | { kind: "approval"; id: string; card: NonNullable<Message["card"]> };

export function callRecordLines(transcript: readonly Message[], callId: string): CallRecordLine[] {
  const requests = callRequests(transcript, callId);
  if (requests.size === 0) return [];
  const lines: CallRecordLine[] = [];
  for (const message of transcript) {
    if (!message.requestMessageId || !requests.has(message.requestMessageId)) continue;
    const line = callRecordLine(message);
    if (line) lines.push(line);
  }
  return lines;
}

export type CallConversationEntry =
  | { kind: "said"; id: string; message: Message }
  | { kind: "answer"; id: string; message: Message }
  | CallRecordLine;

export function callConversation(transcript: readonly Message[], callId: string): CallConversationEntry[] {
  const requests = callRequests(transcript, callId);
  if (requests.size === 0) return [];
  const entries: CallConversationEntry[] = [];
  for (const message of transcript) {
    if (requests.has(message.id)) {
      if (message.text?.trim()) entries.push({ kind: "said", id: message.id, message });
      continue;
    }
    if (!message.requestMessageId || !requests.has(message.requestMessageId)) continue;
    if (message.role === "bot" && message.kind === "text") {
      if (message.text?.trim()) entries.push({ kind: "answer", id: message.id, message });
      continue;
    }
    const line = callRecordLine(message);
    if (line) entries.push(line);
  }
  return entries;
}

function callRequests(transcript: readonly Message[], callId: string): Set<string> {
  const requests = new Set<string>();
  for (const message of transcript) {
    if (message.role === "user" && message.callId === callId) requests.add(message.id);
  }
  return requests;
}

function callRecordLine(message: Message): CallRecordLine | null {
  const { card } = message;
  if (isToolStep(message)) {
    // Harness chips have no provider item id; listing them would show an auto-approved action twice.
    return message.tool.itemId !== undefined ? { kind: "step", id: message.id, tool: message.tool } : null;
  }
  if (message.kind === "options" && card?.requestId && card.tool && !card.questionRequest) {
    return { kind: "approval", id: message.id, card };
  }
  return null;
}

export function callRecordIsPartial(transcript: readonly Message[], call: { startedAt: number }, hasMore: boolean): boolean {
  const oldest = transcript[0];
  return hasMore && oldest !== undefined && oldest.at > call.startedAt;
}
