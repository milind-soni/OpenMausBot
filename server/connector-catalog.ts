import { randomUUID } from "node:crypto";

import { parseCatalogResponse, SCIENCE_TEASER, type CatalogResponse } from "../shared/connector-catalog.ts";
import {
  applyIncludedScienceMessage,
  applyIncludedXMessage,
  scienceAccessRevision,
  scienceHomeCredential,
} from "./included-services.ts";

const REFRESH_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 64 * 1024;

let served: CatalogResponse | null = null;
let revision = 0;
let lastFetchAt: number | null = null;
let inflight: Promise<void> | null = null;

const hasScience = (catalog: CatalogResponse): boolean => catalog.sections.some((s) => s.id === "science");

/** `{ type: "openmausbot:science-catalog", catalog: unknown | null }` from the desktop's main process. True when it
 * was one (then applied; null returns to the teaser), false for any other message; a malformed catalog throws and
 * keeps the previous one. */
export function applyScienceCatalogMessage(message: unknown): boolean {
  if (!message || typeof message !== "object" || (message as { type?: unknown }).type !== "openmausbot:science-catalog") return false;
  const catalog = (message as { catalog?: unknown }).catalog;
  if (catalog === null) {
    served = null;
  } else {
    const parsed = parseCatalogResponse(catalog);
    if (!parsed) throw new Error("invalid science catalog");
    served = parsed;
  }
  revision += 1;
  return true;
}

export const catalogRevision = (): number => revision;

/** The private parent-port messages that carry included services and the catalog. */
export function applyIncludedMessage(message: unknown): boolean {
  return applyIncludedXMessage(message) || applyIncludedScienceMessage(message) || applyScienceCatalogMessage(message);
}

const BOOT = randomUUID();

/** Changes whenever the science access or the catalog this server holds changes, and with every server start. */
export const scienceStatus = (): { revision: string } => ({ revision: `${BOOT}.${scienceAccessRevision() + revision}` });

async function readCapped(response: Response): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The token goes only to `{relay base}/catalog`. Anything but a 200 with a parseable catalog counts as unreachable. */
async function refreshFromCloud(api: string, token: string): Promise<void> {
  try {
    const response = await fetch(`${api}/catalog`, {
      headers: { authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (response.status !== 200) return;
    const text = await readCapped(response);
    if (text === null) return;
    const parsed = parseCatalogResponse(JSON.parse(text));
    if (!parsed) return;
    if (JSON.stringify(parsed) !== JSON.stringify(served)) revision += 1;
    served = parsed;
  } catch {
    // Unreachable: the last good catalog stays.
  }
}

/** The served catalog (locked or not), else the teaser; `served` says which. A served catalog without a science
 * section is not shown as an empty one. */
export async function connectorCatalog(now: number = Date.now()): Promise<{ catalog: CatalogResponse; served: boolean }> {
  const home = scienceHomeCredential();
  if (home && (lastFetchAt === null || now - lastFetchAt >= REFRESH_MS)) {
    lastFetchAt = now;
    inflight ??= refreshFromCloud(home.api, home.token).finally(() => {
      inflight = null;
    });
    await inflight;
  } else if (inflight) {
    await inflight;
  }
  return served && hasScience(served) ? { catalog: served, served: true } : { catalog: SCIENCE_TEASER, served: false };
}
