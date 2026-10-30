// What a move checks of the credentials it carried, without any secret coming back: each server answers a keyed
// fingerprint (HMAC-SHA256 under a nonce the desktop's main process chose) of each credential, by the same id on both
// sides. My Cloud answers POST /api/cloud-send/verify-secrets to its owner; this computer answers only over its private
// port (login-handoff.ts), so no local process can ask it.
// Known open risk: an answer lets whoever holds the owner's session test guesses at a weak saved password offline.
import { createHmac } from "node:crypto";

import { itemKey } from "../electron/cloud-send-parts.mjs";
import { canonicalJson } from "../shared/package-format.ts";
import type { LoginStore } from "./login-store.ts";

/** At least 32 random bytes, base64url. */
export const VERIFY_NONCE = /^[A-Za-z0-9_-]{43,128}$/u;

export const fingerprint = (nonce: string, value: unknown): string => createHmac("sha256", nonce).update(canonicalJson(value)).digest("hex");

/** Each saved login, by the key Send to My Cloud compares it under, and 1Password's token. */
export function loginFingerprints(nonce: string, store: Pick<LoginStore, "changes" | "get" | "onePasswordToken">): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { id } of store.changes()) {
    const login = store.get(id);
    if (!login) continue;
    out[itemKey.login(login.site, login.username, login.exactHost ? login.hosts[0] : undefined)] = fingerprint(nonce, { password: login.password, totp: login.totp ?? null });
  }
  const token = store.onePasswordToken();
  if (token) out[itemKey.onePassword()] = fingerprint(nonce, { token });
  return out;
}
