import { parseStoredConfig } from "./config.ts";

// Connection sections deliberately stay on the destination as a whole: a
// restored URL must never redirect an API key retained from that device.
// Allowlisting ordinary settings also keeps future/unknown auth fields out.
const PORTABLE_CONFIG_KEYS = [
  "profile", "language", "budgets", "billing", "rooms", "threads",
  "localVm", "features", "browserProfiles",
] as const;

export function portableWorkspaceConfig(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid workspace configuration in backup.");
  const config = parseStoredConfig(value as Parameters<typeof parseStoredConfig>[0]);
  return Object.fromEntries(PORTABLE_CONFIG_KEYS.filter((key) => config[key] !== undefined).map((key) => [key, config[key]]));
}

export function restoredWorkspaceConfig(portable: unknown, destination: unknown): Record<string, unknown> {
  if (!destination || typeof destination !== "object" || Array.isArray(destination)) throw new Error("Invalid destination workspace configuration; connections were not changed.");
  const merged = { ...destination } as Record<string, unknown>;
  for (const key of PORTABLE_CONFIG_KEYS) delete merged[key];
  return { ...merged, ...portableWorkspaceConfig(portable) };
}

/** Exact app-owned authentication paths, not a scan of user document text. */
export function excludedWorkspaceAuthPath(path: string): boolean {
  // Machine/provider-specific execution grants are not portable template data.
  if (/^command-allowlist\.json(?:$|\.\d+\.[0-9a-f-]+\.tmp$)/.test(path)) return true;
  return /^(?:(?:providers|caddy|chrome-profile|\.agent-browser)(?:\/|$)|workspace-credentials\.json$|external-runtimes\.json$|browser-engine-key$)/.test(path) ||
    /^(?:config\.json|webhooks\.json|workspace-credentials\.json|external-runtimes\.json|browser-engine-key|sessions\.json|tunnel-account\.json)\.\d+(?:\.[0-9a-f-]+)?\.tmp$/.test(path) ||
    /^(?:vm-home|vm-homes\/[^/]+)\/\.browser-profiles(?:\/|$)/.test(path);
}

/** The Organization library files Electron main downloads and verifies
 * (docs/desktop-library.md): the catalog, a catalog write in progress, and the
 * cached release files. Main fetches them again from Admin, and sign-out
 * deletes them, so a backup never keeps an Organization's package bytes. The
 * runtime's own `org-library/state.json` and `presets.json` are backed up. Like
 * the hook tokens below, an archive that holds them still restores. */
export function redownloadedOrgLibraryPath(path: string): boolean {
  return /^org-library\/(?:catalog\.json(?:\.[0-9a-f-]{36}\.tmp)?$|blobs(?:\/|$))/.test(path);
}

/** Per-turn engine hook bearers (`hook-tokens/<digest>.token`, written by the
 * Claude driver). They are dead once their turn settles, so they are never
 * exported. Unlike the saved auth paths above they are not refused on import:
 * v0.1.85 did export them, and such a backup must still restore, without them. */
export function ephemeralWorkspaceTokenPath(path: string): boolean {
  return /^hook-tokens(?:\/|$)/.test(path);
}
