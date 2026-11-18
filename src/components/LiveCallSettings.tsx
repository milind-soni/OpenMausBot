import { useCallback, useId, useState } from "react";

import { botCallVoice, GEMINI_LIVE_VOICE_OPTIONS, geminiLiveVoice, LIVE_VOICE_OPTIONS } from "../../shared/live-call";
import { t } from "@/lib/i18n";
import { liveDisclosure, liveKeyCopy, liveKeyFormKey } from "@/lib/call-mode";
import { api, useStore, type Bot, type ConfigStatus } from "@/state/store";
import type { LiveSettings } from "../../shared/wire";
import { LiveKeySetup } from "./LiveKeySetup";
import { LiveProviderSettings } from "./LiveProviderSettings";
import { KeysLink } from "./keys/KeysLink";
import { Select } from "./Select";

const IDLE_CHOICES = [1, 2, 3, 5, 10, 15, 30, 60];

/** With `bot`, the bot on the call: it can have a voice of its own, and the other voice is the default for every other bot. */
export function LiveCallSettings({ bot, onClose }: { bot?: Pick<Bot, "id" | "name" | "liveVoice">; onClose: () => void }) {
  const { state, dispatch } = useStore();
  const live: LiveSettings = state.config?.live ?? { configured: false, voice: "", readTypedReplies: true, idleMinutes: 5 };
  const [saving, setSaving] = useState(false);
  const [changingKey, setChangingKey] = useState(false);
  const [keySaving, setKeySaving] = useState(false);
  const [providerSaving, setProviderSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const typedHintId = useId();
  // Stable, so this callback ref runs once when the popover mounts, not on every save.
  const focusOnOpen = useCallback((dialog: HTMLDivElement | null) => {
    dialog?.querySelector<HTMLElement>("select, input, button")?.focus();
  }, []);
  const azure = live.provider === "azure";
  const custom = live.provider === "custom";
  const fish = live.provider === "fish";
  const gemini = live.provider === "gemini";
  const elevenlabs = live.provider === "elevenlabs";
  const copy = liveKeyCopy(live.provider);
  const hasKey = live.keySource === (fish ? "fishAudio" : gemini ? "gemini" : elevenlabs ? "elevenlabs" : "live");
  // Gemini has its own voices, kept apart from the GPT-Live one.
  const voiceOptions = gemini ? GEMINI_LIVE_VOICE_OPTIONS : LIVE_VOICE_OPTIONS;
  const voice = gemini ? geminiLiveVoice(live.geminiVoice) : live.voice || "marin";
  const known = voiceOptions.some((option) => option.id === voice);
  // A bot's own voice of the other provider's kind stays saved and shows as the default here.
  const botVoice = bot ? botCallVoice(bot.liveVoice, "", gemini) : "";

  const save = async (patch: Partial<Pick<LiveSettings, "voice" | "geminiVoice" | "readTypedReplies" | "idleMinutes">>) => {
    setSaving(true);
    setError(null);
    try {
      const body = await api<{ live: LiveSettings }>("/api/live/settings", { method: "PATCH", body: JSON.stringify(patch) });
      if (state.config) dispatch({ type: "configStatus", config: { ...state.config, live: body.live } });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  };

  const removeKey = async () => {
    setSaving(true);
    setError(null);
    try {
      const status: ConfigStatus = window.ogb?.setCredential
        ? await window.ogb.setCredential("openaiLiveKey", "")
        : await api("/api/config", { method: "PUT", body: JSON.stringify({ live: { key: "" } }) });
      dispatch({ type: "configStatus", config: status });
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : String(removeError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      ref={focusOnOpen}
      role="dialog"
      tabIndex={-1}
      aria-label={t("call.live.settings")}
      className="flex w-[300px] max-w-[90vw] flex-col gap-3 rounded-xl border border-hairline bg-panel p-3 text-[13px] text-ink shadow-lg"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        onClose();
      }}
    >
      <LiveProviderSettings locked={keySaving} onSaving={setProviderSaving} />
      {/* Fish Audio and ElevenLabs calls speak in their agent's own voice. */}
      {!fish && !elevenlabs && <>
      {bot && (
        <label className="flex items-center justify-between gap-2">
          <span className="text-ink-secondary">{t("call.live.botVoice", { name: bot.name })}</span>
          <Select
            size="sm"
            value={botVoice}
            onChange={(event) => dispatch({ type: "updateBot", botId: bot.id, patch: { liveVoice: event.target.value } })}
          >
            <option value="">{t("call.live.botVoiceDefault")}</option>
            {voiceOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </Select>
        </label>
      )}
      <label className="flex items-center justify-between gap-2">
        <span className="text-ink-secondary">{t(bot ? "call.live.defaultVoice" : "call.live.voice")}</span>
        <Select
          size="sm"
          value={voice}
          disabled={saving}
          onChange={(event) => void save(gemini ? { geminiVoice: event.target.value } : { voice: event.target.value })}
        >
          {!known && <option value={voice}>{voice}</option>}
          {voiceOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
        </Select>
      </label>
      <div className="-mt-2 text-[12px] text-ink-tertiary">{t("call.live.voiceNext")}</div>
      </>}
      <label className="flex items-center justify-between gap-2">
        <span className="text-ink-secondary">{t("call.live.readTyped")}</span>
        <input
          type="checkbox"
          checked={live.readTypedReplies}
          disabled={saving}
          aria-describedby={typedHintId}
          onChange={(event) => void save({ readTypedReplies: event.target.checked })}
        />
      </label>
      <div id={typedHintId} className="-mt-2 text-[12px] text-ink-tertiary">{t("call.live.readTypedHint")}</div>
      <label className="flex items-center justify-between gap-2">
        <span className="text-ink-secondary">{t("call.live.idle")}</span>
        <Select
          size="sm"
          value={live.idleMinutes}
          disabled={saving}
          onChange={(event) => void save({ idleMinutes: Number(event.target.value) })}
        >
          {[...new Set([...IDLE_CHOICES, live.idleMinutes])].sort((a, b) => a - b).map((minutes) => (
            <option key={minutes} value={minutes}>{minutes}</option>
          ))}
        </Select>
      </label>
      <div className="flex items-center justify-between gap-2 border-t border-hairline/60 pt-2">
        <span className="text-ink-secondary">{t(copy.key)}</span>
        <span className="flex gap-2">
          <button type="button" className="text-accent hover:underline" onClick={() => setChangingKey((open) => !open)}>
            {t("call.live.keyChange")}
          </button>
          {live.keySource === "live" && (
            <button type="button" className="text-danger hover:underline" disabled={saving} onClick={() => void removeKey()}>
              {t("call.live.keyRemove")}
            </button>
          )}
        </span>
      </div>
      {!hasKey && (azure || custom || fish || gemini || elevenlabs) && <div className="-mt-2 text-[12px] text-ink-tertiary">{t(copy.missing)}</div>}
      {live.keySource !== "live" && !azure && !custom && !fish && !gemini && !elevenlabs && (
        <div className="-mt-2 text-[12px] text-ink-tertiary">{t(live.keySource === "openai" ? "call.live.keyFromApiKeys" : "call.live.needsKey")} <KeysLink id="openai" purpose="liveCalls" /></div>
      )}
      {/* Keyed by provider and endpoint: a key typed for one is never saved for another. */}
      {changingKey && <LiveKeySetup key={liveKeyFormKey(state.config?.live)} compact locked={providerSaving} onSaving={setKeySaving} onSaved={() => setChangingKey(false)} />}
      <div className="text-[12px] text-ink-tertiary">{liveDisclosure({ cloudHome: state.config?.cloudHome === true, azure, custom, fish, gemini, elevenlabs })} {t(copy.cost)}</div>
      {error && <div className="text-[12px] text-danger">{error}</div>}
    </div>
  );
}
