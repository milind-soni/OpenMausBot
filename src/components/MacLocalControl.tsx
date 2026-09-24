import { useEffect, useState } from "react";
import { AlertTriangle, Loader2, Shield } from "lucide-react";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { macCuaPermissionMessage, missingMacCuaPermissions } from "@/lib/mac-cua-permissions";
import { MacCuaRecoveryActions } from "./MacCuaRecoveryActions";
import { t } from "@/lib/i18n";

export function MacLocalControl() {
  const { capabilities } = useDesktopCapabilities();
  const reason = capabilities.localComputer.available ? null : capabilities.localComputer.message;
  const permissionMessage = macCuaPermissionMessage(missingMacCuaPermissions(reason));
  const [pending, setPending] = useState(false);
  const [awaitingGrant, setAwaitingGrant] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const retry = async () => {
    setPending(true);
    setError(null);
    try {
      await window.ogb?.localControl?.retry();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending(false);
    }
  };

  const openSettings = async () => {
    setError(null);
    setAwaitingGrant(true);
    try {
      await window.ogb?.permOpenSettings?.("accessibility");
      await window.ogb?.permOpenSettings?.("screen");
    } catch (reason) {
      setAwaitingGrant(false);
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  useEffect(() => {
    if (!awaitingGrant) return;
    let used = false;
    const onFocus = () => {
      if (used) return;
      if (document.visibilityState !== "visible") return;
      used = true;
      setAwaitingGrant(false);
      void retry();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [awaitingGrant]);

  if (capabilities.host.platform !== "darwin" || capabilities.localComputer.reasonCode === "remote-server") return null;
  if (capabilities.localComputer.available) return null;

  return (
    <section className="mt-4 rounded-xl border border-warning/25 bg-warning/10 p-4">
      <div className="flex items-start gap-3">
        <Shield size={16} className="mt-0.5 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-medium text-ink">Allow control of this computer</div>
          <p className="mt-1 text-[12.5px] leading-relaxed text-ink-secondary">
            {permissionMessage ?? t("computer.mac.permission.generic")}
          </p>
          {reason && <details className="mt-2 text-[12px] text-ink-secondary"><summary className="cursor-pointer">{t("computer.mac.permission.driverDetail")}</summary><p className="mt-1 break-words">{reason}</p></details>}
          {error && (
            <div className="mt-2 flex gap-1.5 text-[12px] text-danger">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {permissionMessage && reason && <MacCuaRecoveryActions reason={reason} />}
            {!permissionMessage && (
              <button
                type="button"
                onClick={() => void openSettings()}
                disabled={pending}
                className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:brightness-110 disabled:opacity-50"
              >
                Open System Settings
              </button>
            )}
            <button
              type="button"
              onClick={() => void retry()}
              disabled={pending}
              className="inline-flex items-center gap-1.5 rounded-lg border border-hairline/50 px-3 py-1.5 text-[12.5px] font-medium text-ink hover:bg-raised disabled:opacity-50"
            >
              {pending && <Loader2 size={13} className="animate-spin" />}
              Retry
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
