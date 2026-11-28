import { useEffect, useState } from "react";
import { Image as ImageIcon } from "lucide-react";
import type { LocaleKey } from "@/locales";
import { t } from "@/lib/i18n";
import { SettingRow } from "./SettingsPrimitives";

const problemText = (problem: string): LocaleKey => problem === "size" ? "settings.appIcon.tooLarge"
  : problem === "dimensions" ? "settings.appIcon.dimensions"
    : problem === "extension" ? "settings.appIcon.unsupported" : "settings.appIcon.failed";

/** This computer's own page: the app's Dock, window and tray picture, chosen by the person. */
export function AppIconRow() {
  const bridge = window.ogb?.appIcon;
  const [state, setState] = useState<AppIconState | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void bridge?.state().then((next) => { if (alive) setState(next); }).catch(() => {});
    return () => { alive = false; };
  }, [bridge]);
  if (!bridge) return null;
  const choose = () => {
    setBusy(true); setFailed(null);
    void bridge.choose().then((result) => {
      if (result.outcome === "saved") setState(result.state);
      else if (result.outcome === "error") setFailed(result.problem);
    }, () => setFailed("write")).finally(() => setBusy(false));
  };
  const reset = () => {
    setBusy(true); setFailed(null);
    void bridge.reset().then((result) => setState(result.state), () => setFailed("write")).finally(() => setBusy(false));
  };
  return (
    <SettingRow
      title={t("settings.appIcon.title")}
      subtitle={state?.custom && state.name ? t("settings.appIcon.custom", { name: state.name }) : t("settings.appIcon.subtitle")}
      leading={state?.preview
        ? <img src={state.preview} alt="" className="size-8 rounded-lg object-cover" />
        : <span className="flex size-8 items-center justify-center rounded-lg bg-ink/[0.06] text-ink-secondary"><ImageIcon size={17} aria-hidden="true" /></span>}
      message={failed ? <span role="alert" className="text-danger">{t(problemText(failed))}</span> : undefined}
    >
      <div className="flex items-center gap-2">
        {state?.custom && <button type="button" className="ui-button" disabled={busy} onClick={reset}>{t("settings.appIcon.reset")}</button>}
        <button type="button" className="ui-button" disabled={busy} aria-busy={busy || undefined} onClick={choose}>{t("settings.appIcon.choose")}</button>
      </div>
    </SettingRow>
  );
}
