export const LAST_CONVERSATION_KEY = "openmausbot.lastConversation.v1";

export function readLastConversation(): string | null {
  try {
    return globalThis.localStorage?.getItem(LAST_CONVERSATION_KEY)?.trim() || null;
  } catch {
    return null;
  }
}

export function rememberConversation(id: string): void {
  try {
    globalThis.localStorage?.setItem(LAST_CONVERSATION_KEY, id);
  } catch {
  }
}
