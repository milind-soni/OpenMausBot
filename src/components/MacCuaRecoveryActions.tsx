import { useState } from "react";
import { missingMacCuaPermissions, type MacCuaPermission } from "@/lib/mac-cua-permissions";
import { t } from "@/lib/i18n";
import { useDesktopCapabilities } from "./DesktopCapabilities";

const paneName: Record<MacCuaPermission, "computer.mac.permission.screenSettings" | "computer.mac.permission.accessibilitySettings"> = {
  screen: "computer.mac.permission.screenSettings",
  accessibility: "computer.mac.permission.accessibilitySettings",
};

export function MacCuaRecoveryActions({ reason }: { reason: string }) {
  const { capabilities, ready } = useDesktopCapabilities();
  const permissions = missingMacCuaPermissions(reason);
  const currentPermissions = missingMacCuaPermissions(capabilities.localComputer.message);
  const [error, setError] = useState<string | null>(null);
  if (!permissions.length || permissions.join(",") !== currentPermissions.join(",") ||
      !ready || capabilities.host.platform !== "darwin" ||
      capabilities.localComputer.available !== false || capabilities.localComputer.reasonCode === "remote-server" ||
      typeof window.ogb?.permOpenSettings !== "function") return null;

  const openSettings = async (permission: MacCuaPermission) => {
    try {
      await window.ogb?.permOpenSettings(permission);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const relaunch = async () => {
    try {
      await window.ogb?.relaunch?.();
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {permissions.map((permission) => (
        <button key={permission} type="button" onClick={() => void openSettings(permission)}
          className="rounded-full border border-current/30 px-2.5 py-1 text-[12.5px] hover:bg-danger/15">
          {t(paneName[permission])}
        </button>
      ))}
      {typeof window.ogb.relaunch === "function" && (
        <button type="button" onClick={() => void relaunch()}
          className="rounded-full border border-current/30 px-2.5 py-1 text-[12.5px] hover:bg-danger/15">
          {t("computer.mac.permission.relaunch")}
        </button>
      )}
      {error && <span role="alert" className="w-full text-[12px]">{error}</span>}
    </div>
  );
}
