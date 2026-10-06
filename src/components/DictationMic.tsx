import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { Mic } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import {
  DICTATION_LANGUAGES,
  DICTATION_LANGUAGE_STORAGE_KEY,
  WHISPER_MODEL,
  dictationClickAction,
  dictationLanguage,
  encodeWavPcm16,
  resampleLinear,
} from "../../shared/dictation-languages";

type Phase = "idle" | "confirm" | "downloading" | "recording" | "transcribing";

const MAX_SECONDS = 180;

function storedLanguage(): string {
  try {
    return localStorage.getItem(DICTATION_LANGUAGE_STORAGE_KEY) ?? "auto";
  } catch {
    return "auto";
  }
}

/**
 * Composer microphone.
 *
 * Apple speech starts immediately. Whisper starts only when the model is
 * already on this computer. A click before that opens the download alert
 * and does not record; confirming the download connects the engine and
 * then starts the session.
 */
export function DictationMic({
  text,
  editText,
  apple,
  whisper,
  onError,
  onPhase,
  stopRef,
}: {
  text: string;
  editText: (next: string) => void;
  apple: boolean;
  whisper: boolean;
  onError: (message: string | null) => void;
  onPhase: (phase: "idle" | "recording" | "transcribing") => void;
  stopRef: MutableRefObject<(() => boolean) | null>;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [menu, setMenu] = useState(false);
  const [languageId, setLanguageId] = useState(storedLanguage);
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [progress, setProgress] = useState<{ received: number; total: number; phase: "model" | "engine" } | null>(null);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const sessionRef = useRef(0);
  const setCapturePhase = (next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  };
  const language = dictationLanguage(languageId);
  const languageRef = useRef(language);
  languageRef.current = language;
  const baseRef = useRef("");
  const captureRef = useRef<{
    context: AudioContext;
    stream: MediaStream;
    source: MediaStreamAudioSourceNode;
    processor: ScriptProcessorNode;
    mute: GainNode;
    chunks: Float32Array[];
    samples: number;
    stopped: boolean;
  } | null>(null);

  useEffect(() => {
    onPhase(phase === "recording" || phase === "transcribing" ? phase : "idle");
  }, [phase, onPhase]);

  useEffect(() => {
    if (!whisper) return;
    let cancelled = false;
    void window.ogb?.whisperStatus?.().then((status) => {
      if (!cancelled) setInstalled(status.installed);
    }).catch(() => {
      if (!cancelled) setInstalled(false);
    });
    return () => {
      cancelled = true;
    };
  }, [whisper]);

  useEffect(() => () => {
    const capture = captureRef.current;
    captureRef.current = null;
    if (!capture) return;
    capture.stopped = true;
    capture.stream.getTracks().forEach((track) => track.stop());
    void capture.context.close().catch(() => {});
  }, []);

  const chooseLanguage = (id: string) => {
    const next = dictationLanguage(id);
    setLanguageId(next.id);
    try {
      localStorage.setItem(DICTATION_LANGUAGE_STORAGE_KEY, next.id);
    } catch {
      // The choice still applies to this session.
    }
    setMenu(false);
  };

  const releaseCapture = () => {
    const capture = captureRef.current;
    if (!capture || capture.stopped) return null;
    capture.stopped = true;
    captureRef.current = null;
    capture.source.disconnect();
    capture.processor.disconnect();
    capture.mute.disconnect();
    capture.stream.getTracks().forEach((track) => track.stop());
    const rate = capture.context.sampleRate;
    void capture.context.close().catch(() => {});
    return { chunks: capture.chunks, rate };
  };

  const finishWhisper = async () => {
    const captured = releaseCapture();
    if (!captured) return;
    const length = captured.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    if (length === 0) {
      onError(t("composer.dictation.empty"));
      setCapturePhase("idle");
      return;
    }
    setCapturePhase("transcribing");
    const merged = new Float32Array(length);
    let offset = 0;
    for (const chunk of captured.chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    const wav = encodeWavPcm16(resampleLinear(merged, captured.rate, 16000), 16000);
    try {
      const result = await window.ogb?.whisperTranscribe?.({ wav, language: languageRef.current.whisper });
      const spoken = result?.text?.trim() ?? "";
      if (!spoken) onError(t("composer.dictation.empty"));
      else {
        const base = baseRef.current;
        editText(base ? `${base} ${spoken}` : spoken);
        onError(null);
      }
    } catch {
      onError(t("composer.dictation.failed"));
    } finally {
      setCapturePhase("idle");
    }
  };

  const cancelDownload = () => {
    sessionRef.current += 1;
    void window.ogb?.whisperCancel?.();
    setCapturePhase("idle");
    setProgress(null);
  };

  const startApple = (base: string) => {
    baseRef.current = base;
    onError(null);
    setCapturePhase("recording");
  };

  const startWhisper = async (base: string, ticket: number) => {
    if (!window.ogb?.whisperTranscribe) {
      onError(t("composer.dictation.unavailable"));
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
    } catch {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        onError(t("composer.dictation.micPermission"));
        return;
      }
    }
    if (sessionRef.current !== ticket) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    const context = new AudioContext();
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(4096, 1, 1);
    const mute = context.createGain();
    mute.gain.value = 0;
    const capture = {
      context,
      stream,
      source,
      processor,
      mute,
      chunks: [] as Float32Array[],
      samples: 0,
      stopped: false,
    };
    processor.onaudioprocess = (event) => {
      if (capture.stopped) return;
      const data = event.inputBuffer.getChannelData(0);
      capture.chunks.push(new Float32Array(data));
      capture.samples += data.length;
      if (capture.samples >= context.sampleRate * MAX_SECONDS) void finishWhisper();
    };
    source.connect(processor);
    processor.connect(mute);
    mute.connect(context.destination);
    captureRef.current = capture;
    baseRef.current = base;
    onError(null);
    setCapturePhase("recording");
  };

  const beginDownload = async () => {
    const bridge = window.ogb;
    if (!bridge?.whisperDownload) {
      onError(t("composer.dictation.downloadFailed"));
      setCapturePhase("idle");
      return;
    }
    const ticket = sessionRef.current;
    setCapturePhase("downloading");
    setProgress(null);
    const off = bridge.onWhisperProgress?.((next) => setProgress(next)) ?? (() => {});
    try {
      const status = await bridge.whisperDownload();
      off();
      if (sessionRef.current !== ticket) return;
      setInstalled(Boolean(status?.installed));
      if (!status?.installed) {
        onError(t("composer.dictation.downloadFailed"));
        setCapturePhase("idle");
        return;
      }
      await startWhisper(baseRef.current, ticket);
      if (phaseRef.current === "downloading") setCapturePhase("idle");
    } catch (error) {
      off();
      if (sessionRef.current !== ticket) return;
      setCapturePhase("idle");
      const aborted = error instanceof Error && error.name === "AbortError";
      if (!aborted) onError(t("composer.dictation.downloadFailed"));
    }
  };

  stopRef.current = () => {
    const current = phaseRef.current;
    if (current === "confirm") {
      setCapturePhase("idle");
      return true;
    }
    if (current === "downloading") {
      cancelDownload();
      return true;
    }
    if (current === "recording" && apple) {
      setCapturePhase("idle");
      return true;
    }
    if (current === "recording") {
      void finishWhisper();
      return true;
    }
    return false;
  };

  useEffect(() => {
    if (phase !== "recording" || !apple) return;
    const bridge = window.ogb;
    if (!bridge) {
      setCapturePhase("idle");
      return;
    }
    const offTranscript = bridge.onSpeechTranscript((line) => {
      if (typeof line.text !== "string") return;
      const base = baseRef.current;
      editText(base ? `${base} ${line.text}` : line.text);
    });
    const offEnd = bridge.onSpeechEnd(({ code, reason }) => {
      setCapturePhase("idle");
      if (code === 2) onError(t("composer.dictation.macOnly"));
      else if (code === 1) {
        onError(t(
          reason === "dictation-disabled"
            ? "composer.dictation.disabled"
            : reason === "speech-not-authorized"
              ? "composer.dictation.permission"
              : "composer.dictation.failed",
        ));
      }
    });
    const tag = languageRef.current.tag;
    void bridge.speechStart(tag ? { locale: tag } : undefined);
    return () => {
      offTranscript();
      offEnd();
      void bridge.speechStop();
    };
  }, [phase, apple, editText, onError]);

  const onMic = async () => {
    if (phase === "recording") {
      stopRef.current?.();
      return;
    }
    if (phase !== "idle") return;
    if (!window.ogb) {
      onError(t("composer.dictation.unavailable"));
      return;
    }
    const base = text.trim();
    baseRef.current = base;
    if (apple) {
      if (dictationClickAction({ listening: false, engineReady: true }) === "start") startApple(base);
      return;
    }
    let ready = installed;
    if (ready === null) {
      try {
        ready = Boolean((await window.ogb.whisperStatus?.())?.installed);
      } catch {
        ready = false;
      }
      setInstalled(ready);
    }
    const action = dictationClickAction({ listening: false, engineReady: ready });
    if (action === "alert") {
      onError(null);
      setCapturePhase("confirm");
      return;
    }
    await startWhisper(base, sessionRef.current);
  };

  const aboutSize = `${(WHISPER_MODEL.aboutBytes / 1_000_000_000).toFixed(1)} GB`;
  const percent = progress && progress.total > 0
    ? Math.min(100, Math.round((progress.received / progress.total) * 100))
    : null;
  const showMenu = menu && phase !== "confirm" && phase !== "downloading";
  const listening = phase === "recording";

  return (
    <div
      className="relative shrink-0"
      onMouseEnter={() => setMenu(true)}
      onMouseLeave={() => setMenu(false)}
      onFocus={() => setMenu(true)}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (!(next instanceof Node) || !event.currentTarget.contains(next)) setMenu(false);
      }}
    >
      {showMenu && (
        <div className="absolute bottom-full left-1/2 z-20 -translate-x-1/2 pb-1">
          <div
            role="menu"
            aria-label={t("composer.dictation.language")}
            className="max-h-52 w-36 overflow-y-auto rounded-lg border border-line bg-panel py-1 shadow-lg"
          >
            {DICTATION_LANGUAGES.map((item) => (
              <button
                key={item.id}
                type="button"
                role="menuitemradio"
                aria-checked={item.id === language.id}
                className={cn(
                  "block w-full px-2 py-1 text-left text-[12px]",
                  item.id === language.id ? "bg-accent/15 text-ink" : "text-ink-secondary hover:bg-raised hover:text-ink",
                )}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => chooseLanguage(item.id)}
              >
                {item.id === "auto" ? t("composer.dictation.language.auto") : item.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {(phase === "confirm" || phase === "downloading") && (
        <div
          role="dialog"
          aria-labelledby="dictation-download-title"
          className="absolute bottom-full right-0 z-30 mb-2 w-72 rounded-xl border border-line bg-panel p-3 text-[12.5px] leading-5 text-ink shadow-lg"
        >
          <p id="dictation-download-title">
            {phase === "downloading"
              ? progress?.phase === "engine"
                ? t("composer.dictation.downloadingEngine")
                : t("composer.dictation.downloading", { model: WHISPER_MODEL.label })
              : t("composer.dictation.needEngine", { model: WHISPER_MODEL.label, size: aboutSize })}
          </p>
          {phase === "downloading" && (
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-raised">
              <div
                className={percent === null ? "h-full animate-pulse bg-accent/70" : "h-full bg-accent"}
                style={{ width: percent === null ? "100%" : `${percent}%` }}
              />
            </div>
          )}
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              onClick={cancelDownload}
              className="rounded-full px-3 py-1 text-ink-secondary hover:bg-raised"
            >
              {t("composer.dictation.notNow")}
            </button>
            {phase === "confirm" && (
              <button
                type="button"
                onClick={() => void beginDownload()}
                className="rounded-full bg-accent px-3 py-1 text-white"
              >
                {t("composer.dictation.download")}
              </button>
            )}
          </div>
        </div>
      )}
      <button
        type="button"
        onClick={() => void onMic()}
        disabled={phase === "transcribing"}
        aria-busy={phase === "transcribing" || undefined}
        aria-label={
          listening
            ? t("composer.dictation.stop")
            : phase === "transcribing"
              ? t("composer.dictation.transcribing")
              : t("composer.dictation.start")
        }
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-full",
          listening || phase === "transcribing"
            ? "animate-pulse bg-danger/20 text-danger"
            : "text-ink-secondary hover:bg-raised hover:text-ink",
        )}
        title={
          listening
            ? t("composer.dictation.stopHint")
            : phase === "transcribing"
              ? t("composer.dictation.transcribing")
              : t("composer.dictation.hint")
        }
      >
        <Mic size={18} />
      </button>
    </div>
  );
}
