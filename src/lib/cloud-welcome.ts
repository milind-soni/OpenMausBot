import { useSyncExternalStore } from "react";
import type { CloudPlanSnapshot } from "../../electron/cloud-account.mjs";
import { CLOUD_SETUP_HIDDEN, CLOUD_WELCOME_DONE, cloudWelcomeStage } from "@/lib/cloud-setup";
import type { OnboardingStatus, WelcomeViewer } from "@/lib/onboarding";
import { api, type Action, type ConfigStatus } from "@/state/store";

interface Snapshot {
  /** The person picked a bot or room: the welcome waits behind the setup card for this session. */
  aside: boolean;
  /** Done or skipped here, before the Cloud's record says so. */
  ended: boolean;
  /** Hints written here and not yet in the Cloud's record. */
  early: readonly string[];
  /** Where Continue setup asked the welcome to open. */
  requested: string | null;
  /** Shown in this session: it stays while the Cloud restarts under it. */
  seen: boolean;
  /** The welcome ended here but the Cloud could not save it: this device keeps it until the Cloud does. */
  doneHere: boolean;
}

const DONE_HERE = "omb.cloudWelcome.done";
function stored(key: string): string | null {
  try { return globalThis.localStorage?.getItem(key) || null; } catch { return null; }
}
function store(key: string, value: string | null): void {
  try {
    if (value) globalThis.localStorage?.setItem(key, value);
    else globalThis.localStorage?.removeItem(key);
  } catch {}
}
const initial = (): Snapshot => {
  const doneHere = stored(DONE_HERE) !== null;
  return { aside: false, ended: doneHere, early: doneHere ? [CLOUD_WELCOME_DONE] : [], requested: null, seen: false, doneHere };
};
let snapshot: Snapshot = initial();
const listeners = new Set<() => void>();

function update(next: Partial<Snapshot>) {
  snapshot = { ...snapshot, ...next };
  listeners.forEach((listener) => listener());
}

export function useCloudWelcome(): Snapshot {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    () => snapshot,
    () => snapshot,
  );
}

export function stepAsideWelcome(): void { update({ aside: true }); }
export function returnToWelcome(step?: string): void { update({ aside: false, requested: step ?? null }); }
export function takeWelcomeRequest(): string | null {
  const requested = snapshot.requested;
  if (requested) snapshot = { ...snapshot, requested: null };
  return requested;
}
export function endWelcomeHere(): void { update({ ended: true }); }
export function markWelcomeSeen(): void { if (!snapshot.seen) update({ seen: true }); }
export function noteWelcomeHints(ids: readonly string[]): void {
  update({ early: [...new Set([...snapshot.early, ...ids])] });
}
/** Only for tests: the store is module state. */
export function resetCloudWelcome(): void { update(initial()); }

export function withEarlyHints(record: OnboardingStatus | undefined, early: readonly string[]): OnboardingStatus | undefined {
  if (!record || early.every((id) => record.hintsSeen.includes(id))) return record;
  return { ...record, hintsSeen: [...new Set([...record.hintsSeen, ...early])] };
}

export function cloudWelcomeShown(stage: string, welcome: Pick<Snapshot, "aside" | "ended" | "seen">): boolean {
  return (stage === "pending" || (stage === "waiting" && welcome.seen)) && !welcome.aside && !welcome.ended;
}

/** Whether the welcome fills the main pane, from the Cloud's record with the hints written here that it has not saved yet. */
export function cloudWelcomeVisible(
  facts: { viewer: WelcomeViewer | null; connected: boolean; enginesKnown: boolean; onboarding: OnboardingStatus | undefined },
  welcome: Pick<Snapshot, "aside" | "ended" | "seen" | "early">,
): boolean {
  return cloudWelcomeShown(cloudWelcomeStage({ ...facts, onboarding: withEarlyHints(facts.onboarding, welcome.early) }), welcome);
}

export function keepWelcomeDoneHere(): void {
  store(DONE_HERE, "1");
  update({ doneHere: true, ended: true, early: [...new Set([...snapshot.early, CLOUD_WELCOME_DONE])] });
}
export function forgetWelcomeDoneHere(): void {
  store(DONE_HERE, null);
  update({ doneHere: false });
}

export const WELCOME_SAVE_RETRY_MS = 1500;
const ENDING = new Set([CLOUD_WELCOME_DONE, CLOUD_SETUP_HIDDEN]);

/**
 * Adds hints to the Cloud's onboarding record, with one retry (a busy Cloud answers 409 for a moment). When an end
 * of the welcome still cannot be saved, this device keeps it, so the welcome does not come back on the next launch.
 */
export async function saveWelcomeHints(
  record: OnboardingStatus | undefined, ids: readonly string[], dispatch: (action: Action) => void,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<boolean> {
  noteWelcomeHints(ids);
  const hintsSeen = [...new Set([...(record?.hintsSeen ?? []), ...snapshot.early, ...ids])];
  const put = () => api<ConfigStatus>("/api/config", { method: "PUT", body: JSON.stringify({ onboarding: { hintsSeen } }) });
  try {
    const config = await put().catch(async () => { await wait(WELCOME_SAVE_RETRY_MS); return put(); });
    dispatch({ type: "configStatus", config });
    return true;
  } catch {
    if (ids.some((id) => ENDING.has(id))) keepWelcomeDoneHere();
    return false;
  }
}

/** What a Cloud's main pane opens on first: the welcome before anything that can start a chat (the first-job question, a job waiting for the sign-in). */
export function cloudFirstRun(shown: { welcome: boolean; intent: boolean; signIn: boolean }): "welcome" | "intent" | "sign-in" | null {
  if (shown.welcome) return "welcome";
  if (shown.intent) return "intent";
  return shown.signIn ? "sign-in" : null;
}

export type WelcomeCredit = { state: "active"; left: number | null } | { state: "used_up" | "ended" };

/** The trial's Claude credit as the Cloud's engines report it; the amount only where the desktop app's plan says it. */
export function welcomeCredit(
  instances: ReadonlyArray<{ trialCredit?: "active" | "used_up" | "ended" }>,
  plan: CloudPlanSnapshot | null,
): WelcomeCredit | null {
  const reported = instances.find((instance) => instance.trialCredit)?.trialCredit;
  const credit = plan?.credit;
  if (reported === "active" || (!reported && credit?.state === "active")) {
    return { state: "active", left: credit?.state === "active" ? credit.remainingUsd : null };
  }
  if (reported) return { state: reported };
  return credit?.state === "used_up" ? { state: "used_up" } : null;
}
