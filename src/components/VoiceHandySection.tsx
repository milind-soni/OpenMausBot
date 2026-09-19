// Voice & Handy: the two engines behind Astra's voice. The first card is the
// workspace's spoken-reply voice — engine, credential, and the voice every
// agent falls back to. The cards under it own the user's own Handy app: the
// offline dictation engine, the model Astra pins for its own calls, and the
// wake word that feeds the composer.
//
// The voice list comes from the harness, which holds the provider key — the
// renderer never talks to ElevenLabs itself. Handy is read-only apart from
// that per-call pin on purpose: Astra never rewrites Handy's own settings
// file, which would change dictation in every other app on this machine.
import { useCallback, useEffect, useState } from "react";
import { Check, Loader2, Volume2 } from "lucide-react";

import { handyModel, handyPath, setHandyModel, setHandyPath } from "@/lib/handy";
import { t } from "@/lib/i18n";
import { speaker } from "@/lib/tts";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { cn } from "@/lib/cn";
import { ApiKeyRow } from "./ApiKeys";
import { HandyEngineReadout } from "./HandyEngineReadout";
import { Card, Switch } from "./SettingsPrimitives";

/** What a voice preview speaks: long enough to hear the voice's character,
 *  short enough to answer in a second or two. */
const SAMPLE = "Morning. Overnight the tests went green, and I left two notes for you in the thread.";

/** The shell's read-only view of the user's Handy install, derived from the
 *  bridge declaration rather than re-declared, so this panel and the preload
 *  cannot drift apart. */
type HandyEngine = Awaited<ReturnType<NonNullable<NonNullable<Window["ogb"]>["handyModels"]>>>;

export interface VoiceChoice {
  id: string;
  label: string;
  description?: string;
}

/** The voice list as rows. Pure props on purpose: every component test in this
 *  repo renders static markup, where effects never run, so a picker that
 *  fetched its own list could not be tested at all. */
