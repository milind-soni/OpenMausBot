// Which side changed a bot's sign-ins since the home and its sandbox profile last agreed. At each sync both sides are
// remembered as fingerprints (one short hash of each cookie's value and attributes, by cookie): never a cookie's value.
// The rules, so that no sign-in a person made is ever lost:
// - at an open, the sandbox profile's cookies the home never saw (made in a session that ended without a clean close: the
//   provider's auto-stop, the Admin's stop, a home that slept) are added to the home's copy, and the home's newer copy is
//   the truth for everything else: a sign-out made in the home stays one;
// - a cookie missing from the sandbox at an open is never a removal: Chrome drops session cookies on a restart and evicts
//   cookies past its per-site limit by itself. Only a removal seen during a session, against what Chrome really held at
//   its start, removes a cookie from the home;
// - when both sides changed the same cookie since they last agreed, the home's wins.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { cookieId, MAX_COOKIES, type SavedCookie } from "./sign-ins.ts";

export type Prints = Record<string, string>;
export interface SyncState { home: Prints; sandbox: Prints }

const isCookie = (value: unknown): value is SavedCookie => {
  const cookie = value as Partial<SavedCookie> | null;
  return typeof cookie?.name === "string" && typeof cookie.value === "string" && typeof cookie.domain === "string" && typeof cookie.path === "string";
};

/** A cookie's value and attributes as one short hash, so a change is seen and no value is kept. */
export function fingerprint(cookie: SavedCookie): string {
  const expires = cookie.session || typeof cookie.expires !== "number" || cookie.expires < 0 ? -1 : Math.round(cookie.expires);
  return createHash("sha256").update(JSON.stringify([cookie.value, expires, cookie.httpOnly === true, cookie.secure === true, cookie.sameSite ?? null])).digest("hex").slice(0, 16);
}

export function prints(cookies: readonly unknown[]): Prints {
  const out: Prints = {};
  for (const cookie of cookies) if (isCookie(cookie)) out[cookieId(cookie)] = fingerprint(cookie);
  return out;
}

const byId = (cookies: readonly unknown[]) => new Map(cookies.filter(isCookie).map((cookie) => [cookieId(cookie), cookie]));

/** The home changed this cookie since the last sync (changed it, or removed it): the home's side wins it. */
function homeChanged(id: string, home: Map<string, SavedCookie>, last: SyncState | null): boolean {
  if (!last) return home.has(id);
  const was = last.home[id];
  const now = home.get(id);
  return now ? was !== fingerprint(now) : was !== undefined;
}

/** At an open: the home's copy, with the cookies the sandbox profile set or changed since the last sync that the home did not change. */
export function mergeAtOpen(homeCookies: readonly unknown[], sandboxCookies: readonly SavedCookie[], last: SyncState | null): { merged: SavedCookie[]; fromSandbox: number } {
  const home = byId(homeCookies);
  const merged = new Map(home);
  let fromSandbox = 0;
  for (const cookie of sandboxCookies) {
    const id = cookieId(cookie);
    const changedInSandbox = last ? last.sandbox[id] !== fingerprint(cookie) : !home.has(id);
    if (!changedInSandbox || homeChanged(id, home, last)) continue;
    const kept = home.get(id);
    if (kept && fingerprint(kept) === fingerprint(cookie)) continue;
    merged.set(id, cookie);
    fromSandbox += 1;
  }
  return { merged: [...merged.values()].slice(0, MAX_COOKIES), fromSandbox };
}

/** During a session: the home's copy with the session's own changes since `baseline` (what Chrome really held), removals
 * included, except a cookie the home changed since the last sync. */
export function mergeInSession(homeCookies: readonly unknown[], baseline: readonly SavedCookie[], current: readonly SavedCookie[], last: SyncState | null): { merged: SavedCookie[]; changed: number } {
  const home = byId(homeCookies);
  const before = byId(baseline);
  const now = byId(current);
  const merged = new Map(home);
  let changed = 0;
  for (const [id, cookie] of now) {
    const was = before.get(id);
    if (was && fingerprint(was) === fingerprint(cookie)) continue;
    if (last && homeChanged(id, home, last)) continue;
    merged.set(id, cookie);
    changed += 1;
  }
  for (const id of before.keys()) {
    if (now.has(id) || (last && homeChanged(id, home, last))) continue;
    if (merged.delete(id)) changed += 1;
  }
  return { merged: [...merged.values()].slice(0, MAX_COOKIES), changed };
}

/** Whether the sandbox already holds what the merge asks of it: the same cookies, the same values. A cookie Chrome would
 * not keep before (in the home at the last sync, absent from the sandbox then and now, unchanged in the home) is not asked
 * again, so a per-site cap does not cost a carry at every open. */
export function sandboxHolds(merged: readonly SavedCookie[], sandbox: readonly SavedCookie[], last: SyncState | null): boolean {
  const have = prints(sandbox);
  for (const cookie of merged) {
    const id = cookieId(cookie);
    const print = fingerprint(cookie);
    if (have[id] === print) continue;
    const notKept = last && have[id] === undefined && last.sandbox[id] === undefined && last.home[id] === print;
    if (!notKept) return false;
  }
  const wanted = new Set(merged.map(cookieId));
  return Object.keys(have).every((id) => wanted.has(id));
}

/** The remembered fingerprints of each sandbox and bot (`<box id>:<key>`), a file each, with no cookie value in it. */
export function syncStore(dir: string) {
  const file = (stamp: string) => join(dir, `${stamp.replace(":", "-")}.json`);
  const valid = (stamp: string) => /^bx_[a-z0-9]{8}:[a-f0-9]{16}$/.test(stamp);
  return {
    load(stamp: string): SyncState | null {
      if (!valid(stamp)) return null;
      try {
        const saved = JSON.parse(readFileSync(file(stamp), "utf8")) as Partial<SyncState>;
        return saved.home && saved.sandbox && typeof saved.home === "object" && typeof saved.sandbox === "object" ? { home: saved.home, sandbox: saved.sandbox } : null;
      } catch {
        return null;
      }
    },
    save(stamp: string, state: SyncState): void {
      if (!valid(stamp)) return;
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const temporary = `${file(stamp)}.tmp`;
        writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
        renameSync(temporary, file(stamp));
      } catch {
        // Without it the next open treats the sandbox as new: only cookies the home lacks are taken from it.
      }
    },
    /** A deleted bot's: every sandbox's record of its profile. */
    forget(key: string): void {
      try {
        for (const name of readdirSync(dir)) if (name.endsWith(`-${key}.json`)) rmSync(join(dir, name), { force: true });
      } catch {
        // None yet.
      }
    },
  };
}
export type SyncStore = ReturnType<typeof syncStore>;
