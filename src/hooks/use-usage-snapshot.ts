import { useEffect, useRef } from "react";
import { preloadConnectedApps } from "@/components/PluginsPanel";
import { localDesktopPage } from "@/components/onboarding/WelcomeGate";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { sendDailySnapshot, SNAPSHOT_CHECK_MS, snapshotReady, type UsageSources } from "@/lib/usage-snapshot";
import { api, useStore, type ConfigStatus } from "@/state/store";

type CompanionDevices = { state(): Promise<{ devices?: unknown }> };

function browserSources(config: ConfigStatus | null): UsageSources {
  const ogb = window.ogb;
  const remoteClient = ogb?.remoteClient?.active === true;
  const local = !remoteClient && localDesktopPage();
  const companion = (globalThis as { ogb?: { companion?: CompanionDevices } }).ogb?.companion ?? null;
  return {
    // Background reads: the daily snapshot is nobody using a Cloud home (src/state/api.ts).
    request: (path) => api(path, { background: true }),
    connectedApps: () => preloadConnectedApps(false, true),
    companion: local ? companion : null,
    cloudAccount: local ? ogb?.cloudAccount ?? null : null,
    cloudPlan: !remoteClient && !local && config?.cloudHome === true ? ogb?.cloudPlan ?? null : null,
    platform: navigator.userAgent.includes("Electron") ? "desktop" : "browser",
    remoteClient,
  };
}

/** The owner's daily usage snapshot: checked once the app is ready, then hourly, and sent at most once per UTC day. */
export function useUsageSnapshot(): void {
  const { state } = useStore();
  const owner = useOwnerOrAdmin();
  const latest = useRef(state);
  useEffect(() => {
    latest.current = state;
  });
  const ready = owner === true && snapshotReady(state, window.ogb?.remoteClient?.active !== true);
  useEffect(() => {
    if (!ready) return;
    const check = () => void sendDailySnapshot(latest.current, browserSources(latest.current.config));
    check();
    const timer = setInterval(check, SNAPSHOT_CHECK_MS);
    return () => clearInterval(timer);
  }, [ready]);
}
