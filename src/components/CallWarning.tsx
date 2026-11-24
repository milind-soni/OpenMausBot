import { useRef, useState } from "react";
import { X } from "lucide-react";

import { cn } from "@/lib/cn";
import type { SpeechBridge } from "@/lib/fish-speech";
import { t } from "@/lib/i18n";

type SpeechEnd = Parameters<Parameters<SpeechBridge["onSpeechEnd"]>[0]>[0];
type DictationDisabledNote = { kind: "dictation-disabled"; message: string };
export type CallWarningNote = string | DictationDisabledNote;

export function speechEndWarning({ code, reason, message }: SpeechEnd): CallWarningNote | undefined {
  if (code === 2) return t("call.turns.needsDictation");
  if (code !== 1) return undefined;
  if (reason === "dictation-disabled") return { kind: reason, message: message ?? t("composer.dictation.disabled") };
  return message ?? t(reason === "helper-build-failed"
    ? "call.turns.helperBuildFailed"
    : reason === "speech-not-authorized"
      ? "call.turns.speechNotAuthorized"
      : "composer.dictation.failed");
}

export function CallWarning({ note, onRetry, className }: { note: CallWarningNote | null; onRetry: () => void; className: string }) {
  const [dismissed, setDismissed] = useState<DictationDisabledNote | null>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const message = typeof note === "string" ? note : note?.message;
  if (!note || !message) return null;

  return (
    <div className={cn("flex flex-col items-center gap-2 text-center text-[13px] text-warning", className)}>
      {typeof note === "string" ? <span>{message}</span> : note !== dismissed && (
        <div className="flex items-start gap-2 px-2">
          <span role="status" className="min-w-0 flex-1 break-words">{message}</span>
          <button
            type="button"
            onClick={() => {
              setDismissed(note);
              retryRef.current?.focus();
            }}
            aria-label={t("composer.notice.dismiss")}
            title={t("composer.notice.dismiss")}
            className="ui-icon-button -my-1 size-6 min-h-6 shrink-0 p-0 text-warning hover:bg-ink/[0.06] active:bg-ink/[0.08] touch:size-10"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}
      <button
        ref={retryRef}
        type="button"
        onClick={onRetry}
        className="rounded-full border border-warning/40 px-3 py-1.5 text-[12px] hover:bg-warning/10"
      >
        {t("call.turns.tryMicrophone")}
      </button>
    </div>
  );
}
