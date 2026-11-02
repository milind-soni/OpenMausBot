import { useState } from "react";
import { AlertTriangle, Loader2, MonitorX } from "lucide-react";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { t } from "@/lib/i18n";

/** On a PC whose screen control isn't running: that bots, and the person's Cloud's bots, can't use its apps and screen,
 * why, and the one fix. */
export function WindowsLocalControl() {
  const { capabilities } = useDesktopCapabilities();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const local = capabilities.localComputer;
  if (capabilities.host.platform !== "win32" || local.reasonCode === "remote-server" || local.available) return null;

  const start = async () => {
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

  return (
    <section data-windows-local-control={local.reasonCode ?? "unavailable"} className="mt-4 rounded-xl border border-warning/25 bg-warning/10 p-4">
      <div className="flex items-start gap-3">
        <MonitorX size={16} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-medium text-ink">{t("computer.windows.title")}</div>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">
            {t("computer.windows.body")}
            {local.reasonCode === "cua-driver-blocked" && <> {t("computer.windows.blocked")}</>}
          </p>
          {local.message && (
            <details className="mt-2 text-[12px] text-ink-secondary">
              <summary className="cursor-pointer">{t("computer.windows.detail")}</summary>
              <p className="mt-1 break-words">{local.message}</p>
            </details>
          )}
          {error && (
            <div role="alert" className="mt-2 flex gap-1.5 text-[12px] text-danger">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>{error}</span>
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void start()}
              disabled={pending}
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-50"
            >
              {pending && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}
              {t(pending ? "computer.windows.starting" : "computer.windows.start")}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
