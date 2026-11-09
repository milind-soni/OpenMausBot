export const CHAT_WIDTH_IDS = ["standard", "wide", "full"] as const;
export type ChatWidthId = (typeof CHAT_WIDTH_IDS)[number];

export const DEFAULT_CHAT_WIDTH: ChatWidthId = "standard";

export const CHAT_WIDTH_KEY = "omb-chat-width";

function isChatWidthId(value: unknown): value is ChatWidthId {
  return (CHAT_WIDTH_IDS as readonly unknown[]).includes(value);
}

function getStore(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function readChatWidth(): ChatWidthId {
  try {
    const stored = getStore()?.getItem(CHAT_WIDTH_KEY);
    return isChatWidthId(stored) ? stored : DEFAULT_CHAT_WIDTH;
  } catch {
    return DEFAULT_CHAT_WIDTH;
  }
}

export function applyChatWidth(id: ChatWidthId): void {
  if (id === DEFAULT_CHAT_WIDTH) delete document.documentElement.dataset.chatWidth;
  else document.documentElement.dataset.chatWidth = id;
  try {
    getStore()?.setItem(CHAT_WIDTH_KEY, id);
  } catch {
    // Storage can be full or blocked in private mode; the width still applies this session.
  }
}
