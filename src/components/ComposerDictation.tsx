import { LoaderCircle, Mic, Square } from "lucide-react";
import type { useComposerDictation } from "@/lib/use-composer-dictation";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

type Dictation = ReturnType<typeof useComposerDictation>;

export function ComposerDictationStatus({ dictation, hasText }: { dictation: Dictation; hasText: boolean }) {
  if (!dictation.pending && !(dictation.reviewReady && hasText)) return null;
  const message = dictation.starting ? t("composer.dictation.starting")
    : dictation.transcribing ? t("composer.dictation.transcribing")
      : dictation.serverRecording ? t("composer.dictation.recording") : t("composer.dictation.review");
  return (
    <div role="status" aria-live="polite" className="pointer-events-auto mb-2 flex items-center gap-2 rounded-lg bg-raised px-3 py-2 text-[12px] text-ink-secondary">
      <span className="min-w-0 flex-1">{message}</span>
      {dictation.pending && <button type="button" onClick={dictation.stop} className="shrink-0 rounded px-2 py-1 text-ink hover:bg-ink/10">{t("composer.dictation.cancel")}</button>}
    </div>
  );
}

export function ComposerDictationButton({ dictation, compact, className }: { dictation: Dictation; compact: boolean; className: string }) {
  if (!dictation.available && !dictation.pending) return null;
  const label = dictation.recording ? t("composer.dictation.stop") : t("composer.dictation.start");
  const hint = dictation.serverRecording ? t("composer.dictation.finish")
    : dictation.recording ? t("composer.dictation.stopHint") : t("composer.dictation.hint");
  return (
    <button type="button" onClick={dictation.toggle} disabled={dictation.starting || dictation.transcribing}
      aria-pressed={dictation.recording} aria-label={label} title={hint}
      className={cn("flex shrink-0 items-center justify-center rounded-full", compact ? "size-7" : "size-8",
        dictation.recording ? "animate-pulse bg-danger/20 text-danger" : className)}>
      {dictation.starting || dictation.transcribing ? <LoaderCircle size={16} className="animate-spin" />
        : dictation.serverRecording ? <Square size={16} />
          : <Mic size={16} strokeWidth={1.75} absoluteStrokeWidth className="[&_rect]:fill-current" />}
    </button>
  );
}
