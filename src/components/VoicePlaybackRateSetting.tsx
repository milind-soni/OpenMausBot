import { useContext, useState } from "react";
import { api, type ConfigStatus } from "@/state/store";
import { useStoreDispatch, useStoreSelector } from "@/state/store-select";
import { t } from "@/lib/i18n";
import { VOICE_PLAYBACK_RATES } from "../../shared/voice-playback";
import { Select } from "./Select";
import { SettingRow, SettingsLook } from "./SettingsPrimitives";

export function VoicePlaybackRateSetting() {
  const dispatch = useStoreDispatch();
  const playbackRate = useStoreSelector((state) => state.config?.tts?.playbackRate ?? 1);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const settings = useContext(SettingsLook);
  const save = (value: number) => {
    setSaving(true);
    setError(null);
    api("/api/config", { method: "PUT", body: JSON.stringify({ tts: { playbackRate: value } }) })
      .then((status: ConfigStatus) => dispatch({ type: "configStatus", config: status }))
      .catch((failure: Error) => setError(failure.message))
      .finally(() => setSaving(false));
  };
  const picker = (
    <Select size="sm" aria-label={t("voice.playbackRate")} value={String(playbackRate)} disabled={saving}
      onChange={(event) => save(Number(event.target.value))}>
      {VOICE_PLAYBACK_RATES.map((rate) => <option key={rate} value={rate}>{rate}×</option>)}
    </Select>
  );
  const alert = error ? <span role="alert" className="text-danger">{error}</span> : undefined;
  if (settings) {
    return (
      <div data-voice-playback-rate className="contents">
        <SettingRow title={t("voice.playbackRate")} subtitle={t("voice.playbackRate.help")} leading={<span aria-hidden="true" />} message={alert}>
          {picker}
        </SettingRow>
      </div>
    );
  }
  return (
    <div data-voice-playback-rate className="flex items-center justify-between gap-4 px-3 py-2.5">
      <div className="min-w-0">
        <div className="text-[14px] font-medium leading-5 text-ink">{t("voice.playbackRate")}</div>
        <div className="mt-0.5 text-[12px] leading-4 text-ink-secondary">{t("voice.playbackRate.help")}</div>
        {error && <div role="alert" className="mt-1 text-[12px] text-danger">{error}</div>}
      </div>
      {picker}
    </div>
  );
}
