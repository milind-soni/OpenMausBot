// A Cloud home that woke (or started) says so to the Admin at once, signed with its machine secret, so the Admin's word
// on it (the session's `cloud.power`) moves on at the desktops' next read, not a minute later at the Admin's next read
// of this home: a desktop that lends to it stops calling while it sleeps. docs/cloud-pro.md, "Sleeping homes". An older
// Admin answers 404 and nothing changes; this never retries.
import { createHash, createHmac, randomBytes } from "node:crypto";

export const WOKE_ADMIN_PATH = "/api/cloud/machines/woke";
const WOKE_TIMEOUT_MS = 5_000;

export function wokeSignature(secret: string, machineId: string, timestamp: string, nonce: string, body: string): string {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  return createHmac("sha256", secret).update(`omb-power-woke-v1\n${machineId}\n${timestamp}\n${nonce}\n${bodyHash}`).digest("base64url");
}

export function createWokeNotifier(options: {
  adminOrigin: string; machineId: string; secret: string; fetcher?: typeof fetch; now?: () => number; log?: (line: string) => void;
}): () => void {
  const { adminOrigin, machineId, secret, fetcher = fetch, now = Date.now, log } = options;
  let warned = false;
  return () => {
    const body = JSON.stringify({ v: 1, wokeAt: now() });
    const timestamp = String(Math.floor(now() / 1000)), nonce = randomBytes(18).toString("base64url");
    void fetcher(`${adminOrigin}${WOKE_ADMIN_PATH}`, { method: "POST", redirect: "error", cache: "no-store", body, signal: AbortSignal.timeout(WOKE_TIMEOUT_MS), headers: {
      accept: "application/json", "content-type": "application/json", "x-omb-cloud-machine": machineId, "x-omb-cloud-timestamp": timestamp, "x-omb-cloud-nonce": nonce,
      "x-omb-cloud-signature": `v1=${wokeSignature(secret, machineId, timestamp, nonce, body)}`,
    } }).then(async (response) => {
      await response.body?.cancel().catch(() => {});
      if (!response.ok && response.status !== 404 && !warned) { warned = true; log?.(`cloud power: the Admin answered HTTP ${response.status} to the wake notice`); }
    }, (error: unknown) => {
      if (!warned) { warned = true; log?.(`cloud power: could not reach the Admin with the wake notice (${error instanceof Error ? error.name : "error"})`); }
    });
  };
}
