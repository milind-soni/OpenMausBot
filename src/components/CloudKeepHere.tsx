import { useEffect, useState } from "react";
import type { CloudSendPageBridge, KeepHereState } from "../../electron/cloud-send.mjs";
import { ipcErrorText } from "@/lib/cloud-send";
import { t } from "@/lib/i18n";
import { useAdvancedMode } from "@/lib/interface-mode";
import { Switch } from "./SettingsPrimitives";

/**
 * Settings → MausBot Cloud, in Advanced mode only, for someone with a Cloud of their own the move applies to: "Keep this
 * computer's bots on this computer". Turned on once this computer's bots live on My Cloud, it asks first, since they come
 * back here; while they are on their way it can't be turned back.
 */
export function CloudKeepHere({ bridge }: { bridge: CloudSendPageBridge | undefined }) {
  const advanced = useAdvancedMode();
  const read = bridge?.keepHere, write = bridge?.setKeepHere;
  return advanced && bridge && read && write ? <KeepHereSwitch bridge={bridge} read={read} write={write} /> : null;
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
  return <div data-cloud-keep={state.coming ? "coming" : state.on ? "on" : "off"} className="rounded-xl bg-card p-4">
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-[14px] font-medium text-ink">{t("cloudAccount.keepHere.title")}</p>
        <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">{t("cloudAccount.keepHere.line")}</p>
      </div>
      <Switch checked={state.on || state.coming} disabled={busy || state.coming} aria-label={t("cloudAccount.keepHere.title")} onClick={turn} />
    </div>
    {state.coming && <p role="status" className="mt-3 text-[13px] text-ink-secondary">{t("cloudAccount.keepHere.coming")}</p>}
    {confirm && <div role="group" aria-label={t("cloudAccount.keepHere.confirmTitle")} className="mt-3 rounded-lg border border-hairline/40 p-3">
      <p className="text-[13px] font-medium text-ink">{t("cloudAccount.keepHere.confirmTitle")}</p>
      <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">{t("cloudAccount.keepHere.confirm")}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" autoFocus className="ui-button" onClick={() => setConfirm(false)}>{t("common.cancel")}</button>
        <button type="button" className="ui-button ui-button-primary" onClick={() => set(true)}>{t("cloudAccount.keepHere.bringBack")}</button>
      </div>
    </div>}
    {failed && <p role="alert" className="mt-3 text-[13px] text-danger">{failed}</p>}
  </div>;
}
