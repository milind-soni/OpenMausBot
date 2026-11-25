// A bot's sign-ins follow it between the home's browser and its profile in the Cloud's browser sandbox. The home keeps
// them in agent-browser's encrypted restore file (browser-sites.ts reads and writes it); the sandbox's Chrome keeps them in
// its own profile. They travel only over the session's own DevTools connection, through the authenticated door: never
// through a file another bot's Chrome could read, and never into a log.
import type { Cdp } from "../browser-sites.ts";

/** At most this many cookies, and this much storage, move either way at once: a sign-in fits many times over. */
export const MAX_COOKIES = 3_000;
export const MAX_STORAGE_ORIGINS = 200;
const MAX_STORAGE_BYTES = 5 * 1024 * 1024;

/** A cookie as agent-browser saves it: Chrome's own (`Network.getAllCookies`), so `session` marks one with no expiry. */
interface SavedCookie {
  name: string; value: string; domain: string; path: string; expires?: number; httpOnly?: boolean; secure?: boolean;
  session?: boolean; sameSite?: string; partitionKey?: unknown; sourceScheme?: string; sourcePort?: number; priority?: string;
}

const isSavedCookie = (value: unknown): value is SavedCookie => {
  const cookie = value as Partial<SavedCookie> | null;
  return typeof cookie?.name === "string" && typeof cookie.value === "string" && typeof cookie.domain === "string" && typeof cookie.path === "string";
};

/** Chrome's CookieParam for `Storage.setCookies`: a session cookie stays one. */
export function cookieParam(cookie: SavedCookie): Record<string, unknown> {
  const sameSite = cookie.sameSite === "Strict" || cookie.sameSite === "Lax" || cookie.sameSite === "None" ? cookie.sameSite : undefined;
  const expires = cookie.session || typeof cookie.expires !== "number" || cookie.expires < 0 ? undefined : cookie.expires;
  return {
    name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path,
    ...(cookie.secure === true ? { secure: true } : {}), ...(cookie.httpOnly === true ? { httpOnly: true } : {}),
    ...(sameSite ? { sameSite } : {}), ...(expires !== undefined ? { expires } : {}),
    ...(cookie.partitionKey && typeof cookie.partitionKey === "object" ? { partitionKey: cookie.partitionKey } : {}),
  };
}

interface Storage { origin: string; items: Array<{ name: string; value: string }> }

function storageOf(origins: readonly unknown[]): Storage[] {
  let bytes = 0;
  const kept: Storage[] = [];
  for (const entry of origins.slice(0, MAX_STORAGE_ORIGINS)) {
    const origin = (entry as { origin?: unknown }).origin;
    const items = (entry as { localStorage?: unknown }).localStorage;
    if (typeof origin !== "string" || !/^https?:\/\//.test(origin) || !Array.isArray(items)) continue;
    const pairs = items.filter((item): item is { name: string; value: string } => typeof item?.name === "string" && typeof item?.value === "string");
    bytes += pairs.reduce((sum, item) => sum + item.name.length + item.value.length, 0);
    if (bytes > MAX_STORAGE_BYTES) break;
    if (pairs.length) kept.push({ origin, items: pairs });
  }
  return kept;
}

/** The home's saved sign-ins set in the sandbox's Chrome: every cookie, then, as best it can, each site's local storage
 * through one blank page of its own (Chrome may want a page of that site first; a site it refuses keeps its cookies). A
 * cookie Chrome refuses fails the carry, so the session opens in the home instead of signed out. */
export async function carryIn(cdp: Cdp, state: { cookies: readonly unknown[]; origins: readonly unknown[] }): Promise<{ cookies: number; origins: number }> {
  const cookies = state.cookies.filter(isSavedCookie).slice(0, MAX_COOKIES).map(cookieParam);
  if (cookies.length) await cdp.send("Storage.setCookies", { cookies });
  const storage = storageOf(state.origins);
  let carried = 0;
  if (storage.length) {
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank", background: true }).catch(() => ({})) as { targetId?: string };
    if (typeof targetId !== "string") return { cookies: cookies.length, origins: 0 };
    try {
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true }) as { sessionId?: string };
      if (typeof sessionId !== "string") throw new Error("no page for the storage carry");
      await cdp.send("DOMStorage.enable", {}, sessionId);
      for (const { origin, items } of storage) {
        try {
          for (const item of items) {
            await cdp.send("DOMStorage.setDOMStorageItem", { storageId: { securityOrigin: origin, isLocalStorage: true }, key: item.name, value: item.value }, sessionId);
          }
          carried += 1;
        } catch {
          // This site's storage stays in the home; its cookies were carried.
        }
      }
    } catch {
      // No page for storage: the cookies were carried.
    } finally {
      await cdp.send("Target.closeTarget", { targetId }).catch(() => undefined);
    }
  }
  return { cookies: cookies.length, origins: carried };
}

/** The sandbox's cookies as the home saves them (Chrome's own shape, as agent-browser writes it), at most MAX_COOKIES. */
export async function carryOut(cdp: Cdp): Promise<unknown[]> {
  const { cookies } = await cdp.send("Storage.getCookies", {}) as { cookies?: unknown[] };
  return (cookies ?? []).filter(isSavedCookie).slice(0, MAX_COOKIES);
}
