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
export interface SavedCookie {
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
    // A partitioned cookie stays partitioned, in either of the shapes Chrome has saved it in (an object, or a site's text).
    ...((cookie.partitionKey && typeof cookie.partitionKey === "object") || (typeof cookie.partitionKey === "string" && cookie.partitionKey)
      ? { partitionKey: cookie.partitionKey } : {}),
  };
}

/** A cookie's identity: Chrome keeps one per name, domain, path and partition. */
export const cookieId = (cookie: SavedCookie): string =>
  JSON.stringify([cookie.name, cookie.domain, cookie.path, cookie.partitionKey ?? null]);

/** The cookies a session changed: those it set or changed since `baseline`, and the ids of those it removed. */
export function cookieChanges(baseline: readonly SavedCookie[], current: readonly SavedCookie[]) {
  const before = new Map(baseline.map((cookie) => [cookieId(cookie), cookie]));
  const now = new Map(current.map((cookie) => [cookieId(cookie), cookie]));
  const set = [...now.values()].filter((cookie) => {
    const old = before.get(cookieId(cookie));
    return !old || old.value !== cookie.value || old.expires !== cookie.expires;
  });
  const removed = [...before.keys()].filter((id) => !now.has(id));
  return { set, removed };
}

/** The home's cookies with only a session's own changes applied: a cookie the session never touched stays as the home has it. */
export function mergeCookies(home: readonly unknown[], changes: ReturnType<typeof cookieChanges>): SavedCookie[] {
  const merged = new Map(home.filter(isSavedCookie).map((cookie) => [cookieId(cookie), cookie]));
  for (const id of changes.removed) merged.delete(id);
  for (const cookie of changes.set) merged.set(cookieId(cookie), cookie);
  return [...merged.values()].slice(0, MAX_COOKIES);
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

/** The home's saved sign-ins made the sandbox profile's, the home being the newer: the profile's cookies are cleared first
 * (so a site signed out of in the home stays signed out), then each cookie is set on its own, so one Chrome refuses (a
 * SameSite=None one without Secure, say) is skipped and counted instead of failing the rest. Then, as best it can, each
 * site's local storage through one blank page of its own (Chrome may want a page of that site first; a site it refuses
 * keeps its cookies). Returns the cookies now in the profile from the home's copy. */
export async function carryIn(cdp: Cdp, state: { cookies: readonly unknown[]; origins: readonly unknown[] }): Promise<{ cookies: number; refused: number; origins: number; set: SavedCookie[] }> {
  const saved = state.cookies.filter(isSavedCookie).slice(0, MAX_COOKIES);
  await cdp.send("Storage.clearCookies", {});
  const set: SavedCookie[] = [];
  let refused = 0;
  for (const cookie of saved) {
    try {
      await cdp.send("Storage.setCookies", { cookies: [cookieParam(cookie)] });
      set.push(cookie);
    } catch {
      refused += 1;
    }
  }
  const cookies = set;
  const storage = storageOf(state.origins);
  let carried = 0;
  if (storage.length) {
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank", background: true }).catch(() => ({})) as { targetId?: string };
    if (typeof targetId !== "string") return { cookies: cookies.length, refused, origins: 0, set };
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
  return { cookies: cookies.length, refused, origins: carried, set };
}

/** The sandbox's cookies as the home saves them (Chrome's own shape, as agent-browser writes it), at most MAX_COOKIES. */
export async function carryOut(cdp: Cdp): Promise<SavedCookie[]> {
  const { cookies } = await cdp.send("Storage.getCookies", {}) as { cookies?: unknown[] };
  return (cookies ?? []).filter(isSavedCookie).slice(0, MAX_COOKIES);
}
