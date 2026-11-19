import { failedTurnCause } from "./failed-turn.ts";

export function inChatHistory(message: { kind: string; comm?: unknown; relay?: unknown; roomRequest?: unknown; threadRef?: unknown; tool?: { name: string } }) {
  return message.kind !== "activity" || Boolean(message.comm || message.relay || message.roomRequest || message.threadRef)
    || (message.tool !== undefined && failedTurnCause(message.tool.name) !== null);
}
