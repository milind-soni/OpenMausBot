import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/state/api";
import { DICTATION_MAX_BYTES, DICTATION_MAX_SECONDS, type ServerDictationResult, type ServerDictationStatus } from "../../shared/dictation";
import { activeLocale, t } from "./i18n";
import { imeComposing } from "./send-key";

const STOP_MARGIN_SECONDS = 2;
const AUDIO_TYPES = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"];
type Phase = "idle" | "starting" | "recording" | "transcribing";
interface Capture {
  draftId: string;
  controller: AbortController;
  recorder: MediaRecorder | null;
  stream: MediaStream | null;
  timer?: ReturnType<typeof setTimeout>;
  parts: Blob[];
  size: number;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && ["NotAllowedError", "PermissionDeniedError"].includes(error.name)) return t("composer.dictation.microphonePermission");
  if (error instanceof Error && ["NotFoundError", "DevicesNotFoundError", "NotReadableError"].includes(error.name)) return t("composer.dictation.microphoneMissing");
  const detail = error instanceof ApiError ? error.body?.error : null;
  const code = detail && typeof detail === "object" && "code" in detail ? detail.code : "";
  if (code === "too_large") return t("composer.dictation.tooLarge");
  if (code === "too_long") return t("composer.dictation.tooLong");
  if (code === "no_speech") return t("composer.dictation.noSpeech");
  if (code === "busy") return t("composer.dictation.serverBusy");
  if (code === "invalid_audio") return t("composer.dictation.invalidAudio");
  return t("composer.dictation.serverFailed");
}

export function useServerDictation({ draftId, text, onText, enabled }: {
  draftId: string;
  text: string;
  onText: (text: string) => void;
  enabled: boolean;
}) {
  const mimeType = typeof MediaRecorder !== "undefined" && typeof MediaRecorder.isTypeSupported === "function"
    ? AUDIO_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) : undefined;
  const supported = Boolean(globalThis.isSecureContext && typeof globalThis.navigator?.mediaDevices?.getUserMedia === "function" && mimeType);
  const [available, setAvailable] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [reviewReady, setReviewReady] = useState(false);
  const draft = useRef({ id: draftId, text, onText });
  draft.current = { id: draftId, text, onText };
  const current = useRef<Capture | null>(null);

  useEffect(() => { if (!text) setReviewReady(false); }, [text]);

  useEffect(() => {
    if (!enabled || !supported) return;
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const status = await api<ServerDictationStatus>("/api/dictation/status", { background: true, timeoutMs: 3_000, signal: controller.signal });
        if (!controller.signal.aborted) setAvailable(status.available === true);
      } catch { if (!controller.signal.aborted) setAvailable(false); }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 30_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [enabled, supported]);

  const cancel = useCallback(() => {
    const capture = current.current;
    current.current = null;
    if (capture) {
      capture.controller.abort();
      clearTimeout(capture.timer);
      if (capture.recorder) {
        capture.recorder.ondataavailable = null;
        capture.recorder.onstop = null;
        capture.recorder.onerror = null;
        if (capture.recorder.state !== "inactive") capture.recorder.stop();
      }
      capture.stream?.getTracks().forEach((track) => track.stop());
      capture.parts = [];
    }
    setPhase("idle");
    setReviewReady(false);
    setError(null);
  }, []);

  useEffect(() => () => cancel(), [draftId, enabled, cancel]);

  useEffect(() => {
    if (phase === "idle") return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || imeComposing(event)) return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    };
    document.addEventListener("keydown", escape, true);
    return () => document.removeEventListener("keydown", escape, true);
  }, [phase, cancel]);

  const finish = useCallback((capture: Capture) => {
    if (current.current !== capture || !capture.recorder || capture.recorder.state === "inactive") return;
    clearTimeout(capture.timer);
    setPhase("transcribing");
    capture.recorder.stop();
  }, []);

  const toggle = async () => {
    if (current.current) { finish(current.current); return; }
    if (!enabled || !available || !supported || !mimeType) { setError(t("composer.dictation.unavailable")); return; }
    const capture: Capture = { draftId, controller: new AbortController(), recorder: null, stream: null, parts: [], size: 0 };
    current.current = capture;
    setError(null);
    setReviewReady(false);
    setPhase("starting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      if (current.current !== capture || draft.current.id !== capture.draftId) { stream.getTracks().forEach((track) => track.stop()); return; }
      capture.stream = stream;
      const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 64_000 });
      capture.recorder = recorder;
      recorder.ondataavailable = (event) => {
        if (current.current !== capture || !event.data.size) return;
        capture.size += event.data.size;
        if (capture.size > DICTATION_MAX_BYTES) { cancel(); setError(t("composer.dictation.tooLarge")); return; }
        capture.parts.push(event.data);
      };
      recorder.onerror = () => { if (current.current === capture) { cancel(); setError(t("composer.dictation.failed")); } };
      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        capture.stream = null;
        if (current.current !== capture) return;
        clearTimeout(capture.timer);
        setPhase("transcribing");
        try {
          if (!capture.size) throw new ApiError("no_speech", 422, { error: { code: "no_speech" } });
          const audio = new Blob(capture.parts, { type: recorder.mimeType || mimeType });
          capture.parts = [];
          const result = await api<ServerDictationResult>("/api/dictation/transcribe", {
            method: "POST", body: audio, signal: capture.controller.signal, timeoutMs: 150_000,
            headers: { "content-type": audio.type, "x-dictation-language": activeLocale().split("-")[0]! },
          });
          if (current.current !== capture || draft.current.id !== capture.draftId) return;
          if (typeof result.text !== "string" || !result.text.trim()) throw new ApiError("no_speech", 422, { error: { code: "no_speech" } });
          const base = draft.current.text;
          const next = `${base}${base && !/\s$/.test(base) ? " " : ""}${result.text.trim()}`;
          draft.current.text = next;
          draft.current.onText(next);
          setReviewReady(true);
        } catch (failure) {
          if (current.current === capture && !capture.controller.signal.aborted) setError(errorMessage(failure));
        } finally {
          if (current.current === capture) { current.current = null; setPhase("idle"); }
        }
      };
      recorder.start(1_000);
      setPhase("recording");
      capture.timer = setTimeout(() => finish(capture), (DICTATION_MAX_SECONDS - STOP_MARGIN_SECONDS) * 1_000);
    } catch (failure) {
      if (current.current === capture) { cancel(); setError(errorMessage(failure)); }
    }
  };

  return { available: enabled && supported && available, recording: phase === "recording", starting: phase === "starting", transcribing: phase === "transcribing", pending: phase !== "idle", reviewReady, error, toggle, cancel };
}
