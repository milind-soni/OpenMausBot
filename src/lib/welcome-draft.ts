import { BEAT_ORDER, WELCOME_VERSION, type BeatId } from "./onboarding";

/** What the welcome's greeting asks for: a name only. The email is asked once, by the product-updates question. */
export interface WelcomeFields {
  name: string;
}

export interface WelcomeDraft extends WelcomeFields {
  beat: BeatId;
}

const FIELD_LIMIT = 320;

/** What the welcome saves to the profile: a typed name. Never a blank over a saved one, nothing unchanged. */
export function profilePatch(fields: WelcomeFields, saved?: { name?: string }): { profile: { name: string } } | null {
  const name = fields.name.trim();
  return name && name !== saved?.name ? { profile: { name } } : null;
}

/** The welcome in progress, kept in this browser beside the email gate (analytics) so a reload resumes it. */
export const WELCOME_DRAFT_KEY = "omb.onboarding.welcomeDraft";

const text = (value: unknown): value is string => typeof value === "string" && value.length <= FIELD_LIMIT;

/** A draft from before also held an email; it is left out. */
export function readWelcomeDraft(): WelcomeDraft | null {
  try {
    const raw = localStorage.getItem(WELCOME_DRAFT_KEY);
    const draft = raw ? (JSON.parse(raw) as (Partial<WelcomeDraft> & { version?: unknown }) | null) : null;
    if (!draft || typeof draft !== "object" || draft.version !== WELCOME_VERSION) return null;
    if (!BEAT_ORDER.includes(draft.beat as BeatId) || !text(draft.name)) return null;
    return { beat: draft.beat as BeatId, name: draft.name };
  } catch {
    return null;
  }
}

export function saveWelcomeDraft(draft: WelcomeDraft): void {
  try {
    localStorage.setItem(WELCOME_DRAFT_KEY, JSON.stringify({ version: WELCOME_VERSION, beat: draft.beat, name: draft.name.slice(0, FIELD_LIMIT) }));
  } catch {
  }
}

export function clearWelcomeDraft(): void {
  try {
    localStorage.removeItem(WELCOME_DRAFT_KEY);
  } catch {
  }
}
