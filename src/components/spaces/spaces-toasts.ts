/** Background-activity toasts.
 *
 * A toast means: a bot you are *not* looking at just finished something. The
 * rules below exist to keep that from becoming noise — one toast per bot at a
 * time, a hard cap on the stack, and nothing at all on first sight of a bot
 * (otherwise opening the canvas would announce the entire backlog).
 */

import type { Message } from "@/state/store";

export const MAX_TOASTS = 3;
export const TOAST_TTL_MS = 4_000;

export interface SettledMessage {
  id: string;
  text: string;
}

export interface ToastSubject {
  id: string;
  name: string;
  settled: SettledMessage | null;
}

export interface Toast {
  id: string;
  subjectId: string;
  name: string;
  text: string;
  at: number;
}

/** The newest assistant message from a turn that has actually settled. */
export function lastSettled(messages: Message[]): SettledMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "bot" && message.turnTerminal) {
      return { id: message.id, text: message.text ?? "" };
    }
  }
  return null;
}

/**
 * Which subjects settled something new since the last look. `seen` maps a
 * subject id to the settled message id we already knew about; a subject missing
 * from it is being seen for the first time and stays quiet.
 */
export function settledSince(
  seen: Record<string, string | null>,
  subjects: ToastSubject[],
  focusedId: string | null,
  now: number,
): Toast[] {
  const events: Toast[] = [];
  for (const subject of subjects) {
    if (subject.id === focusedId) continue;
    if (!(subject.id in seen)) continue;
    const settledId = subject.settled?.id ?? null;
    if (!settledId || settledId === seen[subject.id]) continue;
    events.push({
      id: `${subject.id}:${settledId}`,
      subjectId: subject.id,
      name: subject.name,
      text: subject.settled?.text ?? "",
      at: now,
    });
  }
  return events;
}

/** Coalesce per subject, cap the stack, oldest first so it grows downward. */
export function mergeToasts(current: Toast[], incoming: Toast[], max = MAX_TOASTS): Toast[] {
  if (incoming.length === 0) return current;
  const bySubject = new Map<string, Toast>();
  for (const toast of [...current, ...incoming]) bySubject.set(toast.subjectId, toast);
  return [...bySubject.values()].sort((a, b) => a.at - b.at).slice(-max);
}

/** Identity-stable when nothing expired, so a render can bail out. */
export function expireToasts(toasts: Toast[], now: number, ttl = TOAST_TTL_MS): Toast[] {
  const kept = toasts.filter((toast) => now - toast.at < ttl);
  return kept.length === toasts.length ? toasts : kept;
}
