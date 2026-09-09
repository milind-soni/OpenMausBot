import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Loader2,
  MonitorCog,
  Power,
  RotateCcw,
} from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useDesktopCapabilities } from "./DesktopCapabilities";

const LINUX_GUIDE_URL =
  "https://github.com/milind-soni/OpenMausBot/blob/main/docs/linux-desktop.md#enable-local-control";

export function LinuxLocalControl() {
  const { capabilities } = useDesktopCapabilities();
  const local = capabilities.localComputer;
  const [pending, setPending] = useState<"enable" | "disable" | "retry" | null>(null);
  const [error, setError] = useState<string | { key: "computer.linux.stopFailed" } | null>(null);

  if (capabilities.host.platform !== "linux") return null;
  const busy = pending !== null || local.status === "checking" || local.status === "starting";
  const ready = local.available;
  const waylandSafetyBlocked = local.reasonCode === "linux-wayland-seat-safety-blocked";
  const wayland = capabilities.host.session === "wayland";
  const bundledDriver = local.driverSource === "bundled";

  const run = async (action: "enable" | "disable" | "retry") => {
    if (!window.ogb?.localControl) return;
    setPending(action);
    setError(null);
    try {
      if (action === "disable" || action === "retry") {
        const response = await fetch("/api/local-computer/interrupt", { method: "POST" });
        if (!response.ok) {
          setError({ key: "computer.linux.stopFailed" });
          return;
        }
      }
      await window.ogb.localControl[action]();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending(null);
    }
  };

  return (
    <section className="mt-4 rounded-xl bg-card p-4" aria-labelledby="linux-local-control-title">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div id="linux-local-control-title" className="flex items-center gap-2 text-[15px] font-medium text-ink">
            <MonitorCog size={16} className={ready ? "text-success" : "text-ink-secondary"} />
            {t("computer.linux.title")}
          </div>
          <div className="mt-1 text-[12px] leading-relaxed text-ink-secondary">
            {t("computer.linux.meta", { session: wayland ? "Wayland" : "Xorg" })}
          </div>
        </div>
        <span
          className={cn(
            "shrink-0 rounded-full px-2 py-1 text-[10px] font-medium",
            ready
              ? "bg-success/10 text-success"
              : waylandSafetyBlocked
                ? "bg-danger/10 text-danger"
                : local.enabled
                  ? "bg-warning/10 text-warning"
                  : "bg-raised text-ink-secondary",
          )}
        >
          {ready
            ? t("computer.linux.ready")
            : waylandSafetyBlocked
              ? t("computer.linux.waylandBadge")
              : local.enabled
                ? t("vm.state.attention")
                : t("vm.dest.off")}
        </span>
      </div>

      {waylandSafetyBlocked ? (
        <div className="mt-3 rounded-lg border border-danger/20 bg-danger/5 p-3">
          <div className="flex gap-2 text-[12px] leading-relaxed text-ink-secondary">
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-danger" />
            <span>
              {t("computer.linux.waylandBefore")}{" "}
              <strong className="font-medium text-ink">{t("computer.linux.waylandXorg")}</strong>
              {" "}{t("computer.linux.waylandAfter")}
            </span>
          </div>
        </div>
      ) : !local.enabled ? (
        <div className="mt-3 rounded-lg border border-warning/20 bg-warning/5 p-3">
          <div className="flex gap-2 text-[12px] leading-relaxed text-ink-secondary">
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" />
            <span>
              {t("computer.linux.enableBefore")}{" "}
              <strong className="font-medium text-ink">{t("vm.dest.local")}</strong>{" "}
              {t("computer.linux.enableAfter")}
              {wayland && ` ${t("computer.linux.waylandInput")}`}
            </span>
          </div>
        </div>
      ) : (
        <div className="mt-3 rounded-lg bg-panel p-3 text-[12px] text-ink-secondary">
          <div className="flex items-start gap-2">
            {ready ? (
              <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-success" />
            ) : busy ? (
              <Loader2 size={15} className="mt-0.5 shrink-0 animate-spin" />
            ) : (
              <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" />
            )}
            <span aria-live="polite">
              {ready
                ? t("computer.linux.readyMsg")
                : local.message ?? t("computer.linux.checking")}
            </span>
          </div>
          {local.driverPath && (
            <div className="mt-2 break-all font-mono text-[10px] text-ink-secondary/80" title={local.driverPath}>
              {bundledDriver ? t("computer.linux.bundledDriver") : local.driverPath}
              {local.driverVersion ? ` · ${local.driverVersion}` : ""}
            </div>
          )}
        </div>
      )}

      {error && <div className="mt-2 text-[12px] text-danger">{typeof error === "string" ? error : t(error.key)}</div>}

      {!waylandSafetyBlocked && <div className="mt-3 flex gap-2">
        {!local.enabled ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void run("enable")}
            className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-accent py-2 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {pending === "enable" ? <Loader2 size={14} className="animate-spin" /> : <Power size={14} />}
            {t("computer.linux.enable")}
          </button>
        ) : (
          <>
            {!ready && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void run("retry")}
                className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-raised py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
              >
                {pending === "retry" ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}
                {t("computer.linux.tryAgain")}
              </button>
            )}
            <button
              type="button"
              disabled={pending !== null}
              onClick={() => void run("disable")}
              className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-raised py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
            >
              {pending === "disable" ? <Loader2 size={14} className="animate-spin" /> : <Power size={14} />}
              {t("computer.linux.disable")}
            </button>
          </>
        )}
      </div>}

      <button
        type="button"
        onClick={() => window.open(LINUX_GUIDE_URL, "_blank", "noopener,noreferrer")}
        className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg py-1.5 text-[11px] text-ink-secondary hover:bg-raised hover:text-ink"
      >
        {capabilities.host.packaged ? t("computer.linux.guide") : t("computer.linux.driverSetup")}{" "}
        <ExternalLink size={11} />
      </button>
    </section>
  );
}
