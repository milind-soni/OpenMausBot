// Cache entries stored under an old one-year immutable policy outlive no-store and could replay to another identity in this profile.
import fs from "node:fs";
import path from "node:path";

const versionFile = (userData) => path.join(userData, "last-run-version.json");

export function readLastRunVersion(userData) {
  try {
    const parsed = JSON.parse(fs.readFileSync(versionFile(userData), "utf8"));
    return typeof parsed?.version === "string" ? parsed.version.slice(0, 256) : null;
  } catch {
    return null;
  }
}

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
    }
    return false;
  }
}

/** An unknown persisted version evicts too: fail toward clearing once rather than trusting the old cache. */
export function startupCacheEvictionDecision({ currentVersion, persistedVersion }) {
  if (typeof currentVersion !== "string" || currentVersion === "") {
    return { evict: false, reason: "unknown-version" };
  }
  if (persistedVersion === null) return { evict: true, reason: "no-persisted-version" };
  if (persistedVersion === currentVersion) return { evict: false, reason: "same-version" };
  return { evict: true, reason: "version-change" };
}

/** The new version is remembered only after a successful clear, so a failed clear retries next launch. */
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
