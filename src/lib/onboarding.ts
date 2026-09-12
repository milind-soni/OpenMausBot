// First-run state and the welcome flow's beat machine, kept pure so the
// decisions (show the tour? which beat is next? what to persist?) are unit
// tested without React. The record itself lives in the workspace config on
// the server, never in browser storage: clearing site data or opening a
// second profile must not replay the tour, and a phone paired later should
// see the same hints as already dismissed.

export interface OnboardingStatus {
  /** ISO timestamp; "" until the welcome flow has been finished or skipped. */
  completedAt: string;
  /** Which welcome flow was completed; a newer flow may re-show itself. */
  version: number;
  reelSeen: boolean;
  hintsSeen: string[];
}

/** Bump when the welcome flow changes enough that existing users should see
 * it again. Completions at an older version count as not done. */
export const WELCOME_VERSION = 1;

export const EMPTY_ONBOARDING: OnboardingStatus = {
  completedAt: "",
  version: 0,
  reelSeen: false,
  hintsSeen: [],
};

/** Whether the welcome flow should open on launch. Null config means the
 * server has not answered yet; showing the tour on a guess would flash it at
 * every returning user, so the answer is no until the record arrives. */
export function welcomeDue(
  config: { onboarding?: OnboardingStatus } | null | undefined,
  options: { remoteClient: boolean; legacyDone: boolean },
): boolean {
  if (options.remoteClient) return false;
  if (!config) return false;
  const record = config.onboarding ?? EMPTY_ONBOARDING;
  if (record.completedAt && record.version >= WELCOME_VERSION) return false;
  // One release of grace for installs that finished the old localStorage
  // gate: they are not new, so they are not shown the new flow either.
  if (!record.completedAt && options.legacyDone) return false;
  return true;
}

/** The config patch that marks the welcome flow done. Sent through the same
 * `PUT /api/config` path as the profile; sections merge server-side, so
 * hints already seen survive a replay. */
export function completionPatch(now: Date = new Date()): { onboarding: { completedAt: string; version: number } } {
  return { onboarding: { completedAt: now.toISOString(), version: WELCOME_VERSION } };
}

export function hintSeen(record: OnboardingStatus | undefined, id: string): boolean {
  return (record?.hintsSeen ?? []).includes(id);
}

/** Null when nothing needs saving, so callers never issue a no-op write. */
export function hintSeenPatch(
  record: OnboardingStatus | undefined,
  id: string,
): { onboarding: { hintsSeen: string[] } } | null {
  if (hintSeen(record, id)) return null;
  return { onboarding: { hintsSeen: [...(record?.hintsSeen ?? []), id] } };
}

// ── beats ──────────────────────────────────────────────────────────────

export type BeatId = "hello" | "reel" | "engines" | "permissions" | "phone" | "bot";

export interface BeatOptions {
  /** The desktop app can ask for the microphone; a browser cannot. */
  dictation: boolean;
  /** The feature reel ships in a later phase; it is a beat the machine
   * already knows so that turning it on is one flag. */
  reel: boolean;
}

/** Beats in order for this session. The exit beat is always last so the
 * seeded bot is named even when everything else was skipped. */
export function beatsFor(options: BeatOptions): BeatId[] {
  const beats: BeatId[] = ["hello"];
  if (options.reel) beats.push("reel");
  beats.push("engines");
  if (options.dictation) beats.push("permissions");
  beats.push("phone", "bot");
  return beats;
}

export function nextBeat(beats: readonly BeatId[], current: BeatId): BeatId | null {
  const index = beats.indexOf(current);
  if (index < 0 || index + 1 >= beats.length) return null;
  return beats[index + 1]!;
}

export function previousBeat(beats: readonly BeatId[], current: BeatId): BeatId | null {
  const index = beats.indexOf(current);
  if (index <= 0) return null;
  return beats[index - 1]!;
}

/** The card is one element for the whole flow; its width is the one thing
 * that morphs between beats. Engines lays tiles out two across and needs
 * the room; the rest read best narrow. */
export function beatWidth(beat: BeatId): number {
  switch (beat) {
    case "engines":
      return 680;
    case "phone":
      return 620;
    case "reel":
      return 720;
    case "bot":
      return 520;
    default:
      return 460;
  }
}

// ── motion ─────────────────────────────────────────────────────────────

/** The OS preference, plus a dev hook the preview page uses to show the
 * reduced variant without changing system settings. */
export function reducedMotion(): boolean {
  if (typeof document !== "undefined" && document.documentElement.dataset.reducedMotion === "true") return true;
  return globalThis.window?.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}
