import { BEAT_ORDER, WELCOME_VERSION, type BeatId } from "./onboarding";

/** The first run in progress: the screen it is on, so a reload resumes there. */
export interface WelcomeDraft {
  beat: BeatId;
}

/** Kept in this browser beside the email gate (analytics). */
export const WELCOME_DRAFT_KEY = "omb.onboarding.welcomeDraft";

/** A draft from an earlier welcome (its steps, a typed name) is no draft of this one. */
export function readWelcomeDraft(): WelcomeDraft | null {
  try {
    const raw = localStorage.getItem(WELCOME_DRAFT_KEY);
    const draft = raw ? (JSON.parse(raw) as (Partial<WelcomeDraft> & { version?: unknown }) | null) : null;
    if (!draft || typeof draft !== "object" || draft.version !== WELCOME_VERSION) return null;
    return BEAT_ORDER.includes(draft.beat as BeatId) ? { beat: draft.beat as BeatId } : null;
  } catch {
    return null;
  }
}

export function saveWelcomeDraft(draft: WelcomeDraft): void {
  try {
    localStorage.setItem(WELCOME_DRAFT_KEY, JSON.stringify({ version: WELCOME_VERSION, beat: draft.beat }));
  } catch {
  }
}

export function clearWelcomeDraft(): void {
  try {
    localStorage.removeItem(WELCOME_DRAFT_KEY);
  } catch {
  }
}
