// OMB Cloud's Admin relay still speaks Boat's retired box dialect (/boxes under a base ending in /api/box/v1, box and boxes
// envelopes; the same bx_ ids), so an included credential wired to such a base is translated here, at the transport only.
// Delete this file once no home is wired to /api/box/v1.
import type { ServiceCredential } from "./included-services.ts";

const LEGACY_RELAY_BASE = /\/api\/box\/v1$/;

const legacyRelay = (account: ServiceCredential | null): boolean =>
  account?.included === true && LEGACY_RELAY_BASE.test(account.api);

/** A v1 path as the legacy relay routes it: /sandboxes… becomes /boxes…. */
export function relayPath(account: ServiceCredential | null, path: string): string {
  return legacyRelay(account) ? path.replace(/^\/sandboxes(?=[/?]|$)/, "/boxes") : path;
}

/** box becomes sandbox, boxes sandboxes, and a deletion operation's kind box sandbox; every other field is already the same. */
export function relayBody(account: ServiceCredential | null, body: any): any {
  if (!legacyRelay(account) || !body || typeof body !== "object" || Array.isArray(body)) return body;
  const { box, boxes, ...rest } = body;
  return {
    ...rest,
    ...(box !== undefined ? { sandbox: box } : {}),
    ...(boxes !== undefined ? { sandboxes: boxes } : {}),
    ...(rest.operation?.kind === "box" ? { operation: { ...rest.operation, kind: "sandbox" } } : {}),
  };
}
