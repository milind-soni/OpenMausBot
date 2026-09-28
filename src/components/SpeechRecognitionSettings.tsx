// Speech recognition for calls and dictation on Windows and Linux. macOS
// uses Apple's on-device recognizer and never renders this card.
//
// Same rules as VoiceSettings: keys are write-only (the harness reports
// booleans), saved through the OS-encrypted store when the desktop shell
// offers it; provider/address/model/language are ordinary settings.
import { useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";

import { api, useStore, type ConfigStatus } from "@/state/store";
import { cn } from "@/lib/cn";

type Provider = "openai" | "groq" | "xai" | "local";

const PROVIDERS: ReadonlyArray<{ value: Provider; label: string }> = [
  { value: "local", label: "Local server (offline)" },
  { value: "groq", label: "Groq" },
  { value: "openai", label: "OpenAI" },
  { value: "xai", label: "Grok (xAI)" },
];

const CLOUD_KEYS = {
  openai: {
    name: "OpenAI",
    credential: "openaiSttKey" as const,
    field: "openaiKey" as const,
    keyUrl: "https://platform.openai.com/api-keys",
  },
  groq: {
    name: "Groq",
    credential: "groqSttKey" as const,
    field: "groqKey" as const,
    keyUrl: "https://console.groq.com/keys",
  },
};

const inputClass =
  "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none";
const saveClass =
  "flex w-[72px] shrink-0 items-center justify-center gap-1.5 rounded-lg bg-control py-2 text-[13px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50";

export function SpeechRecognitionSettings() {
  const { state, dispatch } = useStore();
  const stt = state.config?.stt;
  const [keyDraft, setKeyDraft] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [model, setModel] = useState("");
  const [language, setLanguage] = useState("");
  const [busy, setBusy] = useState<null | "provider" | "key" | "server" | "language">(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setServerUrl(stt?.baseUrl ?? "");
    setModel(stt?.model ?? "");
    setLanguage(stt?.language ?? "");
  }, [stt?.baseUrl, stt?.model, stt?.language]);

  if (!stt) return null;
  const provider = stt.provider || null;
  const cloud = provider === "openai" || provider === "groq" ? CLOUD_KEYS[provider] : null;
  const keyConfigured = provider === "openai" ? stt.openaiConfigured : provider === "groq" ? stt.groqConfigured : false;

  const write = (kind: NonNullable<typeof busy>, patch: Record<string, string>) => {
    setBusy(kind);
    setError(null);
    return api("/api/config", { method: "PUT", body: JSON.stringify({ stt: patch }) })
      .then((status: ConfigStatus) => dispatch({ type: "configStatus", config: status }))
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(null));
  };

  const chooseProvider = (next: Provider) => {
    if (next === provider || busy) return;
    setKeyDraft("");
    // A model name belongs to one provider; carrying it across would send
    // e.g. a Groq model id to OpenAI.
    void write("provider", { provider: next, model: "" });
  };

  const saveKey = () => {
    const value = keyDraft.trim();
    if (!cloud || !value || busy) return;
    setBusy("key");
    setError(null);
    const request = window.ogb?.setCredential
      ? window.ogb.setCredential(cloud.credential, value)
      : api("/api/config", { method: "PUT", body: JSON.stringify({ stt: { [cloud.field]: value } }) });
    void request
      .then((status: ConfigStatus) => {
        dispatch({ type: "configStatus", config: status });
        setKeyDraft("");
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(null));
  };

  const saveServer = () => {
    const next = serverUrl.trim();
    if (!next || busy) return;
    if (!/^https?:\/\//i.test(next)) {
      setError("The server address must start with http:// or https://");
      return;
    }
    void write("server", { baseUrl: next, model: model.trim() });
  };

  return (
    <div className="rounded-xl bg-card p-4">
      <div className="flex items-center gap-2 text-[15px] font-medium text-ink">
        Speech recognition
        <span className={cn("size-1.5 rounded-full", stt.ready ? "bg-success" : "bg-raised-hover")} />
        {stt.ready && <span className="text-[11px] font-normal text-success">Ready for calls</span>}
      </div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">
        Turns your voice into text for calls and dictation on this computer. Shared by every agent. A local
        Whisper server keeps audio on this machine; a cloud provider receives each spoken turn.
      </div>

      <div className="mt-4">
        <div className="mb-2 text-[13px] text-ink-secondary">Provider</div>
        <div className="grid grid-cols-2 gap-1 rounded-xl bg-inset p-1" role="radiogroup" aria-label="Speech recognition provider">
          {PROVIDERS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={provider === option.value}
              disabled={busy !== null}
              onClick={() => chooseProvider(option.value)}
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

      {cloud && (
        <div className="mt-4">
          <div className="mb-1.5 flex items-center gap-2 text-[13px] text-ink-secondary">
            <span className={cn("size-1.5 rounded-full", keyConfigured ? "bg-success" : "bg-raised-hover")} />
            <span>{cloud.name} key</span>
            {keyConfigured && <span className="text-[11px] text-success">Connected</span>}
          </div>
          <div className="flex gap-2">
            <input
              type="password"
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && saveKey()}
              placeholder={keyConfigured ? "••••••••  (paste to replace)" : `Paste your ${cloud.name} API key`}
              aria-label={`${cloud.name} speech recognition key`}
              autoComplete="off"
              className={inputClass}
            />
            <button onClick={saveKey} disabled={busy !== null || !keyDraft.trim()} className={saveClass}>
              {busy === "key" ? <Loader2 size={13} className="animate-spin" /> : <><Check size={13} />Save</>}
            </button>
          </div>
          {!keyConfigured && (
            <a
              href={cloud.keyUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1.5 inline-block text-[12px] font-medium text-accent hover:underline"
            >
              Get a key from {cloud.name}
            </a>
          )}
        </div>
      )}

      {provider === "xai" && (
        <p className="mt-4 text-[13px] text-ink-secondary">
          {stt.xaiConfigured
            ? "Uses the xAI key already saved for this installation."
            : "Add an xAI key in Settings first; Grok speech recognition reuses it."}
        </p>
      )}

      {provider === "local" && (
        <div className="mt-4">
          <div className="mb-1.5 flex items-center gap-2 text-[13px] text-ink-secondary">
            <span className={cn("size-1.5 rounded-full", stt.ready ? "bg-success" : "bg-raised-hover")} />
            <span>Local speech server (OpenAI-compatible)</span>
          </div>
          <div className="flex gap-2">
            <input
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && saveServer()}
              placeholder="http://127.0.0.1:8000/v1"
              aria-label="Local speech server address"
              className={inputClass}
            />
            <button onClick={saveServer} disabled={busy !== null || !serverUrl.trim()} className={saveClass}>
              {busy === "server" ? <Loader2 size={13} className="animate-spin" /> : <><Check size={13} />Save</>}
            </button>
          </div>
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && saveServer()}
            placeholder="Model (optional, e.g. Systran/faster-whisper-small)"
            aria-label="Local speech model"
            className={cn(inputClass, "mt-2")}
          />
          <p className="mt-1.5 text-[12px] text-ink-secondary">
            Works with speaches (faster-whisper), whisper.cpp&apos;s server, LocalAI, or anything serving
            /v1/audio/transcriptions. Live captions appear while you speak.
          </p>
        </div>
      )}

      {provider && (
        <div className="mt-4">
          <div className="mb-1.5 text-[13px] text-ink-secondary">Language (optional)</div>
          <div className="flex gap-2">
            <input
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void write("language", { language: language.trim() })}
              placeholder="Auto-detect, or a code like en, hi, ta"
              aria-label="Speech recognition language"
              maxLength={16}
              className={inputClass}
            />
            <button
              onClick={() => void write("language", { language: language.trim() })}
              disabled={busy !== null || language.trim() === (stt.language ?? "")}
              className={saveClass}
            >
              {busy === "language" ? <Loader2 size={13} className="animate-spin" /> : <><Check size={13} />Save</>}
            </button>
          </div>
        </div>
      )}

      {error && <div className="mt-3 text-[12.5px] text-danger">{error}</div>}
    </div>
  );
}
