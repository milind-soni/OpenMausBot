import { useEffect, useState } from "react";
import type { InstanceInfo } from "@/state/store";

const SEEN_KEY = "omb-engine-updated-seen";

function seen(): Record<string, string> {
  try {
    const value = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}") as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, string> : {};
  } catch {
    return {};
  }
}

/** The version the app updated this engine to, from the first time this device shows its card after the update until
 * the card goes away; null otherwise. */
export function useUpdatedOnce(instance: Pick<InstanceInfo, "driverKind" | "autoUpdated">): string | null {
  const version = instance.autoUpdated?.version ?? null;
  const [shown, setShown] = useState<string | null>(null);
  useEffect(() => {
    if (version === null || seen()[instance.driverKind] === version) return;
    setShown(version);
    try {
      localStorage.setItem(SEEN_KEY, JSON.stringify({ ...seen(), [instance.driverKind]: version }));
    } catch {}
  }, [instance.driverKind, version]);
  return shown;
}
