import type { BrowserProfile } from "./config.ts";

export const TEMPORARY_BROWSER_PROFILE = "guest";

const OWN_BROWSER_LABEL = "its own browser";
const TEMPORARY_BROWSER_LABEL = "temporary browser";
const UNKNOWN_PROFILE = "browserProfile must name an existing browser profile";

export type BrowserProfileChange =
  | { ok: true; profile: string | undefined }
  | { ok: false; status: 400 | 409; error: string };

export interface BrowserProfileGuards {
  profiles(): readonly Pick<BrowserProfile, "id" | "name">[];
  heldBy(session: string): unknown;
  currentBrowserSession(botId: string, profile: string | undefined): string;
}

type GuardedBot = { id: string; busy?: boolean; browserProfile?: string };

/** The one gate on a bot's browserProfile: null or "" selects the bot's own browser. */
export function checkBrowserProfileChange(bot: GuardedBot | null | undefined, requested: unknown, guards: BrowserProfileGuards): BrowserProfileChange {
  const profile = requested === null || requested === "" ? undefined : requested;
  if (bot?.busy && profile !== bot.browserProfile) {
    return { ok: false, status: 409, error: "stop this bot's turn before changing its browser profile" };
  }
  if (bot && profile !== bot.browserProfile && guards.heldBy(guards.currentBrowserSession(bot.id, bot.browserProfile))) {
    return { ok: false, status: 409, error: "Release browser control before changing its profile." };
  }
  if (profile === undefined) return { ok: true, profile };
  if (typeof profile === "string" && (profile === TEMPORARY_BROWSER_PROFILE || guards.profiles().some((candidate) => candidate.id === profile))) {
    return { ok: true, profile };
  }
  return { ok: false, status: 400, error: UNKNOWN_PROFILE };
}

/** Accepts a profile id or its name (case-insensitive); "" is the bot's own browser. */
export function resolveBrowserProfile(input: string, profiles: readonly Pick<BrowserProfile, "id" | "name">[]): { ok: true; id: string } | { ok: false; error: string } {
  const wanted = input.trim();
  if (!wanted || wanted === TEMPORARY_BROWSER_PROFILE) return { ok: true, id: wanted };
  const byId = profiles.find((profile) => profile.id === wanted);
  if (byId) return { ok: true, id: byId.id };
  const byName = profiles.filter((profile) => profile.name.trim().toLowerCase() === wanted.toLowerCase());
  if (byName.length === 1) return { ok: true, id: byName[0]!.id };
  const names = profiles.map((profile) => `"${profile.name}"`).join(", ");
  return {
    ok: false,
    error: byName.length > 1
      ? `More than one browser profile is named "${wanted}"; use its id instead.`
      : `No browser profile is named "${wanted}". ${names ? `Existing profiles: ${names}.` : "There are no shared profiles yet."} Use "" for the bot's own browser; profiles are created in Settings, not here.`,
  };
}

export function browserProfileLabel(id: string | undefined, profiles: readonly Pick<BrowserProfile, "id" | "name">[]): string {
  if (!id) return OWN_BROWSER_LABEL;
  if (id === TEMPORARY_BROWSER_PROFILE) return TEMPORARY_BROWSER_LABEL;
  const profile = profiles.find((candidate) => candidate.id === id);
  return profile ? `"${profile.name}"` : `"${id}"`;
}

export interface BrowserChangeCleanup {
  closeForBot(botId: string): void;
  forgetTemporaryBrowser(botId: string): Promise<unknown>;
}

/** After a bot's browser profile or browser access changed: its live view closes and a temporary browser is erased. */
export function settleBrowserChange(
  after: { id: string; browserProfile?: string; browser?: boolean },
  before: { browserProfile?: string; browser?: boolean },
  cleanup: BrowserChangeCleanup,
): void {
  if (after.browserProfile === before.browserProfile && after.browser === before.browser) return;
  cleanup.closeForBot(after.id);
  if (before.browserProfile === TEMPORARY_BROWSER_PROFILE && (after.browserProfile !== TEMPORARY_BROWSER_PROFILE || after.browser === false)) {
    void cleanup.forgetTemporaryBrowser(after.id).catch((error) => console.warn("temporary browser cleanup failed", error));
  }
}
