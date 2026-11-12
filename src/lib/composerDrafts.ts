// Per-conversation composer drafts, so switching between bots and rooms never
// loses what was typed. Text also survives a restart (localStorage); staged
// attachments and a queued message live in memory only — attachments can be
// large data URLs that don't belong in localStorage.
import type { Attachment } from "@/state/store";

export interface ComposerDraft {
  text: string;
  attachments: Attachment[];
  queued: { text: string; attachments: Attachment[] } | null;
}

const STORAGE_KEY = "composer-drafts";
const MAX_STORED = 100;
const memory = new Map<string, Omit<ComposerDraft, "text">>();

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
  const text = readTexts()[key];
  const kept = memory.get(key);
  return {
    text: typeof text === "string" ? text : "",
    attachments: kept?.attachments ?? [],
    queued: kept?.queued ?? null,
  };
}

export function saveDraft(key: string, draft: ComposerDraft): void {
  if (draft.attachments.length > 0 || draft.queued) {
    memory.set(key, { attachments: draft.attachments, queued: draft.queued });
  } else {
    memory.delete(key);
  }
  const texts = readTexts();
  if ((texts[key] ?? "") === draft.text) return;
  delete texts[key];
  if (draft.text) texts[key] = draft.text; // re-inserted last = most recent
  const keys = Object.keys(texts);
  for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_STORED))) delete texts[stale];
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(texts));
  } catch {
    /* storage full or unavailable — the in-session draft still works */
  }
}
