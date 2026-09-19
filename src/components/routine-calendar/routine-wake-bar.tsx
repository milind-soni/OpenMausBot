import { useEffect, useState } from "react";
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
  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    const load = () => bridge.wakeState().then((next) => { if (!cancelled) setState(next); }).catch(() => {});
    void load();
    const timer = window.setInterval(load, 30_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [bridge]);
  if (!bridge || !state) return null;
  const status = !state.keepAwake
    ? "Off — this computer may sleep through a scheduled routine."
    : state.onBattery
      ? "On battery, so not holding; plug in to keep it awake."
      : state.hold
        ? state.reason === "running" ? "Holding it awake now: a routine is running." : `Holding it awake now: a routine is due at ${state.at ? niceTime(state.at) : "the top of the hour"}.`
        : "Holds it awake for the hour before a routine and while one runs, while plugged in. A closed lid still sleeps.";
  return (
    <div className="flex items-center justify-between gap-4 border-b border-hairline/35 bg-panel/60 px-4 py-2.5">
      <div className="min-w-0 text-[12px] leading-relaxed text-ink-secondary">
        <span className="font-medium text-ink">Keep this computer awake for routines.</span> {status}
      </div>
      <Switch
        checked={state.keepAwake}
        disabled={busy}
        aria-label="Keep this computer awake for scheduled routines"
        onClick={() => {
          setBusy(true);
          bridge.keepAwake(!state.keepAwake).then(setState).catch(() => {}).finally(() => setBusy(false));
        }}
        className="shrink-0 disabled:cursor-wait disabled:opacity-50"
      />
    </div>
  );
}
