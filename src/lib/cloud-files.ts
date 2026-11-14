import { useEffect, useState } from "react";
import type { CloudFilesBridge, CloudFilesState } from "../../electron/cloud-sync.mjs";

/** Files lives in this computer's own window: a companion connected to another computer has none. */
export function cloudFilesBridge(): CloudFilesBridge | undefined {
  return window.ogb?.remoteClient?.active ? undefined : window.ogb?.cloudAccount?.files;
}

/** Main's Files state, kept current; null until main answers (and when main can't). */
export function useCloudFiles(bridge: CloudFilesBridge | undefined) {
  const [state, setState] = useState<CloudFilesState | null>(null);
  useEffect(() => {
    if (!bridge) return;
    let live = true, pushed = false;
    const off = bridge.onState((next) => { pushed = true; if (live) setState(next); });
    void bridge.state().then((next) => { if (live && !pushed) setState(next); }).catch(() => {});
    return () => { live = false; off(); };
  }, [bridge]);
  return [state, setState] as const;
}

/** The Files row shows only while main says this app has a Ready My Cloud (signed out or offline included). */
export function useCloudFilesReady(): boolean {
  const [state] = useCloudFiles(cloudFilesBridge());
  return state !== null && state.phase !== "unavailable";
}
