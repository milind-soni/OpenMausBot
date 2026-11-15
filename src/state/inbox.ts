// The person's inbox as the sidebar's row, its panel and a team's card in the chat show it. One copy of the server's list,
// read again whenever what it depends on changes, and the panel's own place (open, the line read). A server older than this
// page has none off a team: it answers 404, and the sidebar falls back to what it showed before.
import { useEffect, useSyncExternalStore } from "react";
import type { InboxRow, InboxView } from "../../shared/inbox";
import { api } from "./api";
import { randomUuid } from "../lib/random-uuid";

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
const hasList = () => list.get() !== null;
export const useInboxReady = (): boolean => useSyncExternalStore(list.subscribe, hasList, hasList);

export type InboxSupport = "unknown" | "yes" | "no";
const support = store<InboxSupport>("unknown");
export const useInboxSupport = (): InboxSupport => useSyncExternalStore(support.subscribe, support.get, support.get);
/** Tests and previews say what the server does. */
export const setInboxSupport = support.set;
/** Tests and previews show a list of their own. */
export const setInboxView = (view: InboxView | null): void => { list.set(view); support.set(view ? "yes" : "unknown"); };

// Every read and every change here takes the next number; a list from the server lands only if nothing later was shown,
// so an older answer never moves a row back.
let sent = 0, shown = 0;
const show = (seq: number, view: InboxView) => {
  if (seq < shown) return;
  shown = seq;
  list.set(view);
  support.set("yes");
};

let reading: Promise<void> | null = null;
let readAgain = false;
/** Reads the list now, or once more after the read on its way, so the newest answer always lands last. */
export function refreshInbox(): Promise<void> {
  if (reading) { readAgain = true; return reading; }
  reading = (async () => {
    try {
      do {
        readAgain = false;
        const seq = ++sent;
        const view = await api<InboxView>("/api/inbox", { background: true }).catch((error: unknown) => {
          if ((error as { status?: number }).status === 404) { list.set(null); support.set("no"); }
          return null;
        });
        if (view && Array.isArray(view.rows)) show(seq, view);
      } while (readAgain);
    } finally {
      reading = null;
    }
  })();
  return reading;
}

/** Keeps the list in step with what it depends on, and catches up when the window comes back. A server without an inbox is
 * not asked again. */
export function useInboxLoader(version: string): void {
  useEffect(() => {
    if (support.get() !== "no") void refreshInbox();
  }, [version]);
  useEffect(() => {
    const again = () => { if (support.get() !== "no") void refreshInbox(); };
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
  }, []);
}

const patchRow = (id: string, patch: Partial<InboxRow>) => {
  shown = ++sent;
  const view = list.get();
  if (view) list.set({ ...view, rows: view.rows.map((row) => (row.id === id ? { ...row, ...patch } : row)) });
};

/** Tells the server; if it can't be told, the row goes back to how it was (`undo`) and the list is read again. */
async function mark(id: string, what: "read" | "done", undo: Partial<InboxRow>): Promise<void> {
  const seq = ++sent;
  const view = await api<InboxView>(`/api/inbox/${id}/${what}`, { method: "POST", background: true }).catch(() => null);
  if (view && Array.isArray(view.rows)) return show(seq, view);
  patchRow(id, undo);
  void refreshInbox();
}

/** The person read a line: it is no longer bold. */
export function readInboxRow(row: Pick<InboxRow, "id" | "unread">): void {
  if (!row.unread) return;
  patchRow(row.id, { unread: false });
  void mark(row.id, "read", { unread: true });
}

const marking = store(false);
export const useInboxMarkingAll = (): boolean => useSyncExternalStore(marking.subscribe, marking.get, marking.get);

/** The person read every line: none is bold, and no ask is answered or moves tab. */
export function markAllInboxRead(): void {
  if (marking.get()) return;
  const view = list.get();
  if (view) { shown = ++sent; list.set({ ...view, rows: view.rows.map((row) => (row.unread ? { ...row, unread: false } : row)) }); }
  const seq = ++sent;
  marking.set(true);
  void api<InboxView>("/api/inbox/read-all", { method: "POST", background: true }).catch(() => null).then((next) => {
    marking.set(false);
    if (next && Array.isArray(next.rows)) return show(seq, next);
    void refreshInbox();
  });
}

/** An ask the person just answered here: it leaves the list at once, before the server's next read says so. */
export const settleInboxRow = (row: Pick<InboxRow, "id">): void => patchRow(row.id, { tab: "done", unread: false });

/** The person is done with a line of news: it moves to Done. */
export function doneInboxRow(row: Pick<InboxRow, "id">): void {
  const before = list.get()?.rows.find((one) => one.id === row.id);
  patchRow(row.id, { tab: "done", unread: false });
  void mark(row.id, "done", before ? { tab: before.tab, unread: before.unread } : {});
}

/** A reply to a line of news that waits on one: it goes back where the line came from, as a Reply in the chat does. */
export async function replyToInboxRow(view: Pick<InboxView, "botId" | "threadId">, row: Pick<InboxRow, "id" | "origin">, text: string): Promise<void> {
  const origin = view.threadId ? null : row.origin;
  const path = origin?.groupId ? `/api/groups/${origin.groupId}/messages` : `/api/bots/${origin?.botId ?? view.botId}/messages`;
  await api(path, { method: "POST", body: JSON.stringify({ text, threadId: origin?.threadId ?? view.threadId, replyToId: row.id, sendId: randomUuid() }) });
  void refreshInbox();
}

export interface InboxPanelState { open: boolean; reading: string | null; wide?: boolean }
const panel = store<InboxPanelState>({ open: false, reading: null });
export const useInboxPanel = (): InboxPanelState => useSyncExternalStore(panel.subscribe, panel.get, panel.get);
export const currentInboxPanel = panel.get;

/** Opens the inbox in the right panel: its list, or straight on one line. */
export function openInbox(at: { reading?: string } = {}): void {
  panel.set({ ...panel.get(), open: true, reading: at.reading ?? null });
  void refreshInbox();
}
export const closeInbox = (): void => panel.set({ ...panel.get(), open: false, reading: null });
export const readInboxLine = (id: string | null): void => panel.set({ ...panel.get(), reading: id });
/** The panel at its usual width or wider, for a long message. */
export const widenInbox = (wide: boolean): void => panel.set({ ...panel.get(), wide });
