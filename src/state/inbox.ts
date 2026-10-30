// On a Team Cloud: the person's inbox as its panel and its card in the chat show it. One copy of the server's list, read
// again whenever their inbox's task says what it lists changed, and the panel's own place (open, tab, the line read).
// Null anywhere but a team's Cloud, where no task is anyone's inbox.
import { useEffect, useSyncExternalStore } from "react";
import type { InboxRow, InboxTab, InboxView } from "../../shared/inbox";
import { api } from "./api";

type InboxTaskLike = { threadId: string; inbox?: true; openAsks?: number; inboxChangedAt?: number };

/** What the list depends on, from the person's own inbox task; null when they have none. */
export function inboxVersion(bots: ReadonlyArray<{ id: string; tasks?: readonly InboxTaskLike[] }>): string | null {
  for (const bot of bots) {
    const task = bot.tasks?.find((one) => one.inbox);
    if (task) return `${bot.id}:${task.threadId}:${task.inboxChangedAt ?? 0}:${task.openAsks ?? 0}`;
  }
  return null;
}

function store<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: T) { value = next; for (const listener of listeners) listener(); },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

const list = store<InboxView | null>(null);
export const currentInbox = list.get;
export const useInboxView = (): InboxView | null => useSyncExternalStore(list.subscribe, list.get, list.get);
/** Tests and previews show a list of their own. */
export const setInboxView = list.set;

let reading: Promise<void> | null = null;
let readAgain = false;
/** Reads the list now, or once more after the read on its way, so the newest answer always lands last. */
export function refreshInbox(): Promise<void> {
  if (reading) { readAgain = true; return reading; }
  reading = (async () => {
    try {
      do {
        readAgain = false;
        const view = await api<InboxView>("/api/inbox", { background: true }).catch(() => null);
        if (view && Array.isArray(view.rows)) list.set(view);
      } while (readAgain);
    } finally {
      reading = null;
    }
  })();
  return reading;
}

/** Keeps the list in step with the person's inbox task; nothing off a team. */
export function useInboxLoader(version: string | null): void {
  useEffect(() => {
    if (version === null) { list.set(null); return; }
    void refreshInbox();
  }, [version]);
}

const patchRow = (id: string, patch: Partial<InboxRow>) => {
  const view = list.get();
  if (view) list.set({ ...view, rows: view.rows.map((row) => (row.id === id ? { ...row, ...patch } : row)) });
};

async function mark(id: string, what: "read" | "done"): Promise<void> {
  const view = await api<InboxView>(`/api/inbox/${id}/${what}`, { method: "POST", background: true }).catch(() => null);
  if (view && Array.isArray(view.rows)) list.set(view);
  else void refreshInbox();
}

/** The person read a line: it is no longer bold. */
export function readInboxRow(row: Pick<InboxRow, "id" | "unread">): void {
  if (!row.unread) return;
  patchRow(row.id, { unread: false });
  void mark(row.id, "read");
}

/** The person is done with a line of news: it moves to Done. */
export function doneInboxRow(row: Pick<InboxRow, "id">): void {
  patchRow(row.id, { tab: "done", unread: false });
  void mark(row.id, "done");
}

/** A reply to a line of news that waits on one: it goes back where the line came from, as a Reply in the chat does. */
export async function replyToInboxRow(view: Pick<InboxView, "botId" | "threadId">, row: Pick<InboxRow, "id">, text: string): Promise<void> {
  await api(`/api/bots/${view.botId}/messages`, { method: "POST", body: JSON.stringify({ text, threadId: view.threadId, replyToId: row.id, sendId: crypto.randomUUID() }) });
  void refreshInbox();
}

export interface InboxPanelState { open: boolean; tab: InboxTab; reading: string | null }
const panel = store<InboxPanelState>({ open: false, tab: "needs-you", reading: null });
export const useInboxPanel = (): InboxPanelState => useSyncExternalStore(panel.subscribe, panel.get, panel.get);
export const currentInboxPanel = panel.get;

/** Opens the inbox in the right panel: on a tab, or straight on one line. */
export function openInbox(at: { tab?: InboxTab; reading?: string } = {}): void {
  panel.set({ open: true, tab: at.tab ?? panel.get().tab, reading: at.reading ?? null });
  void refreshInbox();
}
export const closeInbox = (): void => panel.set({ ...panel.get(), open: false, reading: null });
export const showInboxTab = (tab: InboxTab): void => panel.set({ ...panel.get(), tab, reading: null });
export const readInboxLine = (id: string | null): void => panel.set({ ...panel.get(), reading: id });
