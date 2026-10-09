// The first question an OMB Cloud home asks: what should it do while you're
// away (components/CloudIntent.tsx, docs/cloud-pro.md). The answer is a
// `/setup` request (server/setup-mode.ts): the bot asks a few questions, then
// sets itself up for the job. Given before any AI is signed in, the job waits
// here, shown above the sign-in, and is sent the moment an engine can run.
//
// The waiting text is this device's (browser storage, like a composer draft);
// that a job was given or the question skipped is the Cloud's own record
// (onboarding hints), so another device is not asked again.
import { useSyncExternalStore } from "react";
import { CLOUD_INTENT_ASKED } from "@/lib/cloud-setup";
import { hintSeen, type OnboardingStatus, type WelcomeViewer } from "@/lib/onboarding";

const KEY = "omb.cloudIntent.pending";
const SENT_KEY = "omb.cloudIntent.sent";

/** Which bot a first job went to, and when (this device's clock). */
export interface SentIntent { botId: string; at: number }

/** What a first job becomes in the chat. */
export function setupMessage(job: string): string {
  return `/setup ${job.trim()}`;
}

/** Whether the first-job question leads the Cloud home: its owner's own
 * session, once the Cloud has answered, before the question was answered or
 * skipped and before any bot has finished a turn there. `reopened` is the
 * checklist asking for it again. */
export function cloudIntentDue(facts: {
  viewer: WelcomeViewer | null;
  connected: boolean;
  enginesKnown: boolean;
  onboarding: OnboardingStatus | undefined;
  reopened: boolean;
}): boolean {
  if (!facts.viewer?.cloudHome || !facts.viewer.canSave) return false;
  if (!facts.connected || !facts.enginesKnown || !facts.onboarding) return false;
  if (facts.reopened) return true;
  return !hintSeen(facts.onboarding, CLOUD_INTENT_ASKED) && !facts.onboarding.firstTurnAt;
}

type Snapshot = {
  /** A first job given before any engine could run it. */
  pending: string | null;
  /** The checklist asked for the question again. */
  reopened: boolean;
  /** Skipped in this session, before the Cloud's record says so. */
  dismissed: boolean;
  /** The job went to this bot: its first routine is the job set up. */
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
  } catch { /* private window: it still waits in memory */ }
  listeners.forEach((listener) => listener());
}

/** The job left for this bot: it is no longer waiting, and is now the bot's. */
export function markIntentSent(botId: string, at = Date.now()): void {
  update({ pending: null, reopened: false, sent: { botId, at } });
}

/** Whether a routine is the first job set up: the job's bot's, made after
 * the job was sent (a minute's grace for the two clocks). Without this
 * device's record of the send, any routine on the Cloud counts. */
export function jobRoutine<R extends { botId: string; createdAt: number }>(routines: readonly R[], sent: SentIntent | null): R | undefined {
  const fresh = routines.filter((routine) => !sent || (routine.botId === sent.botId && routine.createdAt >= sent.at - 60_000));
  return fresh.sort((a, b) => a.createdAt - b.createdAt)[0];
}

/** Keep a first job until an engine can run it. */
export function setPendingIntent(job: string | null): void {
  update({ pending: job?.trim() || null });
}

/** The checklist's "Give it a job": ask the question again. */
export function reopenCloudIntent(open: boolean): void {
  update({ reopened: open, ...(open ? { dismissed: false } : {}) });
}

/** Skip for now: the question steps aside at once. */
export function dismissCloudIntent(): void {
  update({ reopened: false, dismissed: true });
}

/** Whether the question fills the chat pane now: due, or asked for again,
 * and not already answered with a job that waits for an engine. */
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
