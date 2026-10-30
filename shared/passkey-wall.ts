// A sign-in step that only the person's own authenticator can answer: a passkey or security key on their phone or
// computer. A bot's browser runs headless, without that authenticator, and a cloud browser has no Bluetooth for the
// phone's QR (hybrid) route either, so the step waits until it times out.

/** Whose account sign-in stopped at a passkey. */
export type PasskeyWall = "google" | "microsoft";

/** Google's passkey (pk) and security key (sk) challenges, under /v3/signin/challenge/… and /signin/v2/challenge/…. */
const GOOGLE_CHALLENGE = /^\/(?:v\d+\/)?signin\/(?:v\d+\/)?challenge\/(?:pk|sk)(?:\/|$)/u;

/** The address of Google's passkey step, as a browser view or a page change names it. */
export function passkeyWallAt(address: string): PasskeyWall | null {
  let url: URL;
  try { url = new URL(address); } catch { return null; }
  return url.hostname === "accounts.google.com" && GOOGLE_CHALLENGE.test(url.pathname) ? "google" : null;
}

const GOOGLE_ADDRESS = /https:\/\/accounts\.google\.com(\/[^\s"'?#)]*)/gu;
/** Google's wording on its passkey step, in English, Brazilian Portuguese and Spanish. */
const GOOGLE_WORDS = /\buse your passkey\b|\busing your passkey\b|verifying it(?:'|’)s you[\s\S]{0,400}\bpasskey\b|\buse sua chave de acesso\b|\busando sua chave de acesso\b|\busa tu llave de acceso\b|\busando tu llave de acceso\b/iu;
const GOOGLE_PAGE = /\bGoogle\b|accounts\.google\.com/u;
/** "your", not "a": a passkey offered as one option among others is no wall. */
const MICROSOFT_WORDS = /\bsign in with your passkey\b|\buse your passkey\b|\bsign in with your face, fingerprint, PIN,? or security key\b/iu;
const MICROSOFT_PAGE = /login\.(?:microsoftonline|live)\.com|\bMicrosoft\b/u;

/** A page's text or a browser tool's answer: the passkey step's address, or its wording on that provider's page. */
export function passkeyWallIn(text: string): PasskeyWall | null {
  for (const match of text.matchAll(GOOGLE_ADDRESS)) if (GOOGLE_CHALLENGE.test(match[1] ?? "")) return "google";
  if (GOOGLE_WORDS.test(text) && GOOGLE_PAGE.test(text)) return "google";
  if (MICROSOFT_WORDS.test(text) && MICROSOFT_PAGE.test(text)) return "microsoft";
  return null;
}
