// Per-conversation composer drafts, so switching between bots and rooms never
// loses what was typed. The latest text, staged attachments, and a queued
// message live in memory for the session; text is also mirrored to
// localStorage so it survives a restart. Attachments can be large data URLs
// that don't belong in localStorage.
//
// Queued messages are owned here rather than by the composer: the composer
// unmounts when the user switches conversations, so the app shell drains the
// queue (useQueuedMessageSender) once the target bot or room is free.
import type { Attachment } from "@/state/store";

export type DraftTarget = { botId: string } | { groupId: string };
export interface QueuedMessage {
  text: string;
  attachments: Attachment[];
}
export interface ComposerDraft {
  text: string;
  attachments: Attachment[];
  queued: QueuedMessage | null;
}

const STORAGE_KEY = "composer-drafts";
const MAX_STORED = 100;
const memory = new Map<string, { text: string; attachments: Attachment[] }>();
const queue = new Map<string, { target: DraftTarget; message: QueuedMessage }>();
const listeners = new Set<() => void>();

export const draftKey = (target: { botId?: string; groupId?: string }) =>
  target.groupId ? `room:${target.groupId}` : `bot:${target.botId ?? ""}`;

function readTexts(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function loadDraft(key: string): ComposerDraft {
  const kept = memory.get(key);
  const stored = readTexts()[key];
  return {
    // memory holds the latest text even when a storage write failed
    text: kept ? kept.text : typeof stored === "string" ? stored : "",
    attachments: kept?.attachments ?? [],
    queued: queue.get(key)?.message ?? null,
  };
}

export function saveDraft(key: string, draft: Pick<ComposerDraft, "text" | "attachments">): void {
  memory.set(key, { text: draft.text, attachments: draft.attachments });
  const texts = readTexts();
  if ((texts[key] ?? "") === draft.text) return;
  delete texts[key];
  if (draft.text) texts[key] = draft.text; // re-inserted last = most recent
  const keys = Object.keys(texts);
  for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_STORED))) delete texts[stale];
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(texts));
  } catch {
    /* storage full or unavailable — the in-memory draft still has the latest text */
  }
}

// ── queued messages ──────────────────────────────────────────────────────

const notify = () => listeners.forEach((listener) => listener());

export function subscribeQueue(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getQueued(key: string): QueuedMessage | null {
  return queue.get(key)?.message ?? null;
}

export function setQueued(target: DraftTarget, message: QueuedMessage | null): void {
  const key = draftKey(target);
  if (message) queue.set(key, { target, message });
  else if (!queue.delete(key)) return;
  notify();
}

/** Removes and returns every queued message whose target `isReady` accepts. */
export function takeReadyQueued(isReady: (target: DraftTarget) => boolean): Array<{ target: DraftTarget; message: QueuedMessage }> {
  const ready = [...queue.entries()].filter(([, entry]) => isReady(entry.target));
  for (const [key] of ready) queue.delete(key);
  if (ready.length) notify();
  return ready.map(([, entry]) => entry);
}