export function VoicePicker({
  voices,
  selected,
  disabled = false,
  canPreview = true,
  onSelect,
  onPreview,
}: {
  voices: VoiceChoice[];
  selected: string;
  /** A config write is in flight; the rows wait for it. */
  disabled?: boolean;
  /** The engine can speak right now — a Try button without a key is a dead end. */
  canPreview?: boolean;
  onSelect: (voiceId: string) => void;
  onPreview: (voiceId: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5" role="group" aria-label={t("settings.voice.voices")}>
      {voices.map((voice) => {
        const chosen = voice.id === selected;
        return (
          <div
            key={voice.id}
            className={cn(
              "flex items-center gap-2 rounded-lg border px-3 py-2",
              chosen ? "border-accent/40 bg-raised" : "border-hairline/30 bg-inset",
            )}
          >
            <button
              type="button"
              aria-pressed={chosen}
              disabled={disabled}
              onClick={() => onSelect(voice.id)}
              className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-wait disabled:opacity-60"
            >
              <span className={cn("size-1.5 shrink-0 rounded-full", chosen ? "bg-accent" : "bg-raised-hover")} />
              <span className="truncate text-[13px] text-ink">{voice.label}</span>
              {voice.description ? (
                <span className="truncate text-[12px] text-ink-secondary">{voice.description}</span>
              ) : null}
            </button>
            <button
              type="button"
              disabled={disabled || !canPreview}
              onClick={() => onPreview(voice.id)}
              aria-label={t("settings.voice.tryAria", { voice: voice.label })}
              title={t("settings.voice.try")}
              className="shrink-0 rounded p-1 text-ink-secondary hover:bg-raised hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Volume2 size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** The workspace default: which engine speaks, the credential it needs, and
 *  the voice every agent without one of its own falls back to. */
function VoiceCard() {
  const { state, dispatch } = useStore();
  const tts = state.config?.tts;

  const [voices, setVoices] = useState<VoiceChoice[]>([]);
  const [loadingVoices, setLoadingVoices] = useState(false);
  const [key, setKey] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [savingVoice, setSavingVoice] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const provider = tts?.provider ?? "elevenlabs";
  const hostPlatform = window.ogb?.platform;
  const systemVoicesAvailable = hostPlatform === "darwin" || hostPlatform === "win32";
  const piperAvailable = tts?.piperAvailable === true;
  const piperInstallable = tts?.piperInstallable === true;
  // The server keeps installing after the 202, so its flag outlives this
  // request and decides the label; the local flag covers the round trip.
  const piperInstalling = tts?.piperInstalling === true || installing;
  const piperInstallError = tts?.piperInstallError ?? installError;
  const configured = tts?.configured === true;

  // The harness owns the voice list; it is the one holding the provider key.
  useEffect(() => {
    if (!configured) {
      setVoices([]);
      return;
    }
    let alive = true;
    setLoadingVoices(true);
    api("/api/tts/voices")
      .then((r: { voices?: VoiceChoice[]; error?: string }) => {
        if (!alive) return;
        setVoices(r.voices ?? []);
        if (r.error) setError(r.error);
      })
      .catch(() => alive && setVoices([]))
      .finally(() => alive && setLoadingVoices(false));
    return () => {
      alive = false;
    };
  }, [configured, provider]);

  const installPiper = async () => {
    if (piperInstalling) return;
    setInstalling(true);
    setInstallError(null);
    try {
      await api("/api/tts/piper/install", { method: "POST" });
    } catch (cause) {
      setInstallError(cause instanceof Error ? cause.message : t("settings.voice.error"));
    } finally {
      setInstalling(false);
    }
  };

  const setProvider = (next: "elevenlabs" | "system" | "piper") => {
    if (next === provider || switching || (next === "system" && !systemVoicesAvailable)) return;
    setSwitching(true);
    setError(null);
    // the provider is a setting, not a secret — it rides the ordinary config
    // write, and the key row appears or disappears with it
    api("/api/config", { method: "PUT", body: JSON.stringify({ tts: { provider: next } }) })
      .then((status: ConfigStatus) => dispatch({ type: "configStatus", config: status }))
      .catch((cause: Error) => setError(cause.message))
      .finally(() => setSwitching(false));
  };

  const chooseVoice = (voiceId: string) => {
    if (savingVoice || voiceId === (tts?.voice ?? "")) return;
    setSavingVoice(true);
    setError(null);
    api("/api/config", { method: "PUT", body: JSON.stringify({ tts: { voice: voiceId } }) })
      .then((status: ConfigStatus) => dispatch({ type: "configStatus", config: status }))
      .catch((cause: Error) => setError(cause.message))
      .finally(() => setSavingVoice(false));
  };

  const saveKey = () => {
    const nextKey = key.trim();
    if (!nextKey) return;
    setSavingKey(true);
    setError(null);
    const request = window.ogb?.setCredential
      ? window.ogb.setCredential("ttsKey", nextKey)
      : api("/api/config", { method: "PUT", body: JSON.stringify({ tts: { key: nextKey } }) });
    request
      .then((status: ConfigStatus) => {
        dispatch({ type: "configStatus", config: status });
        setKey("");
      })
      .catch((cause: Error) => setError(cause.message))
      .finally(() => setSavingKey(false));
  };

  if (!tts) return null;

  const selected = tts.voice ?? "";
  // A selection that is not in the engine's catalog (a Piper voice since
  // removed, another machine's voice) stays visible as the current choice
  // instead of silently reading as "nothing selected".
  const rows =
    selected && !voices.some((voice) => voice.id === selected)
      ? [{ id: selected, label: selected, description: t("settings.voice.current") }, ...voices]
      : voices;

  return (
    <Card title={t("settings.voice.title")} subtitle={t("settings.voice.subtitle")}>
      <div className="flex flex-col gap-4">
        <div>
          <div className="mb-2 text-[13px] text-ink-secondary">{t("settings.voice.engine")}</div>
          <div className="inline-flex rounded-xl bg-inset p-1" role="radiogroup" aria-label={t("settings.voice.engine")}>
            {([
              { value: "elevenlabs", label: t("settings.voice.engine.elevenlabs"), available: true, unavailableReason: undefined },
              {
                value: "piper",
                label: t("settings.voice.engine.piper"),
                available: piperAvailable,
                unavailableReason: piperInstallable
                  ? t("settings.voice.engine.piperMissing")
                  : t("settings.voice.engine.piperUnprovisioned"),
              },
              {
                value: "system",
                label:
                  hostPlatform === "win32"
                    ? t("settings.voice.engine.builtInWindows")
                    : hostPlatform === "darwin"
                      ? t("settings.voice.engine.builtInMac")
                      : t("settings.voice.engine.builtIn"),
                available: systemVoicesAvailable,
                unavailableReason: t("settings.voice.engine.builtInUnavailable"),
              },
            ] as const).map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={provider === option.value}
                disabled={switching || !option.available}
                title={option.unavailableReason}
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
                {piperInstalling ? t("settings.voice.installingPiper") : t("settings.voice.installPiper")}
              </button>
              <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">{t("settings.voice.piperDetail")}</p>
              {piperInstallError ? (
                <p role="alert" className="mt-1 text-[12px] text-danger">
                  {piperInstallError}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>

        {provider === "elevenlabs" && (
          <div>
            <div className="mb-1.5 flex items-center gap-2 text-[13px] text-ink-secondary">
              <span className={cn("size-1.5 rounded-full", configured ? "bg-success" : "bg-raised-hover")} />
              <span>{t("settings.voice.key")}</span>
              {configured ? <span className="text-[11px] text-success">{t("settings.voice.key.connected")}</span> : null}
            </div>
            <div className="flex gap-2">
              <input
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && key.trim() && saveKey()}
                placeholder={configured ? t("settings.voice.key.placeholderSaved") : t("settings.voice.key.placeholder")}
                aria-label={t("settings.voice.key")}
                autoComplete="off"
                className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
              />
              <button
                type="button"
                onClick={saveKey}
                disabled={savingKey || !key.trim()}
                className="flex w-[72px] shrink-0 items-center justify-center gap-1.5 rounded-lg bg-control py-2 text-[13px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {savingKey ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <>
                    <Check size={13} />
                    {t("settings.voice.save")}
                  </>
                )}
              </button>
            </div>
            {!configured ? (
              <a
                href="https://elevenlabs.io/app/settings/api-keys"
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1.5 inline-block text-[12px] font-medium text-accent hover:underline"
              >
                {t("settings.voice.key.get")}
              </a>
            ) : null}
          </div>
        )}

        <div>
          <div className="mb-1.5 text-[13px] text-ink-secondary">{t("settings.voice.voices")}</div>
          {loadingVoices ? (
            <p className="text-[12.5px] text-ink-secondary">{t("settings.voice.loading")}</p>
          ) : rows.length ? (
            <VoicePicker
              voices={rows}
              selected={selected}
              disabled={savingVoice}
              canPreview={configured}
              onSelect={chooseVoice}
              onPreview={(voiceId) => void speaker.speak(SAMPLE, { voiceId })}
            />
          ) : (
            <p className="text-[12.5px] leading-relaxed text-ink-secondary">{t("settings.voice.empty")}</p>
          )}
        </div>

        {error ? (
          <p role="alert" className="text-[12px] text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </Card>
  );
}

/** The user's own Handy install: where it lives and which of its models Astra
 *  pins for its own dictation and calls. Read-only on Handy's side — the pin
 *  is passed per call, never written into Handy's own settings. */
function HandyCard() {
  const [path, setPath] = useState(handyPath());
  const [engine, setEngine] = useState<HandyEngine | null>(null);
  const [pinned, setPinned] = useState(handyModel());

  // Read-only: which model Handy would transcribe with, what is on disk, and
  // what this machine can carry. Re-read on mount and when the path is edited,
  // so the panel never describes an engine the user has pointed elsewhere.
  const refreshEngine = useCallback((candidate: string) => {
    const bridge = window.ogb;
    if (!bridge?.handyModels) return;
    void bridge
      .handyModels(candidate)
      .then((status) => setEngine(status))
      .catch(() => setEngine(null));
  }, []);

  useEffect(() => {
    refreshEngine(handyPath());
  }, [refreshEngine]);

  return (
    <Card title={t("settings.handy.title")} subtitle={t("settings.handy.subtitle")}>
      <div className="flex flex-col gap-3">
        <div>
          <div className="mb-1.5 text-[13px] text-ink-secondary">{t("settings.wakeWord.handyPath")}</div>
          <input
            aria-label={t("settings.wakeWord.handyPath")}
            type="text"
            value={path}
            onChange={(e) => {
              setPath(e.target.value);
              setHandyPath(e.target.value);
            }}
            onBlur={() => refreshEngine(path)}
            placeholder="%LOCALAPPDATA%\Handy\handy.exe"
            spellCheck={false}
            className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
          />
          <p className="mt-1.5 text-[12px] leading-relaxed text-ink-secondary">{t("settings.wakeWord.handyPathHint")}</p>
        </div>
        {engine ? (
          <HandyEngineReadout
            status={engine}
            pinned={pinned}
            onPin={(model) => {
              setPinned(model);
              setHandyModel(model);
            }}
          />
        ) : null}
      </div>
    </Card>
  );
}

/** The Picovoice wake word: the trigger that turns speech into a dictated
 *  draft, transcribed by the Handy engine above. */
function WakeWordCard() {
  const { state, dispatch } = useStore();
  const enabled = state.config?.features?.wakeWord === true;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const toggle = async () => {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ features: { wakeWord: !enabled } }),
      });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.wakeWord.error"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card title={t("settings.wakeWord.title")} subtitle={t("settings.wakeWord.subtitle")}>
      <div className="flex flex-col gap-3">
        <ApiKeyRow section="wakeWord" />
        <div className="flex items-center justify-between gap-4">
          <div className="text-[14px] font-medium text-ink">{t("settings.wakeWord.enable")}</div>
          <Switch
            checked={enabled}
            aria-label={t("settings.wakeWord.enable")}
            disabled={saving}
            onClick={() => void toggle()}
            className="disabled:cursor-wait disabled:opacity-50"
          />
        </div>
        {error ? (
          <p role="alert" className="text-[12px] text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </Card>
  );
}

/** Settings → Voice & Handy: voice output on top (the workspace default voice),
 *  voice input below (the user's Handy for dictation and calls, then the wake
 *  word that feeds the composer). */
export function VoiceHandySection() {
  return (
    <div className="flex flex-col gap-4">
      <VoiceCard />
      <HandyCard />
      <WakeWordCard />
    </div>
  );
}



