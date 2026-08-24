import { Check, ExternalLink, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n-context";
import { announceTranscriptionStatus } from "@/lib/transcription-status";

export function TranscriptionSettings() {
  const { t } = useI18n();
  const bridge = window.ogb?.transcription;
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clearing = configured === true && !value.trim();

  useEffect(() => {
    let alive = true;
    bridge?.status()
      .then((status) => alive && setConfigured(status.configured))
      .catch(() => alive && setConfigured(false));
    return () => { alive = false; };
  }, [bridge]);

  const save = async () => {
    if (!bridge || saving || (!value.trim() && !configured)) return;
    setSaving(true);
    setError(null);
    try {
      const status = await bridge.setKey(value.trim());
      setConfigured(status.configured);
      setValue("");
      announceTranscriptionStatus(status.configured);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2 text-[13px] text-ink-secondary">
        <span className={cn("size-1.5 rounded-full", configured ? "bg-success" : "bg-raised-hover")} />
        <span>{t("AssemblyAI transcription")}</span>
        {configured && <span className="text-[11px] text-success">{t("Connected")}</span>}
      </div>
      <p className="mb-2 text-[12px] leading-relaxed text-ink-secondary">
        {t("Live narration for recorded skills. Audio is sent to AssemblyAI while recording; the API key is protected by your operating system.")}
      </p>
      <div className="flex gap-2">
        <input
          type="password"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && void save()}
          placeholder={configured ? t("••••••••  (paste to replace)") : t("Paste your AssemblyAI API key")}
          aria-label={t("AssemblyAI API key")}
          autoComplete="off"
          disabled={!bridge}
          className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none disabled:opacity-50"
        />
        <button
          type="button"
          onClick={() => void save()}
          disabled={!bridge || saving || (!value.trim() && !configured)}
          title={clearing ? t("Remove the saved key") : t("Save")}
          className={cn(
            "flex w-[72px] shrink-0 items-center justify-center gap-1.5 rounded-lg bg-control py-2 text-[13px] hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50",
            clearing ? "text-danger" : "text-ink",
          )}
        >
          {saving ? <Loader2 size={13} className="animate-spin" /> : clearing ? t("Clear") : <><Check size={13} />{t("Save")}</>}
        </button>
      </div>
      <a
        href="https://www.assemblyai.com/dashboard"
        target="_blank"
        rel="noopener noreferrer"
        className="mt-2 inline-flex items-center gap-1.5 text-[12px] font-medium text-accent hover:underline"
      >
        {t("Open AssemblyAI dashboard")} <ExternalLink size={12} />
      </a>
      {!bridge && <div className="mt-1 text-[12px] text-warning">{t("Available in the installed desktop app.")}</div>}
      {error && <div role="alert" className="mt-1 text-[12px] text-danger">{error}</div>}
    </div>
  );
}
