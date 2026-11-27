// Nothing secret goes in, and it is for the person's view only: a bot's tool call always uses live state.
import type { ConnectorStatus } from "@/lib/connector-status";

export interface CachedInventory {
  at: number;
  services: Record<string, ConnectorStatus>;
}

export const CONNECTED_APPS_CACHE_KEY = "omb-connected-apps";

/** A private window or blocked site data throws on localStorage access. */
function store(explicit?: Storage): Storage | undefined {
  if (explicit) return explicit;
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseConnectorStatus(value: unknown): ConnectorStatus | null {
  if (!isRecord(value) || typeof value.connected !== "boolean") return null;
  if (value.pending !== undefined && typeof value.pending !== "boolean") return null;
  if (value.status !== undefined && typeof value.status !== "string") return null;

  const status: ConnectorStatus = { connected: value.connected };
  if (value.pending !== undefined) status.pending = value.pending;
  if (value.status !== undefined) status.status = value.status;

  if (value.accounts !== undefined) {
    if (!Array.isArray(value.accounts)) return null;
    const accounts = value.accounts.map((account) => {
      if (
        !isRecord(account) ||
        typeof account.id !== "string" ||
        typeof account.status !== "string" ||
        (account.alias !== undefined && typeof account.alias !== "string")
      ) return null;
      return {
        id: account.id,
        status: account.status,
        ...(account.alias === undefined ? {} : { alias: account.alias }),
      };
    });
    if (accounts.some((account) => account === null)) return null;
    status.accounts = accounts as NonNullable<ConnectorStatus["accounts"]>;
  }
  return status;
}

export function readCachedInventory(explicit?: Storage): CachedInventory | null {
  try {
    const raw = store(explicit)?.getItem(CONNECTED_APPS_CACHE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !isRecord(parsed.services)) return null;
    const services: Record<string, ConnectorStatus> = {};
    for (const [slug, value] of Object.entries(parsed.services)) {
      const status = parseConnectorStatus(value);
      if (!status) return null;
      services[slug] = status;
    }
    return { at: typeof parsed.at === "number" ? parsed.at : 0, services };
  } catch {
    return null;
  }
}

export function writeCachedInventory(
  services: Record<string, ConnectorStatus>,
  now: number,
  explicit?: Storage,
): void {
  try {
    store(explicit)?.setItem(CONNECTED_APPS_CACHE_KEY, JSON.stringify({ at: now, services }));
  } catch {
  }
}
