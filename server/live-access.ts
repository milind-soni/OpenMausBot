// Who may hold a Live call through Azure OpenAI. LIVE_DATA_CHANNEL in live-call.ts says why it is limited.
import type { AppConfig } from "./config.ts";
import type { RequestAuth } from "./request-auth.ts";

export const LIVE_AZURE_REFUSAL = "Live calls here go through Azure OpenAI, so only an admin or the owner of this server can start one. Ask an admin if you need a call.";

export interface LiveCallPlace {
  /** A local request may not be the owner, because other people use this server and every bot's shell is a local caller
   * too: a Team Cloud, a shared workspace, a sign-in list that lets others in, or a chat-only device. False in the desktop
   * app, where a local change needs the app's private token, and on a server one person uses. */
  othersOnLoopback: boolean;
}

/** Null only for an admin or the single owner. A caller this does not recognise is refused. */
export function azureLiveCallRefusal(auth: RequestAuth, place: LiveCallPlace): string | null {
  if (!auth.scopes.includes("admin")) return LIVE_AZURE_REFUSAL;
  if (auth.kind === "session") return auth.session.teamRole === "member" || auth.session.moveIn ? LIVE_AZURE_REFUSAL : null;
  if (auth.kind === "loopback") return auth.trust === "service" || place.othersOnLoopback ? LIVE_AZURE_REFUSAL : null;
  return LIVE_AZURE_REFUSAL;
}

/** The words for a session without the admin scope, which never reaches a Live route. Only the words: the request is refused either way. */
export function liveScopeRefusal(cfg: Pick<AppConfig, "live">, method: string, path: string): string | null {
  return cfg.live?.provider === "azure" && method.toUpperCase() === "POST" && path === "/api/live/session" ? LIVE_AZURE_REFUSAL : null;
}
