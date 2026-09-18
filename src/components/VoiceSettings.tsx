// Per-agent voice profile. The key is shared; the voice and autoplay choice
// belong to the selected bot.
//
// The voice list comes from the harness, which holds the key — the
// renderer never talks to ElevenLabs itself.
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
import { cn } from "@/lib/cn";
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

  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [voices, setVoices] = useState<Array<{ id: string; label: string; description?: string }>>([]);
  const [loadingVoices, setLoadingVoices] = useState(false);

  const { capabilities } = useDesktopCapabilities();
  const localDeviceClient = workspaceConfigurationLocked && localSystemVoicesAvailable();
  const [deviceProvider, setDeviceProvider] = useState<RemoteVoiceProvider>(() => remoteVoiceProvider());
  const [deviceVoice, setDeviceVoice] = useState(() => remoteSystemVoice(bot.id));
  const usesLocalSystem = localDeviceClient && deviceProvider === "system";
  // Host configuration still controls host-rendered ElevenLabs audio. A
  // paired Mac owns its installed-voice choice locally.
  const provider = tts?.provider ?? "elevenlabs";
  // The zero-key engine exists wherever the host OS ships voices: `say` on
  // macOS, SAPI on Windows. Both are on-device and work offline.
  const hostPlatform = capabilities.host.platform;
  const systemVoicesAvailable = hostPlatform === "darwin" || hostPlatform === "win32";
  // Piper's availability is what the server reports: the engine is
  // provisioned per machine, so the option only appears when it exists — and
  // where this platform has a build, it can be installed from right here.
  const piperAvailable = tts?.piperAvailable === true;
  const piperInstallable = tts?.piperInstallable === true;
  const [installBusy, setInstallBusy] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  // The server keeps installing after the 202, so its flag outlives this
  // request and decides the label; the local flag covers the round trip.
  const piperInstalling = tts?.piperInstalling === true || installBusy;
  const piperInstallError = tts?.piperInstallError ?? installError;

  const installPiper = async () => {
    if (piperInstalling) return;
    setInstallBusy(true);
    setInstallError(null);
    try {
      await api("/api/tts/piper/install", { method: "POST" });
    } catch (cause) {
      setInstallError(cause instanceof Error ? cause.message : "Piper could not be installed.");
    } finally {
      setInstallBusy(false);
    }
  };
  const hostConfigured = Boolean(tts?.configured);
  const configured = usesLocalSystem || hostConfigured;

  useEffect(() => {
    setDeviceVoice(remoteSystemVoice(bot.id));
  }, [bot.id]);

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

  const setProvider = (next: "elevenlabs" | "system" | "piper") => {
    if (next === provider || switching || (next === "system" && !systemVoicesAvailable)) return;
    setSwitching(true);
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
    if (!nextKey) return Promise.resolve();
    setSaving(true);
    setError(null);
    const request = window.ogb?.setCredential
      ? window.ogb.setCredential("ttsKey", nextKey)
      : api("/api/config", { method: "PUT", body: JSON.stringify({ tts: { key: nextKey } }) });
    return request
      .then((status: ConfigStatus) => {
        dispatch({ type: "configStatus", config: status });
        setKey("");
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setSaving(false));
  };

  if (!tts) return null;

  const selectedVoice = usesLocalSystem ? deviceVoice : (bot.voice ?? "");
  const ready = usesLocalSystem || (hostConfigured && Boolean(selectedVoice || tts.voice));

  return (
    <div className="rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">Voice</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">
        {localDeviceClient
          ? "Choose whether this device speaks with its installed voices or audio generated by the host."
          : workspaceConfigurationLocked
            ? "Choose this agent’s voice and spoken-reply preference."
            : <>Give this agent a voice for calls and spoken replies. The voice choice belongs to this agent;
              {provider === "system"
                ? systemVoicesAvailable
                  ? " the voices are the ones already installed on this computer — no key, works offline."
                  : " built-in voices are unavailable here. Switch to ElevenLabs to keep using voice."
                : provider === "piper"
                  ? " the voice is a neural model that runs on this computer — no key, works offline."
                  : " the ElevenLabs key is shared by the workspace."}</>}
      </div>

      {localDeviceClient && (
        <div className="mt-4">
          <div className="mb-2 text-[13px] text-ink-secondary">Voice output on this device</div>
          <div className="inline-flex rounded-xl bg-inset p-1" role="radiogroup" aria-label="Voice output on this device">
            {([
              { value: "system", label: "Built-in device voices", available: true },
              { value: "host", label: provider === "elevenlabs" ? "Host · ElevenLabs" : "Host voice", available: hostConfigured },
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

      {!workspaceConfigurationLocked &&
        (systemVoicesAvailable || provider === "system" || provider === "piper" || piperAvailable || piperInstallable) && (
        <div className="mt-4">
          <div className="mb-2 text-[13px] text-ink-secondary">Voice engine</div>
          <div className="inline-flex rounded-xl bg-inset p-1" role="radiogroup" aria-label="Voice engine">
            {([
              { value: "elevenlabs", label: "ElevenLabs", available: true, unavailableReason: null },
              {
                value: "piper",
                label: "Piper · realistic, offline",
                available: piperAvailable,
                unavailableReason: piperInstallable
                  ? "Piper is not installed on this machine yet — install it below"
                  : "Piper is not provisioned on this machine yet — see the docs for the one-time setup",
              },
              {
                value: "system",
                label: hostPlatform === "win32" ? "Built-in Windows voices" : "Built-in Mac voices",
                available: systemVoicesAvailable,
                unavailableReason: "Built-in voices are available on macOS and Windows",
              },
            ] as const).map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={provider === option.value}
                disabled={switching || !option.available}
                title={option.unavailableReason ?? undefined}
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
          {!piperAvailable && piperInstallable ? (
            <div className="mt-3">
              <button
                type="button"
                disabled={piperInstalling}
                onClick={() => void installPiper()}
                className={cn(
                  "rounded-lg border border-hairline/40 px-3 py-1.5 text-[12.5px] text-ink transition-colors hover:border-hairline disabled:opacity-50",
                  piperInstalling && "cursor-wait",
                )}
              >
                {piperInstalling ? "Installing Piper…" : "Install Piper"}
              </button>
              <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">
                Neural voices that run on this computer. One download (the engine and one voice) into this
                workspace's data folder, checked against a pinned hash before it is unpacked.
              </p>
              {piperInstallError ? (
                <p role="alert" className="mt-1 text-[12px] text-danger">
                  {piperInstallError}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      )}

      {!workspaceConfigurationLocked && provider === "elevenlabs" && (
        <div className="mt-4">
        <div className="mb-1.5 flex items-center gap-2 text-[13px] text-ink-secondary">
          <span className={cn("size-1.5 rounded-full", configured ? "bg-success" : "bg-raised-hover")} />
          <span>ElevenLabs key</span>
          {configured && <span className="text-[11px] text-success">Connected</span>}
        </div>
        <div className="flex gap-2">
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && key.trim() && void saveKey()}
            placeholder={configured ? "••••••••  (paste to replace)" : "Paste your ElevenLabs API key"}
            aria-label="ElevenLabs key"
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
            href="https://elevenlabs.io/app/settings/api-keys"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1.5 inline-block text-[12px] font-medium text-accent hover:underline"
          >
            Get a key from ElevenLabs
          </a>
        )}
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
                      ? "Workspace default"
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
