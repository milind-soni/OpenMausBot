import { useContext, useState } from "react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { intlLocale, t } from "@/lib/i18n";
import { ownElevenLabsKey, scribeChosen } from "@/lib/speech";
import { Select } from "./Select";
import { SettingRow, SettingsLook, Switch } from "./SettingsPrimitives";

/** Languages offered for Scribe (ISO 639-1); Scribe hears more, and "" lets it detect the language itself. */
export const HEAR_LANGUAGES = [
  "ar", "bn", "zh", "cs", "da", "nl", "en", "fi", "fr", "de", "el", "he", "hi", "hu", "id", "it", "ja", "ko", "ms",
  "no", "fa", "pl", "pt", "ro", "ru", "es", "sv", "th", "tr", "uk", "ur", "vi",
] as const;

/** The picker's languages, plus the saved code when it is one the list does not offer, so the picker never shows "automatic" for it. */
export function languageOptions(saved = ""): Array<{ code: string; name: string }> {
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames([intlLocale()], { type: "language" });
  } catch {
    // Without display names the codes themselves are shown.
  }
  const codes: readonly string[] = saved && !(HEAR_LANGUAGES as readonly string[]).includes(saved) ? [...HEAR_LANGUAGES, saved] : HEAR_LANGUAGES;
  return codes.map((code) => ({ code, name: names?.of(code) ?? code })).sort((a, b) => a.name.localeCompare(b.name, intlLocale()));
}

/** "Hear me with ElevenLabs": dictation and Take turns go to Scribe with the person's own key, in the language they pick.
 * Shown only while their own ElevenLabs key is saved; off, every computer keeps its usual way of listening. */
export function VoiceHearingSetting() {
  const { state, dispatch } = useStore();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const settings = useContext(SettingsLook);
  if (!ownElevenLabsKey(state.config)) return null;
  const on = scribeChosen(state.config);
  const language = state.config?.tts?.hearLanguage ?? "";
  const save = (tts: { hearWith?: "device" | "elevenlabs"; hearLanguage?: string }) => {
    setSaving(true);
    setError(null);
    api("/api/config", { method: "PUT", body: JSON.stringify({ tts }) })
      .then((status: ConfigStatus) => dispatch({ type: "configStatus", config: status }))
      .catch((failure: Error) => setError(failure.message))
      .finally(() => setSaving(false));
  };
  const toggle = <Switch checked={on} disabled={saving} aria-label={t("voice.hearWithEleven")} onClick={() => save({ hearWith: on ? "device" : "elevenlabs" })} />;
  const picker = (
    <Select size="sm" aria-label={t("voice.hearLanguage")} value={language} disabled={saving} onChange={(event) => save({ hearLanguage: event.target.value })}>
      <option value="">{t("voice.hearLanguage.auto")}</option>
      {languageOptions(language).map(({ code, name }) => <option key={code} value={code}>{name}</option>)}
    </Select>
  );
  const alert = error ? <span role="alert" className="text-danger">{error}</span> : undefined;
  if (settings) {
    return (
      <div data-voice-hearing className="contents">
        <SettingRow title={t("voice.hearWithEleven")} subtitle={t("voice.hearWithEleven.help")} leading={<span aria-hidden="true" />} message={alert}>
          {toggle}
        </SettingRow>
        {on && <SettingRow title={t("voice.hearLanguage")} subtitle={t("voice.hearLanguage.help")} leading={<span aria-hidden="true" />}>{picker}</SettingRow>}
      </div>
    );
  }
  return (
    <div data-voice-hearing className="flex flex-col">
      <div className="flex items-center justify-between gap-4 px-3 py-2.5">
        <div className="min-w-0">
          <div className="text-[14px] font-medium leading-5 text-ink">{t("voice.hearWithEleven")}</div>
          <div className="mt-0.5 text-[12px] leading-4 text-ink-secondary">{t("voice.hearWithEleven.help")}</div>
          {error && <div role="alert" className="mt-1 text-[12px] text-danger">{error}</div>}
        </div>
        {toggle}
      </div>
      {on && (
        <div className="flex items-center justify-between gap-4 px-3 py-2.5">
          <div className="min-w-0">
            <div className="text-[14px] font-medium leading-5 text-ink">{t("voice.hearLanguage")}</div>
            <div className="mt-0.5 text-[12px] leading-4 text-ink-secondary">{t("voice.hearLanguage.help")}</div>
          </div>
          {picker}
        </div>
      )}
    </div>
  );
}
