import { useSyncExternalStore } from "react";

import type { PublishedApp, PublishedAppsList } from "../../shared/published-apps";
import { api } from "@/state/api";
import { knownPublishedApps, onPublishedAppsChange, rememberPublishedApps } from "./published-apps";

/** The list is read at most this often; a request inside that time waits for its end. */
const REFRESH_EVERY_MS = 15_000;
let loading = false, loadedAt = 0, later: ReturnType<typeof setTimeout> | null = null;
const asked = new Set<string>();

async function load(): Promise<void> {
  loading = true;
  const list = await Promise.resolve().then(() => api<PublishedAppsList>("/api/published-apps", { background: true })).catch(() => null);
  if (Array.isArray(list?.apps)) rememberPublishedApps(list.apps);
  loading = false;
  loadedAt = Date.now();
}

/** Reads the viewer's Published apps list again, soon: now, or once the last read is old enough. */
export function refreshPublishedApps(): void {
  if (loading || later) return;
  const wait = loadedAt + REFRESH_EVERY_MS - Date.now();
  if (wait <= 0) { void load(); return; }
  later = setTimeout(() => { later = null; void load(); }, wait);
}

/** A reply linked a site the list doesn't hold, perhaps one a bot has just published: the list is read again, once
 * for each such link, so a link to someone else's site never keeps asking. */
export function askAboutSite(href: string): void {
  if (asked.has(href)) return;
  asked.add(href);
  refreshPublishedApps();
}

export function useKnownPublishedApps(): readonly PublishedApp[] {
  return useSyncExternalStore(onPublishedAppsChange, knownPublishedApps, knownPublishedApps);
}
