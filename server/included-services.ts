// Boat cloud computers, ElevenLabs voice and the Jev decision model included
// with Cloud Pro (docs/cloud-pro.md, "Included Boat computers, voice and
// decisions").
// The Admin relays each on its own accounts, so its provider keys never reach
// this machine; each Cloud home gets its own relay tokens:
//
//   OMB_CLOUD_BOAT_URL    + OMB_CLOUD_BOAT_TOKEN     the Boat relay, ending in /api/box/v1
//   OMB_CLOUD_VOICE_URL   + OMB_CLOUD_VOICE_TOKEN    the ElevenLabs relay, ending in /v1
//   OMB_CLOUD_DECIDER_URL + OMB_CLOUD_DECIDER_TOKEN  the Jev relay, a Jev base URL
//
// An included token is only a fallback. The person's own key (Settings, or
// BOX_TOKEN / OMB_TTS_KEY / OMB_JEV_API_KEY) always wins, and removing it
// falls back again, so the credential is resolved on every request, never
// cached. The relay knows only our account, so each credential goes to one
// place: an own key to the provider (OMB_BOX_API / OMB_ELEVENLABS_API /
// decider.baseUrl when set, for dev and tests), an included token to its
// relay. An included token is never written to config.json, never reported
// to a client, and never the saved key Settings verifies, rotates or clears.
import { JEV_DEFAULT_BASE_URL } from "./decider/jev.ts";

export const BOAT_API_DEFAULT = "https://ascii.dev/api/box/v1";
export const ELEVENLABS_API_DEFAULT = "https://api.elevenlabs.io/v1";
/** Also on WORKSPACE_CREDENTIAL_ENV (config.ts). */
export const INCLUDED_TOKEN_ENV = ["OMB_CLOUD_BOAT_TOKEN", "OMB_CLOUD_VOICE_TOKEN", "OMB_CLOUD_DECIDER_TOKEN", "OMB_CLOUD_X_TOKEN"] as const;

export interface ServiceCredential {
  token: string;
  /** The only base URL this token is ever sent to. */
  api: string;
  /** Cloud Pro's included token, not the person's own key. */
  included: boolean;
}

interface Included {
  boat: ServiceCredential | null;
  voice: ServiceCredential | null;
  decider: ServiceCredential | null;
  x: ServiceCredential | null;
}

function includedService(url: string | undefined, token: string | undefined): ServiceCredential | null {
  const api = url?.trim().replace(/\/+$/, "");
  const secret = token?.trim();
  return api && secret ? { token: secret, api, included: true } : null;
}

const includedFrom = (env: NodeJS.ProcessEnv): Included => ({
  boat: includedService(env.OMB_CLOUD_BOAT_URL, env.OMB_CLOUD_BOAT_TOKEN),
  voice: includedService(env.OMB_CLOUD_VOICE_URL, env.OMB_CLOUD_VOICE_TOKEN),
  // A Jev base URL as it is: the decider adds /v1/systemone, the relay's one route.
  decider: includedService(env.OMB_CLOUD_DECIDER_URL, env.OMB_CLOUD_DECIDER_TOKEN),
  x: includedService(env.OMB_CLOUD_X_URL, env.OMB_CLOUD_X_TOKEN),
});

let held: Included | null = null;

/** At server startup: keep the included tokens in memory and drop them from
 * the environment, as with the Cloud bootstrap secret, so nothing the server
 * starts can inherit them. Before this (tests, scripts) they are read from
 * the environment on each call. */
export function holdIncludedServices(env: NodeJS.ProcessEnv = process.env): void {
  held = includedFrom(env);
  for (const name of INCLUDED_TOKEN_ENV) delete env[name];
}

function resolve(own: string | undefined, providerApi: string, included: ServiceCredential | null): ServiceCredential | null {
  if (own) {
    // A leased computer descriptor hands the token in use back as a plain
    // token; the included one still goes only to its relay.
    if (included && own === included.token) return included;
    return { token: own, api: providerApi, included: false };
  }
  return included;
}

export const boatProviderApi = (env: NodeJS.ProcessEnv = process.env): string => env.OMB_BOX_API || BOAT_API_DEFAULT;
export const elevenLabsProviderApi = (env: NodeJS.ProcessEnv = process.env): string =>
  env.OMB_ELEVENLABS_API || ELEVENLABS_API_DEFAULT;

/** The Boat credential in use: the person's own token, else the included one. */
export function boatCredential(own: string | undefined, env: NodeJS.ProcessEnv = process.env): ServiceCredential | null {
  return resolve(own, boatProviderApi(env), (held ?? includedFrom(env)).boat);
}

/** The ElevenLabs credential in use: the person's own key, else the included one. */
export function voiceCredential(own: string | undefined, env: NodeJS.ProcessEnv = process.env): ServiceCredential | null {
  return resolve(own, elevenLabsProviderApi(env), (held ?? includedFrom(env)).voice);
}

/** The decision model's credential in use: the person's own Jev key (saved,
 * or OMB_JEV_API_KEY) with their `decider.baseUrl` or Jev's own, else the
 * included token with the relay. `api` is a Jev base URL. */
export function deciderCredential(
  own: string | undefined,
  ownBaseUrl: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ServiceCredential | null {
  return resolve(own?.trim(), ownBaseUrl?.trim() || JEV_DEFAULT_BASE_URL, (held ?? includedFrom(env)).decider);
}

/** X research's relay token on a signed-in desktop: the desktop's main process
 * fetches it with its OpenMausBot Cloud sign-in while the plan is paid
 * (electron/main.mjs) and hands it over on the private parent port. Held in
 * memory only, never written to config. */
let desktopX: ServiceCredential | null = null;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** `{ type: "openmausbot:included-x", access: { url, token } | null }` from
 * the desktop's main process. True when it was one (then applied), false for
 * any other message; a malformed one throws and changes nothing. */
export function applyIncludedXMessage(message: unknown): boolean {
  if (!message || typeof message !== "object" || (message as { type?: unknown }).type !== "openmausbot:included-x") return false;
  const access = (message as { access?: unknown }).access;
  if (access === null) {
    desktopX = null;
    return true;
  }
  const { url, token } = (access && typeof access === "object" ? access : {}) as { url?: unknown; token?: unknown };
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{8,256}$/.test(token) || typeof url !== "string") throw new Error("invalid X research access");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("invalid X research relay URL");
  }
  // The token goes only to our relay: https, or a loopback relay in development and tests.
  if (!(parsed.protocol === "https:" || (parsed.protocol === "http:" && LOOPBACK.has(parsed.hostname)))) throw new Error("invalid X research relay URL");
  desktopX = { token, api: url.trim().replace(/\/+$/, ""), included: true };
  return true;
}

/** X research's credential: a Cloud home's included token, else a signed-in
 * desktop's. There is no own-key path: X research is a Cloud plan feature. */
export function xCredential(env: NodeJS.ProcessEnv = process.env): ServiceCredential | null {
  return (held ?? includedFrom(env)).x ?? desktopX;
}
