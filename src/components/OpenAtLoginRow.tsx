import { useEffect, useState } from "react";
import { t } from "@/lib/i18n";
import { SettingRow, Switch } from "./SettingsPrimitives";

type OpenAtLogin = { available: boolean; on: boolean };

export function OpenAtLoginRow({ simple = false }: { simple?: boolean }) {
  const bridge = window.ogb?.openAtLogin;
  const [state, setState] = useState<OpenAtLogin | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    void bridge?.state().then((next) => { if (alive) setState(next); }).catch(() => {});
    return () => { alive = false; };
  }, [bridge]);
  if (!bridge || !state?.available) return null;
  const set = (on: boolean) => {
    setBusy(true); setFailed(false);
    void bridge.set(on).then(setState, () => setFailed(true)).finally(() => setBusy(false));
  };
  return <SettingRow title={t("settings.openAtLogin.title")} subtitle={t(simple ? "settings.simple.openAtLogin" : "settings.openAtLogin.subtitle")}
    message={failed ? <span role="alert" className="text-danger">{t("settings.openAtLogin.failed")}</span> : undefined}>
    <Switch checked={state.on} disabled={busy} aria-label={t("settings.openAtLogin.title")} onClick={() => set(!state.on)} />
  </SettingRow>;
}
