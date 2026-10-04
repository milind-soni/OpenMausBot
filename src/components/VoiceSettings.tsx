// Per-agent voice profile. The key is shared; the voice and autoplay choice
// belong to the selected bot.
//
// The voice list comes from the harness, which holds cloud provider keys —
// the renderer never talks to ElevenLabs or Fish Audio itself.
import { useEffect, useState } from "react";
import { Check, Loader2, Volume2 } from "lucide-react";

import { api, useStore, type Bot, type ConfigStatus } from "@/state/store";
import { useDesktopCapabilities } from "@/components/DesktopCapabilities";
import { speaker } from "@/lib/tts";
import {
  listLocalSystemVoices,
  localSystemVoicesAvailable,
  remoteSystemVoice,
  remoteVoiceProvider,
  setRemoteSystemVoice,
  setRemoteVoiceProvider,
  type RemoteVoiceProvider,
} from "@/lib/local-voice";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { cn } from "@/lib/cn";
import { voiceKeyDraftValue, type VoiceKeyDraft } from "@/lib/voice-key-draft";
import { Switch } from "./SettingsPrimitives";

const FISH_MODELS = [
  { value: "s2.1-pro", label: "voice.fish.modelPro" },
  { value: "s2.1-pro-free", label: "voice.fish.modelFree" },
] as const;
type FishModel = (typeof FISH_MODELS)[number]["value"];

