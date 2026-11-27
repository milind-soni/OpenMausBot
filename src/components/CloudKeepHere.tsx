import { useEffect, useState } from "react";
import type { CloudSendPageBridge, KeepHereState } from "../../electron/cloud-send.mjs";
import { ipcErrorText } from "@/lib/cloud-send";
import { t } from "@/lib/i18n";
import { SettingRow, SettingsGroup, SettingsRows, Switch } from "./SettingsPrimitives";
import { SettingsDialog } from "./settings/SettingsDialog";

export function CloudKeepHere({ bridge }: { bridge: CloudSendPageBridge | undefined }) {
  const read = bridge?.keepHere, write = bridge?.setKeepHere;
  return bridge && read && write ? <KeepHereSwitch bridge={bridge} read={read} write={write} /> : null;
}

function KeepHereSwitch({ bridge, read, write }: { bridge: CloudSendPageBridge; read: () => Promise<KeepHereState>; write: (on: boolean) => Promise<KeepHereState> }) {
  const [state, setState] = useState<KeepHereState | null>(null);
  const [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false), [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const look = () => { void read().then((next) => { if (alive) setState(next); }).catch(() => {}); };
    look();
    // The move's line changes as this computer's bots move or come home: the switch follows it.
    const unsubscribe = bridge.onNotice(look);
    return () => { alive = false; unsubscribe(); };
  }, [bridge, read]);
  if (!state?.shown) return null;
  const set = (on: boolean) => {
    setConfirm(false); setBusy(true); setFailed(null);
    void write(on).then((next) => setState(next), (cause: unknown) => setFailed(ipcErrorText(cause) ?? t("cloudAccount.keepHere.failed"))).finally(() => setBusy(false));
  };
  const turn = () => {
    if (state.on) set(false);
    else if (state.moved) setConfirm(true);
    else set(true);
  };
  return <SettingsGroup label={t("settings.data.move", { place: t("cloudSetup.myCloud") })} block="move">
    <SettingsRows>
      <div data-cloud-keep={state.coming ? "coming" : state.on ? "on" : "off"} className="contents">
        <SettingRow title={t("cloudAccount.keepHere.title")} subtitle={t("cloudAccount.keepHere.line")}
          message={<>
            {state.coming && <span role="status" className="block">{t("cloudAccount.keepHere.coming")}</span>}
            {failed && <span role="alert" className="block text-danger">{failed}</span>}
          </>}>
          <Switch checked={state.on || state.coming} disabled={busy || state.coming} aria-label={t("cloudAccount.keepHere.title")} onClick={turn} />
        </SettingRow>
      </div>
    </SettingsRows>
    {confirm && (
      <SettingsDialog title={t("cloudAccount.keepHere.confirmTitle")} onClose={() => setConfirm(false)}>
        <p className="text-[13px] leading-[18px] text-ink-secondary">{t("cloudAccount.keepHere.confirm")}</p>
        <div className="flex items-center justify-end gap-2">
          <button type="button" data-autofocus="" className="ui-button" onClick={() => setConfirm(false)}>{t("common.cancel")}</button>
          <button type="button" className="ui-button ui-button-primary" onClick={() => set(true)}>{t("cloudAccount.keepHere.bringBack")}</button>
        </div>
      </SettingsDialog>
    )}
  </SettingsGroup>;
}
