// Which conversation was open on this device last time. The pick is
// conversation-level - a bot or a room id, never a thread id: the server
// already persists each record's current thread, so restoring the
// conversation reopens that thread by itself.
export const LAST_CONVERSATION_KEY = "openmausbot.lastConversation.v1";

/** The conversation open here last, or null when storage holds nothing
 * usable - absent, blank, or a record a read failure cannot parse. */
export function readLastConversation(): string | null {
  try {
    return globalThis.localStorage?.getItem(LAST_CONVERSATION_KEY)?.trim() || null;
  } catch {
    return null;
  }
}

/** Remember the open conversation for the next launch. */
export function rememberConversation(id: string): void {
  try {
    globalThis.localStorage?.setItem(LAST_CONVERSATION_KEY, id);
  } catch {
    // Private windows may refuse storage; the choice still holds this session.
  }
}
