// Curated apps (GET /api/apps), shared by the Apps screen, the composer's
// +app picker and message chips. One module-level copy, refreshed on demand.
import { useEffect, useSyncExternalStore } from "react";
import { api } from "@/state/store";

export type AppState = "ready" | "needs_setup" | "not_running" | "error";

export interface AppInfo {
  id: string;
  name: string;
  maker: string;
  blurb: string;
  category: string;
  /** Path to the app's bundled icon. */
  icon?: string;
  capabilities: string[];
  setupSteps: string[];
  auth: { kind: "bearer"; label: string; help: string };
  defaultEndpoint: string;
  settings: { endpoint: string; customEndpoint: boolean; tokenConfigured: boolean };
  status: { state: AppState; message: string; toolCount: number; checkedAt: number };
}

let apps: AppInfo[] | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function set(next: AppInfo[]) {
  apps = next;
  for (const listener of listeners) listener();
}

/** Re-check every app. `live` forces a fresh network check instead of the server's short cache. */
export function refreshApps(live = false): Promise<void> {
  if (loading && !live) return loading;
  const run = api(`/api/apps${live ? "?refresh=1" : ""}`)
    .then((r) => set(r.apps ?? []))
    .finally(() => {
      if (loading === run) loading = null;
    });
  loading = run;
  return run;
}

/** Replace the list from a save/disconnect response (which returns the fresh list). */
export function setApps(next: AppInfo[]) {
  set(next);
}

export function useApps(): AppInfo[] | null {
  const value = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => apps,
  );
  useEffect(() => {
    if (apps === null) void refreshApps().catch(() => {});
  }, []);
  return value;
}

export const APP_STATE_LABEL: Record<AppState, string> = {
  ready: "Ready",
  needs_setup: "Needs setup",
  not_running: "Not running",
  error: "Unavailable",
};
