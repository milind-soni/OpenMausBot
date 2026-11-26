// The page the person has open in the chat's page pane. It travels with what they type, so the bot knows which page
// "this" means while the page sits beside the conversation.
export interface OpenPage {
  appId: string;
  rev: number;
}

const open = new Map<string, OpenPage>();
const listeners = new Set<() => void>();

/** One page at a time per chat: opening another tells the first to close. */
export function openPage(threadId: string, page: OpenPage): void {
  open.set(threadId, page);
  for (const listener of listeners) listener();
}

export function onPageOpened(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Only the page that opened clears itself, so closing an old pane never drops a newer one. */
export function closePage(threadId: string, appId: string): void {
  if (open.get(threadId)?.appId === appId) open.delete(threadId);
}

export function openPageFor(threadId: string): OpenPage | undefined {
  return open.get(threadId);
}
