// Evict stale HTTP-cache entries once, when the app version changes.
//
// Attachment responses used to ship `cache-control: private, max-age=31536000,
// immutable`. Switching the server to `no-store` stops new storage but cannot
// recall what a profile already cached under that one-year policy, and the
// desktop viewer authorizes attachment requests with a bearer header on
// stable URLs — so a cached 200 could replay to a second identity in the
// same profile without the visibility gate re-running. The bounded migration
// for exactly that handoff is: the first launch of each new version empties
// the default session's HTTP cache before any window opens.
import fs from "node:fs";
import path from "node:path";

const versionFile = (userData) => path.join(userData, "last-run-version.json");

/** The version this profile last ran. Unknown — missing, corrupt, or a
 * non-string record — reads as null, never as "same as this build". */
export function readLastRunVersion(userData) {
  try {
    const parsed = JSON.parse(fs.readFileSync(versionFile(userData), "utf8"));
    return typeof parsed?.version === "string" ? parsed.version.slice(0, 256) : null;
  } catch {
    return null;
  }
}

/** Temp-and-rename, so a crash mid-write never leaves a truncated file. */
export function rememberLastRunVersion(userData, version) {
  const file = versionFile(userData);
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify({ version }, null, 2));
    fs.renameSync(temporary, file);
    return true;
  } catch {
    try {
      fs.unlinkSync(temporary);
    } catch {
      /* never created, or already renamed */
    }
    return false;
  }
}

/** Pure, so the eviction policy can be tested without Electron. Evict when
 * the persisted version is not exactly this build's: a null persisted value
 * (first run, or an unreadable record) evicts too, because an unknown prior
 * state must fail toward clearing once rather than trusting the old cache. */
export function startupCacheEvictionDecision({ currentVersion, persistedVersion }) {
  if (typeof currentVersion !== "string" || currentVersion === "") {
    return { evict: false, reason: "unknown-version" };
  }
  if (persistedVersion === null) return { evict: true, reason: "no-persisted-version" };
  if (persistedVersion === currentVersion) return { evict: false, reason: "same-version" };
  return { evict: true, reason: "version-change" };
}

/**
 * The boot migration. `deps`:
 * - userData: string — the app's userData directory
 * - currentVersion: string — this build's version (app.getVersion())
 * - clearCache(): Promise — session.defaultSession.clearCache()
 * - readVersion(userData) / rememberVersion(userData, version) — optional persistence;
 *   defaults to the exported file-backed pair, overridable for tests
 * - log(line) — optional
 *
 * The new version is remembered only after a successful clear: if clearing
 * fails, the old record stands and the next launch retries the eviction.
 */
// Persistence defaults to the file-backed pair above so a caller that wires
// only userData/currentVersion/clearCache/log still boots: a call site that
// once omitted it threw a TypeError before the cache cleared or any window
// opened.
export async function evictStartupCacheOnce({
  userData,
  currentVersion,
  clearCache,
  readVersion = readLastRunVersion,
  rememberVersion = rememberLastRunVersion,
  log,
}) {
  const persistedVersion = readVersion(userData);
  const decision = startupCacheEvictionDecision({ currentVersion, persistedVersion });
  if (decision.evict) {
    try {
      await clearCache();
    } catch (error) {
      log?.(`startup HTTP cache clear failed (${decision.reason}): ${error?.message ?? error}`);
      return { ...decision, cleared: false, remembered: false };
    }
    log?.(`startup HTTP cache cleared (${decision.reason}: ${persistedVersion ?? "unknown"} -> ${currentVersion})`);
  }
  const remembered = rememberVersion(userData, currentVersion);
  if (!remembered) log?.("could not record the last-run version; the startup cache clear will repeat next launch");
  return { ...decision, cleared: decision.evict, remembered };
}
