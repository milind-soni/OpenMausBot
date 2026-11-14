// Who may hold a Live call through Azure OpenAI, Fish Audio, Gemini or ElevenLabs. LIVE_DATA_CHANNEL in live-call.ts says why Azure is
// limited; on the relayed providers the harness hears the call only through its client's own reports (FishRelay in live-fish.ts).
import type { AppConfig } from "./config.ts";
import type { RequestAuth } from "./request-auth.ts";

export const LIVE_AZURE_REFUSAL = "Live calls here go through Azure OpenAI, so only an admin or the owner of this server can start one. Ask an admin if you need a call.";
export const LIVE_FISH_REFUSAL = "Live calls here go through Fish Audio, so only an admin or the owner of this server can start one. Ask an admin if you need a call.";
export const LIVE_GEMINI_REFUSAL = "Live calls here go through Gemini, so only an admin or the owner of this server can start one. Ask an admin if you need a call.";
export const LIVE_ELEVENLABS_REFUSAL = "Live calls here go through ElevenLabs, so only an admin or the owner of this server can start one. Ask an admin if you need a call.";

export interface LiveCallPlace {
  /** A local request may not be the owner, because other people use this server and every bot's shell is a local caller
   * too: a Team Cloud, a shared workspace, a sign-in list that lets others in, or a chat-only device. False in the desktop
   * app, where a local change needs the app's private token, and on a server one person uses. */
  othersOnLoopback: boolean;
}

/** Null only for an admin or the single owner. A caller this does not recognise is refused. */
export function azureLiveCallRefusal(auth: RequestAuth, place: LiveCallPlace, refusal: string = LIVE_AZURE_REFUSAL): string | null {
  if (!auth.scopes.includes("admin")) return refusal;
  if (auth.kind === "session") return auth.session.teamRole === "member" || auth.session.moveIn ? refusal : null;
  if (auth.kind === "loopback") return auth.trust === "service" || place.othersOnLoopback ? refusal : null;
  return refusal;
}

export function fishLiveCallRefusal(auth: RequestAuth, place: LiveCallPlace): string | null {
  return azureLiveCallRefusal(auth, place, LIVE_FISH_REFUSAL);
}

export function geminiLiveCallRefusal(auth: RequestAuth, place: LiveCallPlace): string | null {
  return azureLiveCallRefusal(auth, place, LIVE_GEMINI_REFUSAL);
}

export function elevenLabsLiveCallRefusal(auth: RequestAuth, place: LiveCallPlace): string | null {
  return azureLiveCallRefusal(auth, place, LIVE_ELEVENLABS_REFUSAL);
}

/** The words for a session without the admin scope, which never reaches a Live route. Only the words: the request is refused either way. */
export function liveScopeRefusal(cfg: Pick<AppConfig, "live">, method: string, path: string): string | null {
  if (method.toUpperCase() !== "POST" || path !== "/api/live/session") return null;
  const provider = cfg.live?.provider;
  return provider === "azure" ? LIVE_AZURE_REFUSAL : provider === "fish" ? LIVE_FISH_REFUSAL : provider === "gemini" ? LIVE_GEMINI_REFUSAL
    : provider === "elevenlabs" ? LIVE_ELEVENLABS_REFUSAL : null;
}
