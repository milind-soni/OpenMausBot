import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Monitor, RotateCcw, Square } from "lucide-react";

import { requestScreenPreview, stopScreenPreview } from "@/lib/screen-preview";
import { useDesktopCapabilities } from "./DesktopCapabilities";

type PreviewPhase =
  | "idle"
  | "requesting"
  | "streaming"
  | "cancelled"
  | "ended"
  | "unavailable"
  | "error";

const phaseCopy: Record<Exclude<PreviewPhase, "requesting" | "streaming">, string> = {
  idle: "Start a private, view-only preview when you need it.",
  cancelled: "Screen selection was cancelled. Nothing is being shared.",
  ended: "Screen sharing ended. Nothing is being shared.",
  unavailable: "Screen preview isn't available in this desktop session.",
  error: "Couldn't start screen preview.",
};

export function LocalScreenPreview() {
  const { capabilities, ready } = useDesktopCapabilities();
  const preview = capabilities.screenPreview;
  const isLinux = capabilities.host.platform === "linux";
  const [phase, setPhase] = useState<PreviewPhase>("idle");
  const [message, setMessage] = useState(phaseCopy.idle);
  const [sourceLabel, setSourceLabel] = useState("Selected screen");
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const requestId = useRef(0);

  const releaseStream = useCallback((nextPhase: PreviewPhase, nextMessage: string) => {
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

    releaseStream("requesting", "Waiting for screen selection…");
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
      setMessage(result.message);
      return;
    }

    const stream = result.stream;
    const videoTrack = stream.getVideoTracks()[0];
    streamRef.current = stream;
    setSourceLabel(videoTrack.label || "Selected screen");
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
      releaseStream("error", "Couldn't display screen preview.");
      return;
    }
    video.srcObject = stream;
    try {
      await video.play();
    } catch {
      if (currentRequest === requestId.current && streamRef.current === stream) {
        releaseStream("error", "Couldn't display screen preview.");
      }
      return;
    }
    if (currentRequest !== requestId.current || streamRef.current !== stream) return;
    setPhase("streaming");
    setMessage(
      "Preview active. Previewing does not grant local control; local actions still require approval.",
    );
  };

  if (!isLinux) return null;
  const retry =
    phase === "cancelled" || phase === "ended" || phase === "unavailable" || phase === "error";

  return (
    <section className="mt-4 rounded-xl bg-card p-4" aria-labelledby="local-preview-title">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div id="local-preview-title" className="text-[15px] font-medium text-ink">
            Preview this computer
          </div>
          <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
            Preview only — starting a preview does not grant local control.
          </div>
        </div>
        <span className="shrink-0 rounded-full bg-raised px-2 py-1 text-[10px] font-medium text-ink-secondary">
          Preview only
        </span>
      </div>

      <div className="relative mt-3 flex aspect-[16/10] items-center justify-center overflow-hidden rounded-lg bg-panel">
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          aria-label="Live preview of the selected screen"
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
                ? "Checking screen preview…"
                : preview.available
                  ? message
                  : phaseCopy.unavailable}
            </span>
          </div>
        )}
      </div>

      {phase === "streaming" && (
        <div className="mt-2 flex items-center justify-between gap-3 text-[11px] text-ink-secondary">
          <span className="truncate" title={sourceLabel}>
            {preview.interaction === "portal-picker" ? sourceLabel : "This computer"}
          </span>
          <span className="flex items-center gap-1.5 text-success">
            <span className="h-1.5 w-1.5 rounded-full bg-success" /> Sharing
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
          ? "Choose a screen…"
          : phase === "streaming"
            ? "Stop preview"
            : retry
              ? "Try again"
              : preview.interaction === "portal-picker"
                ? "Choose a screen"
                : "Start preview"}
      </button>
    </section>
  );
}
