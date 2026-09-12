import { useEffect, useRef, useState } from "react";

export interface DictationTranscript {
  finalText: string;
  partialText: string;
}

export const EMPTY_TRANSCRIPT: DictationTranscript = { finalText: "", partialText: "" };

type ModifierEvent = Pick<KeyboardEvent, "code" | "ctrlKey" | "altKey" | "metaKey" | "shiftKey" | "repeat">;

/** Ctrl+Space, and only that: no other modifiers, not an auto-repeat. The
 * composer insert flow uses the clipboard, so this never races typing. */
export function isDictationPress(event: ModifierEvent): boolean {
  return (
    event.code === "Space" &&
    event.ctrlKey &&
    !event.altKey &&
    !event.metaKey &&
    !event.shiftKey &&
    !event.repeat
  );
}

/** While a hold is active, releasing Space or either Control finalizes —
 * the user may let go of the combo in either order. */
export function isDictationRelease(event: ModifierEvent): boolean {
  return event.code === "Space" || event.code === "ControlLeft" || event.code === "ControlRight";
}

/** Float32 [-1, 1] samples → PCM16 little-endian bytes. Exported pure for
 * tests; the capture pump below feeds its output straight over the bridge. */
export function floatToPcm16(input: Float32Array): ArrayBuffer {
  const output = new ArrayBuffer(input.length * 2);
  const view = new DataView(output);
  for (let i = 0; i < input.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, input[i] ?? 0));
    // ASK / two's complement rounding matches every other dictation client.
    view.setInt16(i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return output;
}

const PCM_SAMPLE_RATE = 16000;
const PCM_CHUNK_FRAMES = 4096;

/** Hold Ctrl+Space to dictate; release to put the transcript on the system
 * clipboard. The renderer captures the microphone and streams PCM16/16 kHz
 * mono frames; the main process owns the Deepgram WebSocket and the key, so
 * the renderer never sees a credential. Partials stream back for the live
 * pill; release sends Finalize and resolves the paste text. Escape discards
 * the hold. Works on Windows, where native dictation is unavailable. */
export function useClipboardDictation(onResult: (text: string) => void, onError: (message: string) => void): boolean {
  const [active, setActive] = useState(false);
  const held = useRef(false);
  const finishingRef = useRef(false);
  const sessionIdRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const partialRef = useRef("");
  const onResultRef = useRef(onResult);
  const onErrorRef = useRef(onError);
  onResultRef.current = onResult;
  onErrorRef.current = onError;

  const cleanupAudio = () => {
    try {
      processorRef.current?.disconnect();
    } catch {}
    processorRef.current = null;
    void contextRef.current?.close().catch(() => {});
    contextRef.current = null;
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
  };

  const finalize = () => {
    if (finishingRef.current) return;
    finishingRef.current = true;
    const id = sessionIdRef.current;
    sessionIdRef.current = null;
    cleanupAudio();
    const drained: Promise<string> = id !== null && window.ogb?.dictation
      ? window.ogb.dictation.finish(id).catch(() => "")
      : Promise.resolve("");
    void drained.then((text) => {
      finishingRef.current = false;
      held.current = false;
      setActive(false);
      partialRef.current = "";
      const finalText = text.trim();
      if (finalText) onResultRef.current(finalText);
      else onErrorRef.current("Nothing was picked up — hold Ctrl+Space and speak.");
    });
  };

  const cancel = () => {
    const id = sessionIdRef.current;
    sessionIdRef.current = null;
    if (id !== null) void window.ogb?.dictation?.cancel(id).catch(() => {});
    cleanupAudio();
    held.current = false;
    setActive(false);
    partialRef.current = "";
  };

  useEffect(() => {
    const bridge = window.ogb;
    if (!bridge) return;

    const begin = async () => {
      if (!bridge.dictation || !bridge.writeClipboardText) {
        onErrorRef.current("Cloud transcription isn't available in this build.");
        return;
      }
      try {
        partialRef.current = EMPTY_TRANSCRIPT.partialText;
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        streamRef.current = stream;
        const id = await bridge.dictation.start();
        sessionIdRef.current = id;

        // 16 kHz capture keeps the bridge frames exactly what Deepgram's
        // linear16/16000 contract expects — no resampling on either side.
        const context = new AudioContext({ sampleRate: PCM_SAMPLE_RATE });
        contextRef.current = context;
        const source = context.createMediaStreamSource(stream);
        const processor = context.createScriptProcessor(PCM_CHUNK_FRAMES, 1, 1);
        processorRef.current = processor;
        processor.onaudioprocess = (event) => {
          if (sessionIdRef.current !== id) return;
          const pcm = floatToPcm16(event.inputBuffer.getChannelData(0));
          void bridge.dictation!.audio(id, pcm).catch(() => {});
        };
        source.connect(processor);
        // The graph must run to pull the mic, but raw capture must never
        // reach the speakers: the processor's muted output feeds the
        // destination (onaudioprocess reads the input side directly).
        const mute = context.createGain();
        mute.gain.value = 0;
        processor.connect(mute);
        mute.connect(context.destination);

        held.current = true;
        setActive(true);
      } catch (error) {
        cleanupAudio();
        sessionIdRef.current = null;
        held.current = false;
        setActive(false);
        const message = error instanceof Error ? error.message : String(error);
        onErrorRef.current(
          /permission|denied/i.test(message)
            ? "Microphone access was denied — allow it, then hold Ctrl+Space again."
            : /No Deepgram key/i.test(message)
              ? message
              : "Could not reach the transcription stream. Check your Deepgram key and connection.",
        );
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (held.current || !isDictationPress(event)) return;
      event.preventDefault();
      void begin();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (held.current && isDictationRelease(event)) {
        event.preventDefault();
        finalize();
      }
    };
    // A focus steal mid-hold must not wedge the mic open: keyup never arrives
    // in this window after a blur, so finalize from whatever was captured.
    const onBlur = () => {
      if (held.current) finalize();
    };
    const onEscape = (event: KeyboardEvent) => {
      if (held.current && event.key === "Escape") {
        event.preventDefault();
        cancel();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    window.addEventListener("keydown", onEscape);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("keydown", onEscape);
      cancel();
    };
    // The handlers are stable; callbacks arrive through refs so re-renders
    // never re-bind the listeners mid-hold.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return active;
}
