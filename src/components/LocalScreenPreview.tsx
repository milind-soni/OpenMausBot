import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Monitor, RotateCcw, Square } from "lucide-react";

import { requestScreenPreview, stopScreenPreview } from "@/lib/screen-preview";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { useDesktopCapabilities } from "./DesktopCapabilities";

type PreviewPhase =
  | "idle"
  | "requesting"
  | "streaming"
  | "cancelled"
  | "ended"
  | "unavailable"
  | "error";

// Keys, not sentences: the current message lives in state, so it has to
// survive a language switch.
const phaseCopy: Record<Exclude<PreviewPhase, "requesting" | "streaming">, LocaleKey> = {
  idle: "computer.screen.idle",
  cancelled: "computer.screen.cancelled",
  ended: "computer.screen.ended",
  unavailable: "computer.screen.unavailable",
  error: "computer.screen.error",
};

export function LocalScreenPreview() {
  const { capabilities, ready } = useDesktopCapabilities();
  const preview = capabilities.screenPreview;
  const isLinux = capabilities.host.platform === "linux";
  const [phase, setPhase] = useState<PreviewPhase>("idle");
  const [message, setMessage] = useState(phaseCopy.idle);
  const [sourceLabel, setSourceLabel] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const requestId = useRef(0);

  const releaseStream = useCallback((nextPhase: PreviewPhase, nextMessage: LocaleKey) => {
    requestId.current += 1;
    const stream = streamRef.current;
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    stopScreenPreview(stream);
    setPhase(nextPhase);
    setMessage(nextMessage);
  }, []);

  useEffect(
    () => () => {
      requestId.current += 1;
      const stream = streamRef.current;
      streamRef.current = null;
      stopScreenPreview(stream);
    },
    [],
  );

  const start = async () => {
    if (
      !preview.available ||
      !window.ogb?.beginScreenPreviewIntent ||
      !navigator.mediaDevices?.getDisplayMedia
    ) {
      setPhase("unavailable");
      setMessage(phaseCopy.unavailable);
      return;
    }

    releaseStream("requesting", "computer.screen.waiting");
    const currentRequest = requestId.current;
    const result = await requestScreenPreview({
      beginIntent: () => window.ogb!.beginScreenPreviewIntent(),
      getDisplayMedia: (constraints) => navigator.mediaDevices.getDisplayMedia(constraints),
    });

    if (currentRequest !== requestId.current) {
      if (result.ok) stopScreenPreview(result.stream);
      return;
    }
    if (!result.ok) {
      setPhase(result.phase);
      setMessage(result.messageKey);
      return;
    }

    const stream = result.stream;
    const videoTrack = stream.getVideoTracks()[0];
    streamRef.current = stream;
    setSourceLabel(videoTrack.label);
    videoTrack.addEventListener(
      "ended",
      () => {
        if (streamRef.current !== stream) return;
        releaseStream("ended", phaseCopy.ended);
      },
      { once: true },
    );
    const video = videoRef.current;
    if (!video) {
      releaseStream("error", "computer.screen.displayFailed");
      return;
    }
    video.srcObject = stream;
    try {
      await video.play();
    } catch {
      if (currentRequest === requestId.current && streamRef.current === stream) {
        releaseStream("error", "computer.screen.displayFailed");
      }
      return;
    }
    if (currentRequest !== requestId.current || streamRef.current !== stream) return;
    setPhase("streaming");
    setMessage("computer.screen.active");
  };

  if (!isLinux) return null;
  const screenLabel = sourceLabel || t("computer.screen.selected");
  const retry =
    phase === "cancelled" || phase === "ended" || phase === "unavailable" || phase === "error";

  return (
    <section className="mt-4 rounded-xl bg-card p-4" aria-labelledby="local-preview-title">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div id="local-preview-title" className="text-[15px] font-medium text-ink">
            {t("computer.screen.title")}
          </div>
          <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
            {t("computer.screen.subtitle")}
          </div>
        </div>
        <span className="shrink-0 rounded-full bg-raised px-2 py-1 text-[10px] font-medium text-ink-secondary">
          {t("computer.screen.badge")}
        </span>
      </div>

      <div className="relative mt-3 flex aspect-[16/10] items-center justify-center overflow-hidden rounded-lg bg-panel">
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          aria-label={t("computer.screen.videoAria")}
          className={phase === "streaming" ? "h-full w-full object-contain" : "hidden"}
        />
        {phase !== "streaming" && (
          <div className="flex flex-col items-center gap-2 px-6 text-center text-ink-secondary">
            {phase === "requesting" ? (
              <Loader2 size={18} className="animate-spin" />
            ) : (
              <Monitor size={22} />
            )}
            <span className="text-[12px]" aria-live="polite">
              {!ready
                ? t("computer.screen.checking")
                : t(preview.available ? message : phaseCopy.unavailable)}
            </span>
          </div>
        )}
      </div>

      {phase === "streaming" && (
        <div className="mt-2 flex items-center justify-between gap-3 text-[11px] text-ink-secondary">
          <span className="truncate" title={screenLabel}>
            {preview.interaction === "portal-picker" ? screenLabel : t("vm.dest.local")}
          </span>
          <span className="flex items-center gap-1.5 text-success">
            <span className="h-1.5 w-1.5 rounded-full bg-success" /> {t("computer.screen.sharing")}
          </span>
        </div>
      )}

      <button
        type="button"
        disabled={phase === "requesting" || (!preview.available && phase !== "streaming")}
        onClick={
          phase === "streaming"
            ? () => releaseStream("idle", phaseCopy.idle)
            : () => void start()
        }
        className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-raised py-2 text-[13px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50"
      >
        {phase === "requesting" ? (
          <Loader2 size={14} className="animate-spin" />
        ) : phase === "streaming" ? (
          <Square size={13} />
        ) : retry ? (
          <RotateCcw size={14} />
        ) : (
          <Monitor size={14} />
        )}
        {phase === "requesting"
          ? t("computer.screen.choosing")
          : phase === "streaming"
            ? t("computer.screen.stop")
            : retry
              ? t("computer.linux.tryAgain")
              : preview.interaction === "portal-picker"
                ? t("computer.screen.choose")
                : t("computer.screen.start")}
      </button>
    </section>
  );
}
