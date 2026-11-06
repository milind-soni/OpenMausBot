import { useState } from "react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { t } from "@/lib/i18n";
import { Switch } from "./SettingsPrimitives";

/** The installation's "Voice note with every reply": each bot follows it unless its own Voice & alerts says otherwise. */
export function VoiceEveryReplySetting() {
  const { state, dispatch } = useStore();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const on = state.config?.tts?.everyReply === true;
  const toggle = () => {
    setSaving(true);
    setError(null);
    api("/api/config", { method: "PUT", body: JSON.stringify({ tts: { everyReply: !on } }) })
      .then((status: ConfigStatus) => dispatch({ type: "configStatus", config: status }))
      .catch((failure: Error) => setError(failure.message))
      .finally(() => setSaving(false));
  };
  return (
    <div data-voice-every-reply className="flex items-center justify-between gap-4 px-3 py-2.5">
      <div className="min-w-0">
        <div className="text-[14px] font-medium leading-5 text-ink">{t("voice.everyReply")}</div>
        <div className="mt-0.5 text-[12px] leading-4 text-ink-secondary">{t("voice.everyReply.allHelp")}</div>
        {error && <div role="alert" className="mt-1 text-[12px] text-danger">{error}</div>}
      </div>
      <Switch checked={on} disabled={saving} aria-label={t("voice.everyReply")} onClick={toggle} />
    </div>
  );
}
