export function inChatHistory(message: { kind: string; comm?: unknown; relay?: unknown; roomRequest?: unknown; threadRef?: unknown }) {
  return message.kind !== "activity" || Boolean(message.comm || message.relay || message.roomRequest || message.threadRef);
}
