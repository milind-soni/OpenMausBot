// One relay URL + token pair per included service:
//   OMB_CLOUD_BOAT_URL    + OMB_CLOUD_BOAT_TOKEN     the Boat relay, ending in /api/box/v1
//   OMB_CLOUD_VOICE_URL   + OMB_CLOUD_VOICE_TOKEN    the ElevenLabs relay, ending in /v1
//   OMB_CLOUD_DECIDER_URL + OMB_CLOUD_DECIDER_TOKEN  the Jev relay, a Jev base URL
//   OMB_CLOUD_AI_URL      + OMB_CLOUD_AI_TOKEN       the trial's Claude credit, an OpenAI-compatible base URL
//   OMB_CLOUD_X_URL       + OMB_CLOUD_X_TOKEN        the X research relay (a desktop gets its own over the parent port)
// The person's own key always wins and is resolved per request; an included token goes only to its relay and is never
// written to config.json or reported to a client.
import { JEV_DEFAULT_BASE_URL } from "./decider/jev.ts";

export const BOAT_API_DEFAULT = "https://boat.dev/api/v1";
export const ELEVENLABS_API_DEFAULT = "https://api.elevenlabs.io/v1";
/** Must also be on WORKSPACE_CREDENTIAL_ENV. */
export const INCLUDED_TOKEN_ENV = ["OMB_CLOUD_BOAT_TOKEN", "OMB_CLOUD_VOICE_TOKEN", "OMB_CLOUD_DECIDER_TOKEN", "OMB_CLOUD_AI_TOKEN", "OMB_CLOUD_X_TOKEN"] as const;

export interface ServiceCredential {
  token: string;
  /** The only base URL this token is ever sent to. */
  api: string;
  included: boolean;
}

interface Included {
  boat: ServiceCredential | null;
  voice: ServiceCredential | null;
  decider: ServiceCredential | null;
  ai: ServiceCredential | null;
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
  decider: includedService(env.OMB_CLOUD_DECIDER_URL, env.OMB_CLOUD_DECIDER_TOKEN),
  ai: trialCreditService(env.OMB_CLOUD_AI_URL, env.OMB_CLOUD_AI_TOKEN),
  x: includedService(env.OMB_CLOUD_X_URL, env.OMB_CLOUD_X_TOKEN),
});

/** The token is a key the chat engine sends here, so the address must be HTTPS (loopback for tests) and the token the Admin's shape. */
function trialCreditService(url: string | undefined, token: string | undefined): ServiceCredential | null {
  const credential = includedService(url, token);
  if (!credential || !/^omb_ai_[A-Za-z0-9_-]{43}$/.test(credential.token)) return null;
  try {
    const parsed = new URL(credential.api);
    const loopback = parsed.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(parsed.hostname);
    return (parsed.protocol === "https:" || loopback) && !parsed.username && !parsed.password && !parsed.search && !parsed.hash ? credential : null;
  } catch {
    return null;
  }
}

let held: Included | null = null;

/** Dropped from the environment at startup so nothing the server starts can inherit them. */
export function holdIncludedServices(env: NodeJS.ProcessEnv = process.env): void {
  held = includedFrom(env);
  for (const name of INCLUDED_TOKEN_ENV) delete env[name];
}

function resolve(own: string | undefined, providerApi: string, included: ServiceCredential | null): ServiceCredential | null {
  if (own) {
    // A leased computer hands the included token back as a plain one; it still goes only to its relay.
    if (included && own === included.token) return included;
    return { token: own, api: providerApi, included: false };
  }
  return included;
}

export const boatProviderApi = (env: NodeJS.ProcessEnv = process.env): string => env.OMB_BOAT_API || BOAT_API_DEFAULT;
export const elevenLabsProviderApi = (env: NodeJS.ProcessEnv = process.env): string =>
  env.OMB_ELEVENLABS_API || ELEVENLABS_API_DEFAULT;

export function boatCredential(own: string | undefined, env: NodeJS.ProcessEnv = process.env): ServiceCredential | null {
  return resolve(own, boatProviderApi(env), (held ?? includedFrom(env)).boat);
}

export function voiceCredential(own: string | undefined, env: NodeJS.ProcessEnv = process.env): ServiceCredential | null {
  return resolve(own, elevenLabsProviderApi(env), (held ?? includedFrom(env)).voice);
}

export function trialCreditCredential(env: NodeJS.ProcessEnv = process.env): ServiceCredential | null {
  return (held ?? includedFrom(env)).ai;
}

export function deciderCredential(
  own: string | undefined,
  ownBaseUrl: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ServiceCredential | null {
  return resolve(own?.trim(), ownBaseUrl?.trim() || JEV_DEFAULT_BASE_URL, (held ?? includedFrom(env)).decider);
}

/** X research's relay token on a signed-in desktop: the desktop's main process
 * fetches it with its MausBot Cloud sign-in while the plan is paid
 * (electron/main.mjs) and hands it over on the private parent port. Held in
 * memory only, never written to config. */
let desktopX: ServiceCredential | null = null;
/** The Admin said this desktop's paid sign-in gets no X research (the plan is not active there, or the service is off). */
let desktopXRefused = false;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** `{ type: "openmausbot:included-x", access: { url, token } | null }` from
 * the desktop's main process. True when it was one (then applied), false for
 * any other message; a malformed one throws and changes nothing. */
export function applyIncludedXMessage(message: unknown): boolean {
  if (!message || typeof message !== "object" || (message as { type?: unknown }).type !== "openmausbot:included-x") return false;
  const access = (message as { access?: unknown }).access;
  if (access === null) {
    desktopX = null;
    desktopXRefused = (message as { offered?: unknown }).offered === false;
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
  desktopXRefused = false;
  return true;
}

/** What the app's Settings show (configStatus `xResearch`): included while a
 * credential is held; `unavailable` when the Admin said no to this desktop's
 * paid sign-in, so the card says so instead of connecting forever. */
export function xResearchStatus(env: NodeJS.ProcessEnv = process.env): { included: boolean; unavailable?: true } {
  if (xCredential(env)) return { included: true };
  return desktopXRefused ? { included: false, unavailable: true } : { included: false };
}

/** The plan's research credential: a Cloud home's included token, else a signed-in desktop's. */
export function xCredential(env: NodeJS.ProcessEnv = process.env): ServiceCredential | null {
  return (held ?? includedFrom(env)).x ?? desktopX;
}

export const TREG_API_DEFAULT = "https://treg.to";
/** Security: the person's treg key goes only to treg (https), or to a loopback stand-in in development and tests. */
export function tregProviderApi(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.OMB_TREG_URL?.trim().replace(/\/+$/, "");
  if (!configured) return TREG_API_DEFAULT;
  try {
    const parsed = new URL(configured);
    return parsed.protocol === "https:" || (parsed.protocol === "http:" && LOOPBACK.has(parsed.hostname)) ? configured : TREG_API_DEFAULT;
  } catch {
    return TREG_API_DEFAULT;
  }
}

/** The X and research tools' credential: the person's own treg key (sent straight to treg, `included` false) wins over
 * the plan's relay credential; null with neither, and then no bot is shown the tools. */
export function researchCredential(ownKey: string | undefined, env: NodeJS.ProcessEnv = process.env): ServiceCredential | null {
  const own = ownKey?.trim();
  return own ? { token: own, api: tregProviderApi(env), included: false } : xCredential(env);
}
