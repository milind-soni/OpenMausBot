// Security: the harness holds the cloud provider keys; the renderer never talks to ElevenLabs or Fish Audio itself.
import { useEffect, useRef, useState } from "react";
import { Check, Loader2, Volume2 } from "lucide-react";

import { api, useStore, type Bot, type ConfigStatus } from "@/state/store";
import { useDesktopCapabilities } from "@/components/DesktopCapabilities";
import { speaker } from "@/lib/tts";
import { useSpeech } from "@/lib/tts/useSpeech";
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
import { cn } from "@/lib/cn";
import { voiceKeyDraftValue, type VoiceKeyDraft } from "@/lib/voice-key-draft";
import { VoicePicker, type PickerVoice } from "./VoicePicker";
import { Select } from "./Select";
import { Switch } from "./SettingsPrimitives";
import { KeysLink } from "./keys/KeysLink";

const SAMPLE = "Morning. Overnight the tests went green, and I left two notes for you in the thread.";
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
  const [addingVoice, setAddingVoice] = useState<PickerVoice | null>(null);
  const addGeneration = useRef(0);
  const [addError, setAddError] = useState<string | null>(null);
  const [voiceQuery, setVoiceQuery] = useState("");
  const [searchedQuery, setSearchedQuery] = useState("");

  const { capabilities } = useDesktopCapabilities();
  const speech = useSpeech();
  const preparingSample = speech.status === "preparing" && speech.botId === bot.id && !speech.messageId;
  const localMacClient = workspaceConfigurationLocked && localSystemVoicesAvailable();
  const [deviceProvider, setDeviceProvider] = useState<RemoteVoiceProvider>(() => remoteVoiceProvider());
  const [deviceVoice, setDeviceVoice] = useState(() => remoteSystemVoice(bot.id));
  const usesLocalSystem = localMacClient && deviceProvider === "system";
  const provider = tts?.provider ?? "elevenlabs";
  const searchable = (provider === "fish" || provider === "elevenlabs") && !usesLocalSystem;
  const voiceSearch = searchable ? searchedQuery : "";
  const pickedVoice = searchable ? (bot.voice ?? "") : "";
  const cloudProvider = provider === "fish"
    ? {
        id: "fish" as const,
        name: "Fish Audio",
        credential: "fishAudioKey" as const,
        configField: "fishKey" as const,
        placeholder: t("voice.fish.keyPlaceholder"),
        keyUrl: "https://fish.audio/app/api-keys/",
      }
    : provider === "elevenlabs"
      ? {
          id: "elevenlabs" as const,
          name: "ElevenLabs",
          credential: "ttsKey" as const,
          configField: "key" as const,
          placeholder: t("voice.elevenlabs.keyPlaceholder"),
          keyUrl: "https://elevenlabs.io/app/settings/api-keys",
        }
      : null;
  const key = cloudProvider ? voiceKeyDraftValue(keyDraft, cloudProvider.id) : "";
  const hostProviderLabel = provider === "fish"
    ? t("voice.hostLabel", { provider: t("voice.fish.label") })
    : provider === "elevenlabs"
      ? t("voice.hostLabel", { provider: t("voice.elevenlabs.label") })
      : provider === "chatterbox"
        ? t("voice.hostLabel", { provider: t("voice.chatterboxLabel") })
        : provider === "xai" ? t("voice.grok.host") : t("voice.host");
  const systemVoicesAvailable = capabilities.host.platform === "darwin";
  const hostConfigured = Boolean(tts?.configured);
  const included = Boolean(tts?.included);
  const configured = usesLocalSystem || hostConfigured;

  useEffect(() => {
    setDeviceVoice(remoteSystemVoice(bot.id));
  }, [bot.id]);

  const sampleVoice = usesLocalSystem ? deviceVoice : bot.voice;
  useEffect(() => () => {
    const playing = speaker.state;
    if (playing.status !== "idle" && playing.botId === bot.id && !playing.messageId) speaker.stop();
  }, [bot.id, sampleVoice, provider]);

  useEffect(() => {
    const timer = setTimeout(() => setSearchedQuery(voiceQuery.trim()), 300);
    return () => clearTimeout(timer);
  }, [voiceQuery]);

  useEffect(() => setVoiceQuery(""), [provider]);

  useEffect(() => {
    setServerUrl(tts?.baseUrl ?? "");
    setModel(tts?.model ?? "");
  }, [tts?.baseUrl, tts?.model]);

  // Security: discard the draft on every provider change, and keep it tagged, so one provider's credential never goes
  // to another service.
  useEffect(() => {
    setKeyDraft({ provider: null, value: "" });
  }, [provider]);

  useEffect(() => setVoices([]), [provider, usesLocalSystem]);

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
    const params = new URLSearchParams();
    if (voiceSearch) params.set("q", voiceSearch);
    if (provider === "fish" && pickedVoice) params.set("current", pickedVoice);
    const query = params.toString();
    api(`/api/tts/voices${query ? `?${query}` : ""}`)
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
  }, [hostConfigured, provider, usesLocalSystem, voiceSearch, pickedVoice]);

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

  // An add that settles after the bot or the provider changed belongs to neither: it must not set this voice.
  useEffect(() => {
    addGeneration.current += 1;
    setAddingVoice(null);
    setAddError(null);
  }, [bot.id, provider]);

  const pickVoice = (voice: PickerVoice) => {
    setAddError(null);
    if (!voice.publicOwnerId) return chooseVoice(voice.id);
    const generation = ++addGeneration.current;
    const current = () => generation === addGeneration.current;
    setAddingVoice(voice);
    api("/api/tts/voices/add", {
      method: "POST",
      body: JSON.stringify({ publicOwnerId: voice.publicOwnerId, voiceId: voice.id, name: voice.label }),
    })
      .then((r: { voiceId: string }) => current() && chooseVoice(r.voiceId))
      .catch((e: Error) => current() && setAddError(e.message))
      .finally(() => current() && setAddingVoice(null));
  };

  const setProvider = (next: "elevenlabs" | "fish" | "system" | "chatterbox" | "xai") => {
    if (next === provider || switching || (next === "system" && !systemVoicesAvailable)) return;
    setSwitching(true);
    setKeyDraft({ provider: null, value: "" });
    setError(null);
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
      setError(t("voice.serverAddressError"));
      return Promise.resolve();
    }
    setSavingServer(true);
    setError(null);
    return api("/api/config", { method: "PUT", body: JSON.stringify({ tts: { baseUrl: next, model: model.trim() } }) })
      .then((status: ConfigStatus) => dispatch({ type: "configStatus", config: status }))
      .catch((e: Error) => setError(e.message))
      .finally(() => setSavingServer(false));
  };

  const saveFishModel = (next: FishModel) => {
    if (next === tts?.fishModel || savingFishModel) return;
    setSavingFishModel(true);
    setError(null);
    api("/api/config", { method: "PUT", body: JSON.stringify({ tts: { fishModel: next } }) })
      .then((status: ConfigStatus) => dispatch({ type: "configStatus", config: status }))
      .catch((e: Error) => setError(e.message))
      .finally(() => setSavingFishModel(false));
  };

  if (!tts) return null;

  const selectedVoice = usesLocalSystem ? deviceVoice : (bot.voice ?? "");
  const ready = usesLocalSystem || (hostConfigured && Boolean(selectedVoice || tts.voice));
  const selectedDescription = voices.find((voice) => voice.id === selectedVoice)?.description;

  return (
    <div className="rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">{t("voice.title")}</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">
        {localMacClient
          ? t("voice.macChoice")
          : workspaceConfigurationLocked
            ? t("voice.agentChoice")
            : <>{t("voice.description")}
              {provider === "system"
                ? systemVoicesAvailable
                  ? ` ${t("voice.macInstalled")}`
                  : ` ${t("voice.macUnavailable")}`
                : provider === "xai"
                  ? ` ${t("voice.grok.sharedKey")}`
                : provider === "chatterbox"
                  ? ` ${t("voice.chatterboxShared")}`
                  : ` ${t("voice.providerShared", { provider: cloudProvider?.name ?? t("voice.provider") })}`}</>}
      </div>

      {localMacClient && (
        <div className="mt-4">
          <div className="mb-2 text-[13px] text-ink-secondary">{t("voice.macOutput")}</div>
          <div className="inline-flex rounded-xl bg-inset p-1" role="radiogroup" aria-label={t("voice.macOutput")}>
            {([
              { value: "system", label: t("voice.macBuiltIn"), available: true },
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
                  "rounded-lg px-3.5 py-1.5 text-[13px] transition-colors disabled:opacity-50",
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
          {/* Six columns: the three online services share the top row, the two on this computer the bottom one. */}
          <div className="grid grid-cols-6 gap-1 rounded-xl bg-inset p-1" role="radiogroup" aria-label={t("voice.engine")}>
            {([
              { value: "elevenlabs", label: t("voice.elevenlabs.label"), available: true, span: "col-span-2" },
              { value: "fish", label: t("voice.fish.label"), available: true, span: "col-span-2" },
              { value: "xai", label: t("voice.grok.label"), available: true, span: "col-span-2" },
              { value: "system", label: t("voice.macBuiltIn"), available: systemVoicesAvailable, span: "col-span-3" },
              { value: "chatterbox", label: t("voice.chatterboxLocal"), available: true, span: "col-span-3" },
            ] as const).map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={provider === option.value}
                disabled={switching || !option.available}
                title={!option.available ? t("voice.macOnly") : undefined}
                onClick={() => setProvider(option.value)}
                className={cn(
                  "min-w-0 rounded-lg px-2 py-1.5 text-[13px] leading-tight transition-colors disabled:opacity-50",
                  option.span,
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
          <span>{t("voice.providerKey", { provider: cloudProvider.name })}</span>
          {configured && <span className="text-[11px] text-success">{included ? t("keys.includedWithCloudPro") : t("voice.connected")}</span>}
        </div>
        <div className="flex gap-2">
          <input
            type="password"
            value={key}
            onChange={(e) => setKeyDraft({ provider: cloudProvider.id, value: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && key.trim() && void saveKey()}
            placeholder={configured && !included ? "••••••••  (paste to replace)" : cloudProvider.placeholder}
            aria-label={`${cloudProvider.name} key`}
            autoComplete="off"
            className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none"
          />
          <button
            onClick={() => void saveKey()}
            disabled={saving || !key.trim()}
            className="flex w-[72px] shrink-0 items-center justify-center gap-1.5 rounded-lg bg-control py-2 text-[13px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <><Check size={13} />{t("common.save")}</>}
          </button>
        </div>
        {!configured && (
          <a
            href={cloudProvider.keyUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1.5 inline-block text-[12px] font-medium text-accent hover:underline"
          >
            {t("voice.getKey", { provider: cloudProvider.name })}
          </a>
        )}
        </div>
      )}

      {!workspaceConfigurationLocked && provider === "fish" && (
        <div className="mt-4">
          <div className="mb-1.5 text-[13px] text-ink-secondary">{t("voice.fish.model")}</div>
          <Select
            value={tts.fishModel ?? "s2.1-pro"}
            onChange={(e) => saveFishModel(e.target.value as FishModel)}
            disabled={savingFishModel}
            aria-label={t("voice.fish.model")}
            className="w-full"
          >
            {FISH_MODELS.map((option) => (
              <option key={option.value} value={option.value}>
                {t(option.label)}
              </option>
            ))}
          </Select>
          <div className="mt-1.5 text-[12px] leading-relaxed text-ink-secondary">{t("voice.fish.modelHint")}</div>
        </div>
      )}

      {provider === "xai" && (
        <p className="mt-4 text-[13px] text-ink-secondary">
          {hostConfigured ? t("voice.grok.ready") : <>{t("voice.grok.missingKey")} <KeysLink id="xai" /></>}
        </p>
      )}

      {!workspaceConfigurationLocked && provider === "chatterbox" && (
        <div className="mt-4">
        <div className="mb-1.5 flex items-center gap-2 text-[13px] text-ink-secondary">
          <span className={cn("size-1.5 rounded-full", configured ? "bg-success" : "bg-raised-hover")} />
          <span>{t("voice.chatterboxServer")}</span>
          {configured && <span className="text-[11px] text-success">{t("common.saved")}</span>}
        </div>
        <div className="flex gap-2">
          <input
            type="url"
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void saveServer()}
            placeholder="http://127.0.0.1:4123"
            aria-label={t("voice.chatterboxAddress")}
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none"
          />
          <button
            onClick={() => void saveServer()}
            disabled={savingServer || !serverUrl.trim()}
            className="flex w-[72px] shrink-0 items-center justify-center gap-1.5 rounded-lg bg-control py-2 text-[13px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {savingServer ? <Loader2 size={13} className="animate-spin" /> : <><Check size={13} />{t("common.save")}</>}
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
        <div className="mt-1.5 text-[12px] leading-relaxed text-ink-secondary">
          {t("voice.chatterboxHelp")}{" "}
          <a
            href="https://github.com/resemble-ai/chatterbox"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-accent hover:underline"
          >
            {t("voice.chatterboxHowTo")}
          </a>
        </div>
        </div>
      )}

      {configured && (
        <div className="mt-4">
          <div className="mb-1.5 text-[13px] text-ink-secondary">{t("voice.title")}</div>
          <div className="flex gap-2">
            {searchable ? (
              <VoicePicker
                key={provider}
                value={selectedVoice}
                voices={voices}
                loading={loadingVoices || voiceQuery.trim() !== searchedQuery}
                query={voiceQuery}
                onQuery={setVoiceQuery}
                onPick={pickVoice}
                pending={addingVoice ?? undefined}
                defaultLabel={tts.voice ? t("voice.installDefault") : t("voice.pick")}
                ariaLabel={`${bot.name}'s voice`}
              />
            ) : (
              <Select
                value={selectedVoice}
                onChange={(e) => chooseVoice(e.target.value)}
                aria-label={`${bot.name}'s voice`}
                data-voice-picker
                className="w-full"
              >
                <option value="">
                  {loadingVoices
                    ? t("voice.loading")
                    : usesLocalSystem
                      ? t("voice.macDefault")
                      : tts.voice
                        ? t("voice.installDefault")
                        : t("voice.pick")}
                </option>
                {selectedVoice && !voices.some((voice) => voice.id === selectedVoice) && (
                  <option value={selectedVoice}>{t("voice.current")}</option>
                )}
                {voices.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
              </Select>
            )}
            <button
              onClick={() => void speaker.speak(SAMPLE, { voiceId: bot.voice, botId: bot.id })}
              disabled={!ready || preparingSample}
              aria-busy={preparingSample}
              title={ready ? t("voice.hear") : t("voice.pickFirst")}
              aria-label={t("voice.hear")}
              className="flex w-[72px] shrink-0 items-center justify-center gap-1.5 rounded-lg bg-control py-2 text-[13px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {preparingSample ? <Loader2 size={14} className="animate-spin" /> : <Volume2 size={14} />} {t("voice.try")}
            </button>
          </div>
          {addError && <div role="alert" className="mt-1.5 text-[12px] text-danger">{addError}</div>}
          {!searchable && selectedDescription && (
            <div className="mt-1.5 text-[12px] leading-relaxed text-ink-secondary">{selectedDescription}</div>
          )}
        </div>
      )}

      <div className="mt-4 flex items-center justify-between gap-4 border-t border-hairline/40 pt-4">
        <div>
          <div className="text-[13px] font-medium text-ink">{t("voice.readReplies")}</div>
          <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
            {t("voice.readRepliesHelp")}
          </div>
        </div>
        <Switch
          checked={Boolean(bot.speakReplies)}
          aria-label={t("voice.readReplies")}
          onClick={() => onPatch({ speakReplies: !bot.speakReplies })}
        />
      </div>

      <div className="mt-4 flex items-center justify-between gap-4">
        <div>
          <div className="text-[13px] font-medium text-ink">{t("voice.notes")}</div>
          <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
            {t("voice.notesHelp")}
          </div>
        </div>
        <Switch
          checked={bot.voiceNotes !== false}
          aria-label={t("voice.notes")}
          onClick={() => onPatch({ voiceNotes: bot.voiceNotes === false })}
        />
      </div>

      {error && <div role="alert" className="mt-2 text-[12px] text-danger">{error}</div>}
    </div>
  );
}
