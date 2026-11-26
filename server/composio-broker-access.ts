// Where connected apps go without a project key: the managed connected-apps
// service (the desktop app hands its URL and token over; a Cloud computer reads
// them from the environment). `composio.ts` re-exports these.
import { z } from "zod";

import { managedComposioBrokerOff } from "../electron/managed-composio.mjs";

export { managedComposioBrokerOff };

let managedBrokerAccess: { url: string; token: string } | null | undefined;

const managedBrokerMessageSchema = z.record(z.string(), z.unknown());
const managedBrokerToken = /^[0-9a-f]{64}$/;

function normalizeManagedBrokerUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("The connected-apps service URL must not include credentials, a query, or a fragment");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("The connected-apps service must use HTTPS");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export function applyManagedBrokerMessage(message: unknown): boolean {
  const parsed = managedBrokerMessageSchema.safeParse(message);
  if (
    !parsed.success ||
    parsed.data.type !== "openmausbot:managed-composio" ||
    !Object.hasOwn(parsed.data, "access")
  ) {
    return false;
  }
  setManagedBrokerAccess(parsed.data.access);
  return true;
}

export function setManagedBrokerAccess(access: unknown): void {
  if (access === null) {
    managedBrokerAccess = null;
    return;
  }
  const parsed = z.object({ url: z.string().url(), token: z.string().regex(managedBrokerToken) }).strict().parse(access);
  managedBrokerAccess = { url: normalizeManagedBrokerUrl(parsed.url), token: parsed.token };
}

export type BrokerAccess = { url: string; token: string }; // `as` below: a Team Cloud member's own installation, never a project key
export function brokerAccess(): BrokerAccess | null {
  if (managedComposioBrokerOff()) return null;
  if (managedBrokerAccess !== undefined) return managedBrokerAccess;
  const url = process.env.OMB_COMPOSIO_BROKER_URL?.trim();
  const token = process.env.OMB_COMPOSIO_BROKER_TOKEN?.trim();
  if (!url || !token) return null;
  if (!managedBrokerToken.test(token)) throw new Error("The connected-apps service token is invalid");
  return { url: normalizeManagedBrokerUrl(url), token };
}

const ERASE_MAX_CALLS = 40;
const ERASE_CALL_TIMEOUT_MS = 120_000;
const eraseResponseSchema = z.object({ erased: z.boolean().optional(), sharedUserKept: z.boolean().optional(), error: z.string().optional() });

/**
 * Erases this installation at the managed service and forgets its token here. A failure throws with the token kept, so
 * the call can be repeated. `clearStored` removes a token this process keeps on disk: a Cloud home's
 * CLOUD_CONNECTED_APPS_FILE. `sharedUserKept` says connected apps stayed because another installation uses them.
 */
export async function eraseManagedBrokerInstallation(clearStored?: () => void): Promise<{ sharedUserKept: boolean }> {
  const access = brokerAccess();
  if (!access) throw new Error("The connected-apps service is unavailable.");
  for (let call = 0; call < ERASE_MAX_CALLS; call += 1) {
    const response = await fetch(`${access.url}/v1/installation`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${access.token}` },
      redirect: "error",
      signal: AbortSignal.timeout(ERASE_CALL_TIMEOUT_MS),
    });
    if (response.status === 202) { await response.body?.cancel(); continue; }
    const body = eraseResponseSchema.safeParse(await response.json().catch(() => null));
    // 401: the token is already dead, as when an earlier call's answer was lost.
    if (response.status === 401 || (response.ok && body.data?.erased === true)) {
      setManagedBrokerAccess(null);
      clearStored?.();
      return { sharedUserKept: body.data?.sharedUserKept === true };
    }
    throw new Error(body.data?.error ?? `The connected-apps service did not erase this installation (HTTP ${response.status}).`);
  }
  throw new Error("The connected-apps service did not finish erasing this installation. Try again.");
}
