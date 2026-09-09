import { useEffect, useState } from "react";
import { Plus, TabletSmartphone } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { Action } from "@/state/store";
import type { SidebarDensity } from "@/lib/sidebar-preferences";
import { companionBridge, type CompanionState } from "./PhoneSetupFlow";

export const SIDEBAR_PHONE_RECENT_MS = 2 * 60_000;
const SIDEBAR_PHONE_POLL_MS = 15_000;

type SidebarPhoneSnapshot = Pick<
  CompanionState,
  "enabled" | "devices" | "connectedDeviceIds" | "error"
>;

export type SidebarPhoneStatusKind =
  | "checking"
  | "unavailable"
  | "unpaired"
  | "disconnected"
  | "connected"
  | "stale"
  | "recent";

export interface SidebarPhoneStatus {
  kind: SidebarPhoneStatusKind;
  label: string;
  pairedCount: number;
  connectedCount: number;
}

/** Current sidecars report authenticated live event streams, so green means a
 * phone is connected now. The timestamp fallback is deliberately neutral and
 * exists only for an older unpackaged development sidecar. */
export function deriveSidebarPhoneStatus(
  snapshot: SidebarPhoneSnapshot | null | undefined,
  now: number,
): SidebarPhoneStatus {
  if (snapshot === undefined) {
    return { kind: "checking", label: t("sidebar.phone.checking"), pairedCount: 0, connectedCount: 0 };
  }
  if (snapshot === null) {
    return { kind: "unavailable", label: t("sidebar.phone.unavailable"), pairedCount: 0, connectedCount: 0 };
  }

  const pairedCount = snapshot.devices.length;
  if (snapshot.error) {
    return {
      kind: "unavailable",
      label: t("sidebar.phone.unavailable"),
      pairedCount,
      connectedCount: 0,
    };
  }
  if (!snapshot.enabled) {
    return {
      kind: "unavailable",
      label: t("sidebar.phone.off"),
      pairedCount,
      connectedCount: 0,
    };
  }
  if (!pairedCount) {
    return { kind: "unpaired", label: t("sidebar.phone.pair"), pairedCount: 0, connectedCount: 0 };
  }

  if (Array.isArray(snapshot.connectedDeviceIds)) {
    const live = new Set(snapshot.connectedDeviceIds);
    const connectedCount = snapshot.devices.filter((device) => live.has(device.id)).length;
    if (connectedCount) {
      const label = pairedCount === 1
        ? t("sidebar.phone.connectedOne")
        : connectedCount === pairedCount
          ? t("sidebar.phone.connectedAll", { count: pairedCount })
          : t("sidebar.phone.connectedSome", { connected: connectedCount, count: pairedCount });
      return { kind: "connected", label, pairedCount, connectedCount };
    }
    return {
      kind: "disconnected",
      label:
        pairedCount === 1
          ? t("sidebar.phone.disconnectedOne")
          : t("sidebar.phone.disconnectedMany", { count: pairedCount }),
      pairedCount,
      connectedCount: 0,
    };
  }

  // Compatibility with a sidecar from an older unpackaged development build.
  // Recent activity stays neutral because it is not proof of a live stream.
  const recentCount = snapshot.devices.filter((device) => {
    const age = now - device.lastSeenAt;
    return Number.isFinite(device.lastSeenAt) && age >= 0 && age <= SIDEBAR_PHONE_RECENT_MS;
  }).length;
  if (recentCount) {
    const label = pairedCount === 1
      ? t("sidebar.phone.recentOne")
      : recentCount === pairedCount
        ? t("sidebar.phone.recentAll", { count: pairedCount })
        : t("sidebar.phone.recentSome", { recent: recentCount, count: pairedCount });
    return { kind: "recent", label, pairedCount, connectedCount: 0 };
  }

  return {
    kind: "stale",
    label: pairedCount === 1
      ? t("sidebar.phone.staleOne")
      : t("sidebar.phone.staleMany", { count: pairedCount }),
    pairedCount,
    connectedCount: 0,
  };
}

type ToggleAppSettingsAction = Extract<Action, { type: "toggleAppSettings" }>;

export const phoneSettingsAction = (): ToggleAppSettingsAction => ({
  type: "toggleAppSettings",
  open: true,
  section: "companion",
});

export function useSidebarPhoneStatus(): SidebarPhoneStatus {
  const [snapshot, setSnapshot] = useState<SidebarPhoneSnapshot | null>();

  useEffect(() => {
    const companion = companionBridge();
    if (!companion) {
      setSnapshot(null);
      return;
    }

    let disposed = false;
    let refreshing = false;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const next = await companion.state();
        if (!disposed) setSnapshot(next);
      } catch {
        if (!disposed) setSnapshot(null);
      } finally {
        refreshing = false;
      }
    };

    void refresh();
    const timer = window.setInterval(() => void refresh(), SIDEBAR_PHONE_POLL_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, []);

  return deriveSidebarPhoneStatus(snapshot, Date.now());
}

export function SidebarPhoneStatusButton({
  density,
  status,
  onOpen,
}: {
  density: SidebarDensity;
  status: SidebarPhoneStatus;
  onOpen: () => void;
}) {
  const connected = status.kind === "connected";
  return (
    <button
      type="button"
      onClick={onOpen}
      title={status.label}
      aria-label={status.label}
      data-phone-status={status.kind}
      data-sidebar-density={density}
      className={cn(
        "relative flex size-10 shrink-0 items-center justify-center rounded-md hover:bg-raised",
        density === "icons" && "mx-auto",
        connected ? "text-success" : "text-ink-secondary hover:text-ink",
      )}
    >
      <TabletSmartphone size={18} strokeWidth={1.8} />
      {status.kind === "unpaired" && (
        <span
          aria-hidden="true"
          data-phone-plus
          className="absolute bottom-1 right-1 flex size-3.5 items-center justify-center rounded-full border border-panel bg-panel"
        >
          <Plus size={10} strokeWidth={2.8} />
        </span>
      )}
      {connected && (
        <span
          aria-hidden="true"
          data-phone-connected
          className="absolute bottom-1.5 right-1.5 size-1.5 rounded-full border border-panel bg-success"
        />
      )}
    </button>
  );
}

export function SidebarPhoneButton({
  density,
  onOpen,
}: {
  density: SidebarDensity;
  onOpen: () => void;
}) {
  const status = useSidebarPhoneStatus();
  return <SidebarPhoneStatusButton density={density} status={status} onOpen={onOpen} />;
}
