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
import { cn } from "@/lib/cn";
import { voiceKeyDraftValue, type VoiceKeyDraft } from "@/lib/voice-key-draft";
import { Switch } from "./SettingsPrimitives";

const SAMPLE = "Morning. Overnight the tests went green, and I left two notes for you in the thread.";

export function VoiceSettings({
  bot,
  onPatch,
  workspaceConfigurationLocked = false,
}: {
  bot: Bot;
  onPatch: (patch: Partial<Pick<Bot, "voice" | "speakReplies">>) => void;
  workspaceConfigurationLocked?: boolean;
}) {
  const { state, dispatch } = useStore();
  const tts = state.config?.tts;

  const [keyDraft, setKeyDraft] = useState<VoiceKeyDraft>({ provider: null, value: "" });
  const [serverUrl, setServerUrl] = useState("");
  const [model, setModel] = useState("");
  const [saving, setSaving] = useState(false);
  const [savingServer, setSavingServer] = useState(false);
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
        placeholder: "Paste your Fish Audio API key",
        keyUrl: "https://fish.audio/app/api-keys/",
      }
    : provider === "elevenlabs"
      ? {
          id: "elevenlabs" as const,
          name: "ElevenLabs",
          credential: "ttsKey" as const,
          configField: "key" as const,
          placeholder: "Paste your ElevenLabs API key",
          keyUrl: "https://elevenlabs.io/app/settings/api-keys",
        }
      : null;
  const key = cloudProvider ? voiceKeyDraftValue(keyDraft, cloudProvider.id) : "";
  const hostProviderLabel = provider === "fish"
    ? "Host · Fish Audio"
    : provider === "elevenlabs"
      ? "Host · ElevenLabs"
      : provider === "chatterbox"
        ? "Host · Chatterbox"
        : provider === "xai" ? t("voice.grok.host") : "Host voice";
  const systemVoicesAvailable = capabilities.host.platform === "darwin";
  const hostConfigured = Boolean(tts?.configured);
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
      setError("The server address must start with http:// or https://");
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

  if (!tts) return null;

  const selectedVoice = usesLocalSystem ? deviceVoice : (bot.voice ?? "");
  const ready = usesLocalSystem || (hostConfigured && Boolean(selectedVoice || tts.voice));

  return (
    <div className="rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">Voice</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">
        {localMacClient
          ? "Choose whether this Mac speaks with its installed voices or audio generated by the host."
          : workspaceConfigurationLocked
            ? "Choose this agent’s voice and spoken-reply preference."
            : <>Give this agent a voice for calls and spoken replies. The voice choice belongs to this agent;
              {provider === "system"
                ? systemVoicesAvailable
                  ? " the voices are the ones already installed on this Mac."
                  : " built-in Mac voices are unavailable here. Switch to a hosted voice provider to keep using voice."
                : provider === "xai"
                  ? ` ${t("voice.grok.sharedKey")}`
                : provider === "chatterbox"
                  ? " the Chatterbox server address is shared by this installation."
                  : ` the ${cloudProvider?.name ?? "voice provider"} key is shared by this installation.`}</>}
      </div>

      {localMacClient && (
        <div className="mt-4">
          <div className="mb-2 text-[13px] text-ink-secondary">Voice output on this Mac</div>
          <div className="inline-flex rounded-xl bg-inset p-1" role="radiogroup" aria-label="Voice output on this Mac">
            {([
              { value: "system", label: "Built-in Mac voices", available: true },
              { value: "host", label: hostProviderLabel, available: hostConfigured },
            ] as const).map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={deviceProvider === option.value}
                disabled={!option.available}
                title={!option.available ? "Voice output is not configured on the host" : undefined}
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
          <div className="mb-2 text-[13px] text-ink-secondary">Voice engine</div>
          <div className="grid grid-cols-2 gap-1 rounded-xl bg-inset p-1" role="radiogroup" aria-label="Voice engine">
            {([
              { value: "elevenlabs", label: "ElevenLabs", available: true },
              { value: "fish", label: "Fish Audio", available: true },
              { value: "system", label: "Built-in Mac voices", available: systemVoicesAvailable },
              { value: "chatterbox", label: "Chatterbox (local)", available: true },
              { value: "xai", label: t("voice.grok.label"), available: true },
            ] as const).map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={provider === option.value}
                disabled={switching || !option.available}
                title={!option.available ? "Built-in voices are available only on macOS" : undefined}
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
          <span>{cloudProvider.name} key</span>
          {configured && <span className="text-[11px] text-success">Connected</span>}
        </div>
        <div className="flex gap-2">
          <input
            type="password"
            value={key}
            onChange={(e) => setKeyDraft({ provider: cloudProvider.id, value: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && key.trim() && void saveKey()}
            placeholder={configured ? "••••••••  (paste to replace)" : cloudProvider.placeholder}
            aria-label={`${cloudProvider.name} key`}
            autoComplete="off"
            className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
          />
          <button
            onClick={() => void saveKey()}
            disabled={saving || !key.trim()}
            className="flex w-[72px] shrink-0 items-center justify-center gap-1.5 rounded-lg bg-control py-2 text-[13px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <><Check size={13} />Save</>}
          </button>
        </div>
        {!configured && (
          <a
            href={cloudProvider.keyUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1.5 inline-block text-[12px] font-medium text-accent hover:underline"
          >
            Get a key from {cloudProvider.name}
          </a>
        )}
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
          <span>Chatterbox server</span>
          {configured && <span className="text-[11px] text-success">Saved</span>}
        </div>
        <div className="flex gap-2">
          <input
            type="url"
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void saveServer()}
            placeholder="http://127.0.0.1:4123"
            aria-label="Chatterbox server address"
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
          />
          <button
            onClick={() => void saveServer()}
            disabled={savingServer || !serverUrl.trim()}
            className="flex w-[72px] shrink-0 items-center justify-center gap-1.5 rounded-lg bg-control py-2 text-[13px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {savingServer ? <Loader2 size={13} className="animate-spin" /> : <><Check size={13} />Save</>}
          </button>
        </div>
        <input
          type="text"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void saveServer()}
          placeholder="Model id — default chatterbox-turbo"
          aria-label="Chatterbox model"
          autoComplete="off"
          spellCheck={false}
          className="mt-2 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
        />
        <div className="mt-1.5 text-[11.5px] leading-relaxed text-ink-secondary">
          Any OpenAI-compatible server running Chatterbox works, no key needed.{" "}
          <a
            href="https://github.com/resemble-ai/chatterbox"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-accent hover:underline"
          >
            How to run one locally
          </a>
        </div>
        </div>
      )}

      {configured && (
        <div className="mt-4">
          <div className="mb-1.5 text-[13px] text-ink-secondary">Voice</div>
          <div className="flex gap-2">
            <select
              value={selectedVoice}
              onChange={(e) => chooseVoice(e.target.value)}
              aria-label={`${bot.name}'s voice`}
              className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink focus:border-hairline focus:outline-none"
            >
              <option value="">
                {loadingVoices
                  ? "Loading voices…"
                  : usesLocalSystem
                    ? "Mac system default"
                    : tts.voice
                      ? "Installation default"
                      : "Pick a voice"}
              </option>
              {selectedVoice && !voices.some((voice) => voice.id === selectedVoice) && (
                <option value={selectedVoice}>Current agent voice</option>
              )}
              {voices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                  {v.description ? ` — ${v.description}` : ""}
                </option>
              ))}
            </select>
            <button
              onClick={() => void speaker.speak(SAMPLE, { voiceId: bot.voice, botId: bot.id })}
              disabled={!ready}
              title={ready ? "Hear this voice" : "Pick a voice first"}
              aria-label="Hear this voice"
              className="flex w-[72px] shrink-0 items-center justify-center gap-1.5 rounded-lg bg-control py-2 text-[13px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Volume2 size={14} /> Try
            </button>
          </div>
        </div>
      )}

      <div className="mt-4 flex items-center justify-between gap-4 border-t border-hairline/40 pt-4">
        <div>
          <div className="text-[13px] font-medium text-ink">Read replies aloud</div>
          <div className="mt-0.5 text-[11.5px] leading-relaxed text-ink-secondary">
            Speak this agent's answers as they arrive, even from another chat.
          </div>
        </div>
        <Switch
          checked={Boolean(bot.speakReplies)}
          aria-label="Read this bot's replies aloud"
          onClick={() => onPatch({ speakReplies: !bot.speakReplies })}
        />
      </div>

      {error && <div role="alert" className="mt-2 text-[12px] text-danger">{error}</div>}
    </div>
  );
}
