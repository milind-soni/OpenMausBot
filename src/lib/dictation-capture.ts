// Dictation capture, offline end to end.
//
// One transport for every dictation flow (Ctrl+Space hold, the composer's mic
// button, the wake word): capture 16 kHz mono PCM in the renderer, encode it
// as a WAV in memory, and hand it to the user's own Handy install via
// `Handy --transcribe-file --json`. No key, no socket, no cloud, and no
// clipboard round-trip — the transcript comes straight back as a string.
//
// The audio primitives are shared with the call ear (offline-call-stt.ts), so
// there is one definition of "silent", one endpointer, one WAV encoder.
//
// Trade-off, stated plainly: Handy decodes a finished file, so there is no
// interim text while the user speaks. The endpointer still gives a natural
// stop, and the pill shows listening → transcribing instead of live words.
import { handyPath } from "./handy";
import { PCM_SAMPLE_RATE, encodeWav, isSilentFrame, stepSilence } from "./offline-call-stt";

/** Capture frames are 4096 samples (~256 ms at 16 kHz). */
const CAPTURE_FRAMES = 4096;
/** Hard memory ceiling — ~5 minutes. Beyond it the recording stops and the
 * audio captured so far is still transcribed rather than thrown away. */
export const MAX_CAPTURE_SAMPLES = 5 * 60 * PCM_SAMPLE_RATE;

/** Shown when the offline engine is missing from this build or this machine. */
export const DICTATION_UNAVAILABLE =
  "Offline dictation needs the Handy app. Set its path in Settings → Wake word, then try again.";

export interface DictationLevel {
  /** Root-mean-square of the frame, for the watchdog. */
  rms: number;
  silent: boolean;
  /** True once any frame crossed the speech threshold. */
  hasSpeech: boolean;
}

export interface DictationCaptureOptions {
  /** Auto-stop after this many consecutive silent frames, once speech was
   * heard. Omitted by hold-to-dictate: releasing the keys IS the endpoint. */
  endpointerFrames?: number;
  onLevel?: (level: DictationLevel) => void;
  /** The endpointer — not the user — ended the recording. */
  onAutoStop?: () => void;
  onError: (message: string) => void;
}

export interface DictationCapture {
  /** Open the mic and begin buffering. */
  start(): Promise<void>;
  /** Stop capturing and transcribe what was heard ("" when nothing was). */
  transcribe(): Promise<string>;
  /** Stop capturing and throw the audio away. */
  discard(): void;
  /** While muted the app's own voice is playing: frames are dropped rather
   * than buffered, so a recording can never transcribe the bot talking. */
  setMuted(muted: boolean): void;
}

/** False in browser/dev shells that lack the offline transcription bridge. */
export function dictationCaptureAvailable(): boolean {
  return typeof window !== "undefined" && Boolean(window.ogb?.handyTranscribeFile);
}

function rmsOf(samples: ArrayLike<number>): number {
  const n = samples.length;
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i += 1) sum += (samples[i] ?? 0) * (samples[i] ?? 0);
  return Math.sqrt(sum / n);
}

export function createDictationCapture(options: DictationCaptureOptions): DictationCapture | null {
  const bridge = window.ogb;
  if (!bridge?.handyTranscribeFile) return null;

  let stream: MediaStream | null = null;
  let context: AudioContext | null = null;
  let processor: ScriptProcessorNode | null = null;
  let chunks: Float32Array[] = [];
  let samples = 0;
  let framesSilent = 0;
  let hasSpeech = false;
  let source: MediaStreamAudioSourceNode | null = null;
  let gain: GainNode | null = null;
  let stopped = false;
  let discarded = false;
  let startPromise: Promise<void> | undefined;
  let transcription: Promise<string> | undefined;
  let muted = false;

  const closeCapture = () => {
    if (processor) processor.onaudioprocess = null;
    for (const node of [source, processor, gain]) {
      try { node?.disconnect(); } catch {}
    }
    source = null;
    processor = null;
    gain = null;
    try { void context?.close().catch(() => {}); } catch {}
    context = null;
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = null;
  };

  const merged = (): Float32Array => {
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Float32Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  };

  return {
    start() {
      if (stopped) return Promise.resolve();
      if (startPromise) return startPromise;
      startPromise = (async () => {
        try {
          const opened = await navigator.mediaDevices.getUserMedia({ audio: true });
          if (stopped) {
            for (const track of opened.getTracks()) track.stop();
            return;
          }
          stream = opened;
          context = new AudioContext({ sampleRate: PCM_SAMPLE_RATE });
          source = context.createMediaStreamSource(stream);
          processor = context.createScriptProcessor(CAPTURE_FRAMES, 1, 1);
          processor.onaudioprocess = (event) => {
            if (stopped || muted) return;
            const frame = event.inputBuffer.getChannelData(0).subarray(0, MAX_CAPTURE_SAMPLES - samples);
            const silent = isSilentFrame(frame);
            framesSilent = stepSilence(framesSilent, silent);
            if (!silent) hasSpeech = true;
            chunks.push(new Float32Array(frame));
            samples += frame.length;
            options.onLevel?.({ rms: rmsOf(frame), silent, hasSpeech });
            if (stopped) return;
            if (samples >= MAX_CAPTURE_SAMPLES || (
              options.endpointerFrames !== undefined && hasSpeech && framesSilent >= options.endpointerFrames
            )) {
              // Enforce the bound ourselves, even without an owner callback.
              stopped = true;
              closeCapture();
              options.onAutoStop?.();
            }
          };
          source.connect(processor);
          gain = context.createGain();
          gain.gain.value = 0;
          processor.connect(gain);
          gain.connect(context.destination);
        } catch (error) {
          closeCapture();
          if (stopped) return;
          stopped = true;
          chunks = [];
          throw error;
        }
      })();
      return startPromise;
    },

    transcribe(): Promise<string> {
      if (discarded) return Promise.resolve("");
      if (transcription) return transcription;
      stopped = true;
      closeCapture();
      transcription = (async () => {
        try {
          if (!hasSpeech) return "";
          const wav = encodeWav(merged());
          chunks = [];
          const result = await bridge.handyTranscribeFile!(wav, handyPath());
          if (discarded) return "";
          if (!result.ok) {
            options.onError(result.error ?? "Handy could not transcribe the recording.");
            return "";
          }
          return (result.text ?? "").trim();
        } catch {
          if (!discarded) options.onError("Handy transcription failed.");
          return "";
        } finally {
          chunks = [];
          samples = 0;
        }
      })();
      return transcription;
    },

    discard() {
      stopped = true;
      discarded = true;
      chunks = [];
      samples = 0;
      closeCapture();
    },

    setMuted(next: boolean) {
      muted = next;
    },
  };
}
