import { isPrivateHost } from "../shared/private-host.ts";
import { isLoopbackHost } from "./request-auth.ts";

/** The host an emailed sign-in code names: the configured address, else a private one the request came to. Anyone can
 * ask for a code, so a public Host header they send is never repeated in the email. */
export function signInMailTarget(configured: string | null, requestOrigin: string | null): string | null {
  for (const [origin, mustBePrivate] of [[configured, false], [requestOrigin, true]] as const) {
    if (!origin) continue;
    try {
      const url = new URL(origin);
      if (!mustBePrivate || (isPrivateHost(url.hostname) && !isLoopbackHost(url.host))) return url.host;
    } catch {
      continue;
    }
  }
  return null;
}

/** Where a pairing link points: the configured address, else the address the asking session used when that is https
 * or a private network other devices can reach. A public http link is never minted, and neither is a loopback one. */
export function pairingLinkBase(configured: string | null, requestOrigin: string | null): string | null {
  if (configured) return configured;
  if (!requestOrigin) return null;
  let url: URL;
  try {
    url = new URL(requestOrigin);
  } catch {
    return null;
  }
  if (isLoopbackHost(url.host)) return null;
  return url.protocol === "https:" || (url.protocol === "http:" && isPrivateHost(url.hostname)) ? url.origin : null;
}