export function VoiceSettings({
  bot,
  onPatch,
  workspaceConfigurationLocked = false,
}: {
  bot: Bot;
  onPatch: (patch: Partial<Pick<Bot, "voice" | "speakReplies" | "voiceNotes">>) => void;
  workspaceConfigurationLocked?: boolean;
}) {
  const { state, dispatch } = useStore();
  const tts = state.config?.tts;

  const [keyDraft, setKeyDraft] = useState<VoiceKeyDraft>({ provider: null, value: "" });
  const [serverUrl, setServerUrl] = useState("");
  const [model, setModel] = useState("");
  const [saving, setSaving] = useState(false);
  const [savingServer, setSavingServer] = useState(false);
  const [savingFishModel, setSavingFishModel] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [voices, setVoices] = useState<Array<{ id: string; label: string; description?: string }>>([]);
  const [loadingVoices, setLoadingVoices] = useState(false);

  const { capabilities } = useDesktopCapabilities();
  const localMacClient = workspaceConfigurationLocked && localSystemVoicesAvailable();
  const [deviceProvider, setDeviceProvider] = useState<RemoteVoiceProvider>(() => remoteVoiceProvider());
  const [deviceVoice, setDeviceVoice] = useState(() => remoteSystemVoice(bot.id));
  const usesLocalSystem = localMacClient && deviceProvider === "system";
  // Host configuration still controls host-rendered cloud audio. A
  // paired Mac owns its installed-voice choice locally.
  const provider = tts?.provider ?? "elevenlabs";
  const cloudProvider = provider === "fish"
    ? {
        id: "fish" as const,
        name: "Fish Audio",
        credential: "fishAudioKey" as const,
        configField: "fishKey" as const,
        placeholder: t("voice.placeholderFishKey"),
        keyUrl: "https://fish.audio/app/api-keys/",
      }
    : provider === "elevenlabs"
      ? {
          id: "elevenlabs" as const,
          name: "ElevenLabs",
          credential: "ttsKey" as const,
          configField: "key" as const,
          placeholder: t("voice.placeholderElevenKey"),
          keyUrl: "https://elevenlabs.io/app/settings/api-keys",
        }
      : null;
  const key = cloudProvider ? voiceKeyDraftValue(keyDraft, cloudProvider.id) : "";
  const hostProviderLabel = provider === "fish"
    ? t("voice.hostFish")
    : provider === "elevenlabs"
      ? t("voice.hostEleven")
      : provider === "chatterbox"
        ? t("voice.hostChatterbox")
        : provider === "xai" ? t("voice.grok.host") : t("voice.hostVoice");
  const systemVoicesAvailable = capabilities.host.platform === "darwin";
  const hostConfigured = Boolean(tts?.configured);
  // Cloud Pro's voice: it works with no saved key, and a key pasted here
  // replaces it.
  const included = Boolean(tts?.included);
  const configured = usesLocalSystem || hostConfigured;

  useEffect(() => {
    setDeviceVoice(remoteSystemVoice(bot.id));
  }, [bot.id]);

  useEffect(() => {
    setServerUrl(tts?.baseUrl ?? "");
    setModel(tts?.model ?? "");
  }, [tts?.baseUrl, tts?.model]);

  // Provider selection can also change from a paired phone or another open
  // client. Discard an unsaved draft on every transition, and keep the draft
  // tagged below so a render that lands before this effect still cannot send
  // one provider's credential to another service.
  useEffect(() => {
    setKeyDraft({ provider: null, value: "" });
  }, [provider]);

  useEffect(() => {
    if (usesLocalSystem) {
      const load = () => setVoices(listLocalSystemVoices());
      load();
      window.speechSynthesis.addEventListener("voiceschanged", load);
      return () => window.speechSynthesis.removeEventListener("voiceschanged", load);
    }
    if (!hostConfigured) {
      setVoices([]);
      return;
    }
    let alive = true;
    setLoadingVoices(true);
    api("/api/tts/voices")
      .then((r: { voices?: typeof voices; error?: string }) => {
        if (!alive) return;
        setVoices(r.voices ?? []);
        if (r.error) setError(r.error);
      })
      .catch(() => alive && setVoices([]))
      .finally(() => alive && setLoadingVoices(false));
    return () => {
      alive = false;
    };
  }, [hostConfigured, provider, usesLocalSystem]);

  const chooseDeviceProvider = (next: RemoteVoiceProvider) => {
    setRemoteVoiceProvider(next);
    setDeviceProvider(next);
    setError(null);
  };

  const chooseVoice = (voiceId: string) => {
    if (usesLocalSystem) {
      setRemoteSystemVoice(bot.id, voiceId);
      setDeviceVoice(voiceId);
      return;
    }
    onPatch({ voice: voiceId });
  };

  const setProvider = (next: "elevenlabs" | "fish" | "system" | "chatterbox" | "xai") => {
    if (next === provider || switching || (next === "system" && !systemVoicesAvailable)) return;
    setSwitching(true);
    setKeyDraft({ provider: null, value: "" });
    setError(null);
    // the provider is a setting, not a secret — it rides the ordinary
    // config write, and the key row reappears or disappears with it
    api("/api/config", { method: "PUT", body: JSON.stringify({ tts: { provider: next } }) })
      .then((status: ConfigStatus) => dispatch({ type: "configStatus", config: status }))
      .catch((e: Error) => setError(e.message))
      .finally(() => setSwitching(false));
  };

  const saveKey = () => {
    const nextKey = key.trim();
    if (!nextKey || !cloudProvider || keyDraft.provider !== cloudProvider.id) return Promise.resolve();
    setSaving(true);
    setError(null);
    const request = window.ogb?.setCredential
      ? window.ogb.setCredential(cloudProvider.credential, nextKey)
      : api("/api/config", {
          method: "PUT",
          body: JSON.stringify({ tts: { [cloudProvider.configField]: nextKey } }),
        });
    return request
      .then((status: ConfigStatus) => {
        dispatch({ type: "configStatus", config: status });
        setKeyDraft({ provider: null, value: "" });
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setSaving(false));
  };

  const saveServer = () => {
    const next = serverUrl.trim();
    if (!next || savingServer) return Promise.resolve();
    if (!/^https?:\/\//i.test(next)) {
      setError(t("voice.errServerUrl"));
      return Promise.resolve();
    }
    setSavingServer(true);
    setError(null);
    // both fields commit together: an address without its model id (or the
    // reverse) is half a setting
    return api("/api/config", { method: "PUT", body: JSON.stringify({ tts: { baseUrl: next, model: model.trim() } }) })
      .then((status: ConfigStatus) => dispatch({ type: "configStatus", config: status }))
      .catch((e: Error) => setError(e.message))
      .finally(() => setSavingServer(false));
  };

  const saveFishModel = (next: FishModel) => {
    if (next === tts?.fishModel || savingFishModel) return;
    setSavingFishModel(true);
    setError(null);
    // a setting, not a secret: it rides the ordinary config write
    api("/api/config", { method: "PUT", body: JSON.stringify({ tts: { fishModel: next } }) })
      .then((status: ConfigStatus) => dispatch({ type: "configStatus", config: status }))
      .catch((e: Error) => setError(e.message))
      .finally(() => setSavingFishModel(false));
  };

  if (!tts) return null;

  const selectedVoice = usesLocalSystem ? deviceVoice : (bot.voice ?? "");
  const ready = usesLocalSystem || (hostConfigured && Boolean(selectedVoice || tts.voice));

  return (
    <div className="rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">{t("voice.title")}</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">
        {localMacClient
          ? t("voice.introMac")
          : workspaceConfigurationLocked
            ? t("voice.introLocked")
            : <>{t("voice.introLead")}
              {provider === "system"
                ? systemVoicesAvailable
                  ? t("voice.introSystemMac")
                  : t("voice.introSystemUnavailable")
                : provider === "xai"
                  ? ` ${t("voice.grok.sharedKey")}`
                : provider === "chatterbox"
                  ? t("voice.introChatterbox")
                  : t("voice.introSharedKey", { provider: cloudProvider?.name ?? t("voice.providerFallback") })}</>}
      </div>

      {localMacClient && (
        <div className="mt-4">
          <div className="mb-2 text-[13px] text-ink-secondary">{t("voice.outputOnMac")}</div>
          <div className="inline-flex rounded-xl bg-inset p-1" role="radiogroup" aria-label={t("voice.outputOnMac")}>
            {([
              { value: "system", label: t("voice.builtinMacVoices"), available: true },
              { value: "host", label: hostProviderLabel, available: hostConfigured },
            ] as const).map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={deviceProvider === option.value}
                disabled={!option.available}
                title={!option.available ? t("voice.hostNotConfigured") : undefined}
                onClick={() => chooseDeviceProvider(option.value)}
                className={cn(
                  "rounded-lg px-3.5 py-1.5 text-[12.5px] transition-colors disabled:opacity-50",
                  deviceProvider === option.value ? "bg-raised text-ink shadow" : "text-ink-secondary hover:text-ink",
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {!workspaceConfigurationLocked && (
        <div className="mt-4">
          <div className="mb-2 text-[13px] text-ink-secondary">{t("voice.engine")}</div>
          <div className="grid grid-cols-2 gap-1 rounded-xl bg-inset p-1" role="radiogroup" aria-label={t("voice.engine")}>
            {([
              { value: "elevenlabs", label: "ElevenLabs", available: true },
              { value: "fish", label: "Fish Audio", available: true },
              { value: "system", label: t("voice.builtinMacVoices"), available: systemVoicesAvailable },
              { value: "chatterbox", label: t("voice.chatterboxLocal"), available: true },
              { value: "xai", label: t("voice.grok.label"), available: true },
            ] as const).map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={provider === option.value}
                disabled={switching || !option.available}
                title={!option.available ? t("voice.builtinMacOnly") : undefined}
                onClick={() => setProvider(option.value)}
                className={cn(
                  "rounded-lg px-3.5 py-1.5 text-[12.5px] transition-colors disabled:opacity-50",
                  provider === option.value ? "bg-raised text-ink shadow" : "text-ink-secondary hover:text-ink",
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {!workspaceConfigurationLocked && cloudProvider && (
        <div className="mt-4">
        <div className="mb-1.5 flex items-center gap-2 text-[13px] text-ink-secondary">
          <span className={cn("size-1.5 rounded-full", configured ? "bg-success" : "bg-raised-hover")} />
          <span>{t("voice.providerKey", { name: cloudProvider.name })}</span>
          {configured && <span className="text-[11px] text-success">{included ? t("keys.includedWithCloudPro") : t("voice.connected")}</span>}
        </div>
        <div className="flex gap-2">
          <input
            type="password"
            value={key}
            onChange={(e) => setKeyDraft({ provider: cloudProvider.id, value: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && key.trim() && void saveKey()}
            placeholder={configured && !included ? t("voice.pasteToReplace") : t(cloudProvider.placeholder as LocaleKey)}
            aria-label={t("voice.providerKey", { name: cloudProvider.name })}
            autoComplete="off"
            className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none"
          />
          <button
            onClick={() => void saveKey()}
            disabled={saving || !key.trim()}
            className="flex w-[72px] shrink-0 items-center justify-center gap-1.5 rounded-lg bg-control py-2 text-[13px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <><Check size={13} />{t("voice.save")}</>}
          </button>
        </div>
        {!configured && (
          <a
            href={cloudProvider.keyUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1.5 inline-block text-[12px] font-medium text-accent hover:underline"
          >
            {t("voice.getKeyFrom", { name: cloudProvider.name })}
          </a>
        )}
        </div>
      )}

      {!workspaceConfigurationLocked && provider === "fish" && (
        <div className="mt-4">
          <div className="mb-1.5 text-[13px] text-ink-secondary">{t("voice.fish.model")}</div>
          <select
            value={tts.fishModel ?? "s2.1-pro"}
            onChange={(e) => saveFishModel(e.target.value as FishModel)}
            disabled={savingFishModel}
            aria-label={t("voice.fish.model")}
            className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink focus:outline-none disabled:opacity-50"
          >
            {FISH_MODELS.map((option) => (
              <option key={option.value} value={option.value}>
                {t(option.label)}
              </option>
            ))}
          </select>
          <div className="mt-1.5 text-[11.5px] leading-relaxed text-ink-secondary">{t("voice.fish.modelHint")}</div>
        </div>
      )}

      {provider === "xai" && (
        <p className="mt-4 text-[13px] text-ink-secondary">
          {hostConfigured ? t("voice.grok.ready") : t("voice.grok.missingKey")}
        </p>
      )}

      {!workspaceConfigurationLocked && provider === "chatterbox" && (
        <div className="mt-4">
        <div className="mb-1.5 flex items-center gap-2 text-[13px] text-ink-secondary">
          <span className={cn("size-1.5 rounded-full", configured ? "bg-success" : "bg-raised-hover")} />
          <span>{t("voice.chatterboxServer")}</span>
          {configured && <span className="text-[11px] text-success">{t("voice.saved")}</span>}
        </div>
        <div className="flex gap-2">
          <input
            type="url"
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void saveServer()}
            placeholder="http://127.0.0.1:4123"
            aria-label={t("voice.chatterboxServerAddress")}
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none"
          />
          <button
            onClick={() => void saveServer()}
            disabled={savingServer || !serverUrl.trim()}
            className="flex w-[72px] shrink-0 items-center justify-center gap-1.5 rounded-lg bg-control py-2 text-[13px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {savingServer ? <Loader2 size={13} className="animate-spin" /> : <><Check size={13} />{t("voice.save")}</>}
          </button>
        </div>
        <input
          type="text"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void saveServer()}
          placeholder={t("voice.chatterboxModelPlaceholder")}
          aria-label={t("voice.chatterboxModel")}
          autoComplete="off"
          spellCheck={false}
          className="mt-2 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none"
        />
        <div className="mt-1.5 text-[11.5px] leading-relaxed text-ink-secondary">
          {t("voice.chatterboxHint")}{" "}
          <a
            href="https://github.com/resemble-ai/chatterbox"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-accent hover:underline"
          >
            {t("voice.howToRunLocally")}
          </a>
        </div>
        </div>
      )}

      {configured && (
        <div className="mt-4">
          <div className="mb-1.5 text-[13px] text-ink-secondary">{t("voice.title")}</div>
          <div className="flex gap-2">
            <select
              value={selectedVoice}
              onChange={(e) => chooseVoice(e.target.value)}
              aria-label={t("voice.botVoiceAria", { name: bot.name })}
              data-voice-picker
              className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink focus:outline-none"
            >
              <option value="">
                {loadingVoices
                  ? t("voice.loadingVoices")
                  : usesLocalSystem
                    ? t("voice.macSystemDefault")
                    : tts.voice
                      ? t("voice.installationDefault")
                      : t("voice.pickAVoice")}
              </option>
              {selectedVoice && !voices.some((voice) => voice.id === selectedVoice) && (
                <option value={selectedVoice}>{t("voice.currentAgentVoice")}</option>
              )}
              {voices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                  {v.description ? ` — ${v.description}` : ""}
                </option>
              ))}
            </select>
            <button
              onClick={() => void speaker.speak(t("voice.sample"), { voiceId: bot.voice, botId: bot.id })}
              disabled={!ready}
              title={ready ? t("voice.hearThisVoice") : t("voice.pickFirst")}
              aria-label={t("voice.hearThisVoice")}
              className="flex w-[72px] shrink-0 items-center justify-center gap-1.5 rounded-lg bg-control py-2 text-[13px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Volume2 size={14} /> {t("voice.try")}
            </button>
          </div>
        </div>
      )}

      <div className="mt-4 flex items-center justify-between gap-4 border-t border-hairline/40 pt-4">
        <div>
          <div className="text-[13px] font-medium text-ink">{t("voice.readAloud")}</div>
          <div className="mt-0.5 text-[11.5px] leading-relaxed text-ink-secondary">
            {t("voice.readAloudHint")}
          </div>
        </div>
        <Switch
          checked={Boolean(bot.speakReplies)}
          aria-label={t("voice.readAloudAria")}
          onClick={() => onPatch({ speakReplies: !bot.speakReplies })}
        />
      </div>

      <div className="mt-4 flex items-center justify-between gap-4">
        <div>
          <div className="text-[13px] font-medium text-ink">{t("voice.notes")}</div>
          <div className="mt-0.5 text-[11.5px] leading-relaxed text-ink-secondary">
            {t("voice.notesHint")}
          </div>
        </div>
        <Switch
          checked={bot.voiceNotes !== false}
          aria-label={t("voice.notesAria")}
          onClick={() => onPatch({ voiceNotes: bot.voiceNotes === false })}
        />
      </div>

      {error && <div role="alert" className="mt-2 text-[12px] text-danger">{error}</div>}
    </div>
  );
}
