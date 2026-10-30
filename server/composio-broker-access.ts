// Where connected apps go without a project key: the managed connected-apps
// service (the desktop app hands its URL and token over; a Cloud computer reads
// them from the environment). `composio.ts` re-exports these.
import { z } from "zod";

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
  if (managedBrokerAccess !== undefined) return managedBrokerAccess;
  const url = process.env.OMB_COMPOSIO_BROKER_URL?.trim();
  const token = process.env.OMB_COMPOSIO_BROKER_TOKEN?.trim();
  if (!url || !token) return null;
  if (!managedBrokerToken.test(token)) throw new Error("The connected-apps service token is invalid");
  return { url: normalizeManagedBrokerUrl(url), token };
}
