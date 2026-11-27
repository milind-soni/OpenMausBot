import { useSyncExternalStore } from "react";
import type { OnboardingStatus, WelcomeViewer } from "@/lib/onboarding";

const KEY = "omb.cloudIntent.pending";
const SENT_KEY = "omb.cloudIntent.sent";

export interface SentIntent { botId: string; at: number }

export function setupMessage(job: string): string {
  return `/setup ${job.trim()}`;
}

/** A new Cloud opens on its welcome, which brings this computer's bots over before any chat: the question waits to be asked for. */
export function cloudIntentDue(facts: {
  viewer: WelcomeViewer | null;
  connected: boolean;
  enginesKnown: boolean;
  onboarding: OnboardingStatus | undefined;
  reopened: boolean;
}): boolean {
  if (!facts.viewer?.cloudHome || !facts.viewer.canSave) return false;
  if (!facts.connected || !facts.enginesKnown || !facts.onboarding) return false;
  return facts.reopened;
}

type Snapshot = {
  pending: string | null;
  reopened: boolean;
  dismissed: boolean;
  sent: SentIntent | null;
};
let snapshot: Snapshot = { pending: readPending(), reopened: false, dismissed: false, sent: readSent() };
const listeners = new Set<() => void>();

function readPending(): string | null {
  try { return globalThis.localStorage?.getItem(KEY) || null; } catch { return null; }
}

function readSent(): SentIntent | null {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(SENT_KEY) || "null") as SentIntent | null;
    return value && typeof value.botId === "string" && typeof value.at === "number" ? value : null;
  } catch { return null; }
}

function update(next: Partial<Snapshot>) {
  snapshot = { ...snapshot, ...next };
  try {
    if ("pending" in next) {
      if (next.pending) globalThis.localStorage?.setItem(KEY, next.pending);
      else globalThis.localStorage?.removeItem(KEY);
    }
    if (next.sent) globalThis.localStorage?.setItem(SENT_KEY, JSON.stringify(next.sent));
  } catch {}
  listeners.forEach((listener) => listener());
}

export function markIntentSent(botId: string, at = Date.now()): void {
  update({ pending: null, reopened: false, sent: { botId, at } });
}

export function jobRoutine<R extends { botId: string; createdAt: number }>(routines: readonly R[], sent: SentIntent | null): R | undefined {
  const fresh = routines.filter((routine) => !sent || (routine.botId === sent.botId && routine.createdAt >= sent.at - 60_000));
  return fresh.sort((a, b) => a.createdAt - b.createdAt)[0];
}

export function setPendingIntent(job: string | null): void {
  update({ pending: job?.trim() || null });
}

export function reopenCloudIntent(open: boolean): void {
  update({ reopened: open, ...(open ? { dismissed: false } : {}) });
}

export function dismissCloudIntent(): void {
  update({ reopened: false, dismissed: true });
}

export function cloudIntentShown(due: boolean, intent: Snapshot): boolean {
  return intent.reopened || (due && !intent.pending && !intent.dismissed);
}

export function useCloudIntent(): Snapshot {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    () => snapshot,
    () => snapshot,
  );
}
