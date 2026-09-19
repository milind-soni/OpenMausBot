import { useCallback, useEffect, useState } from "react";
import { t } from "@/lib/i18n";
import { niceTime } from "@/lib/schedule-label";
import { Switch } from "../SettingsPrimitives";

/** Desktop only: the one lever the app has against a sleeping computer.
 * The scheduler runs inside the local server, so while the Mac sleeps no
 * routine fires; the shell holds a power assertion for the hour before a
 * due routine and while one runs, plugged in only, and this row shows it. */
export function RoutineWakeBar() {
  const bridge = typeof window !== "undefined" ? window.ogb?.routines : undefined;
  const [state, setState] = useState<DesktopRoutineWake | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    if (!bridge) return;
    try {
      setError("");
      setState(await bridge.wakeState());
    } catch {
      setError(t("routines.wake.error"));
    }
  }, [bridge]);
  useEffect(() => {
    if (!bridge) return;
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(timer);
  }, [bridge, load]);
  if (!bridge || (!state && !error)) return null;
  const status = state
    ? !state.keepAwake
      ? t("routines.wake.off")
      : state.onBattery
        ? t("routines.wake.battery")
        : state.hold
          ? state.reason === "running" ? t("routines.wake.holdingRun") : t("routines.wake.holdingDue", { time: state.at ? niceTime(state.at) : t("routines.wake.topOfHour") })
          : t("routines.wake.idle")
    : "";
  return (
    <div className="flex items-center justify-between gap-4 border-b border-hairline/35 bg-panel/60 px-4 py-2.5">
      <div className="min-w-0 text-[12px] leading-relaxed text-ink-secondary">
        <span className="font-medium text-ink">{t("routines.wake.title")}</span> {status}
      </div>
      {error
        ? <div role="alert" className="flex items-center gap-2 text-[12px] text-danger">{error}<button type="button" onClick={() => void load()} className="rounded-lg px-2 py-1 text-[11px] font-medium text-danger hover:bg-danger/10">{t("routines.wake.retry")}</button></div>
        : state && (
          <Switch
            checked={state.keepAwake}
            disabled={busy}
            aria-label={t("routines.wake.label")}
            onClick={() => {
              if (!bridge || !state || busy) return;
              setBusy(true);
              bridge.keepAwake(!state.keepAwake).then(setState).catch(() => setError(t("routines.wake.error"))).finally(() => setBusy(false));
            }}
            className="shrink-0 disabled:cursor-wait disabled:opacity-50"
          />
        )}
    </div>
  );
}
