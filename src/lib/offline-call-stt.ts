// Offline call listening: when there is no Deepgram key, the call mic is
// driven through the user's own Handy install (https://handy.computer) —
// the same offline model their Ctrl+Space dictation already uses.
//
// Shape of a turn, mirroring the Apple Speech helper's contract:
//   renderer captures 16 kHz mono PCM → silence endpointer (the same
//   thresholds as the wake-word watchdog) finalizes an utterance → the
//   utterance is encoded as a WAV in memory → main hands it to
//   `Handy --transcribe-file --json` → the transcript flows through the
//   exact same handleUtterance path the cloud engines feed.
//
// Nothing here records to disk, uploads, or needs a key. Audio lives in
// memory until the WAV encode, and Handy never leaves this machine.
import { handyPath } from "./handy";

export const PCM_SAMPLE_RATE = 16000;
/** Louder than this counts as speech (matches SILENCE_RMS_THRESHOLD). */
export const SPEECH_RMS_THRESHOLD = 0.01;

/** Consecutive silent frames that end a turn — the wake-word watchdog uses
 * 2 (~½ s) for stop-toggling; here it also has to survive between-word gaps,
 * so it is slightly longer (~0.75 s). */
export const ENDPOINT_SILENCE_FRAMES = 3;
/** A turn longer than this is cut off — Handy decodes 60 s of audio in a
 * few seconds on CPU, but the caller still deserves a bound. */
export const MAX_UTTERANCE_MS = 60_000;
/** The cap in captured samples: frames are 4096 samples, not milliseconds —
 * never multiply sample counts by FRAME_MS. */
export const MAX_UTTERANCE_SAMPLES = Math.round((MAX_UTTERANCE_MS / 1000) * PCM_SAMPLE_RATE);

export function isSilentFrame(samples: ArrayLike<number>): boolean {
  let sum = 0;
  const n = samples.length;
  for (let i = 0; i < n; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / Math.max(1, n)) < SPEECH_RMS_THRESHOLD;
}

/** Pure endpointer: count silence, reset on voice. */
export function stepSilence(framesSilent: number, silent: boolean): number {
  return silent ? framesSilent + 1 : 0;
}

export function shouldFinalize(framesSilent: number, hasSpeech: boolean): boolean {
  return hasSpeech && framesSilent >= ENDPOINT_SILENCE_FRAMES;
}

/** Encode float32 mono samples as a 16-bit PCM WAV buffer (16 kHz). */
export function encodeWav(samples: Float32Array, sampleRate = PCM_SAMPLE_RATE): ArrayBuffer {
  const bytesPerSample = 2;
  const blockAlign = bytesPerSample;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return buffer;
}

export interface OfflineCallSttCallbacks {
  /** A finalized utterance — the endpointer closed the turn, or the mic was
   * hushed mid-word. Delivered even if the call phase moved on while Handy
   * (model load takes a beat) was still decoding: a turn spoken before the
   * hush is still the user's turn. */
  onUtterance: (text: string) => void;
  /** Live speech feedback while the user talks (optional). */
  onHeard?: (text: string) => void;
  onError: (message: string) => void;
}

export interface OfflineCallStt {
  start: () => Promise<void>;
  stop: () => void;
  /** While true, frames are dropped (the bot is speaking). */
  setMuted: (muted: boolean) => void;
}

/** One offline listening session for a call. Null when the bridge lacks the
 * headless-transcription surface (browser/dev shells fall back to cloud). */
export function createOfflineCallStt(callbacks: OfflineCallSttCallbacks): OfflineCallStt | null {
  const bridge = window.ogb;
  if (!bridge?.handyTranscribeFile) return null;

  let stream: MediaStream | null = null;
  let context: AudioContext | null = null;
  let processor: ScriptProcessorNode | null = null;
  let muted = false;
  let stopped = false;
  let utterance: Float32Array[] = [];
  let utteranceFrames = 0;
  let framesSilent = 0;
  let hasSpeech = false;
  /** A WAV is inside Handy right now; Handy runs one model load per call,
   * so transcriptions are strictly serialized — never interleaved. */
  let transcribing = false;
  /** Speech arrived (or was hushed in) while transcribing; it ships as the
   * next turn the moment the current WAV comes back. */
  let pendingAfterTranscribe = false;

  const resetUtterance = () => {
    utterance = [];
    utteranceFrames = 0;
    framesSilent = 0;
    hasSpeech = false;
  };

  const finalize = () => {
    if (stopped) return;
    if (transcribing) {
      // Keep capturing — everything buffered ships right after the current
      // WAV, in order. Dropping it here would eat the user's words.
      pendingAfterTranscribe = true;
      return;
    }
    if (!hasSpeech || utteranceFrames === 0) {
      resetUtterance();
      return;
    }
    transcribing = true;
    const chunks = utterance;
    resetUtterance();
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const merged = new Float32Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    const wav = encodeWav(merged);
    void bridge
      .handyTranscribeFile!(wav, handyPath())
      .then((result) => {
        transcribing = false;
        if (stopped) return;
        if (!result.ok) {
          callbacks.onError(result.error ?? "Handy could not transcribe the recording.");
        } else {
          const text = (result.text ?? "").trim();
          if (text) callbacks.onUtterance(text);
        }
        if (pendingAfterTranscribe) {
          pendingAfterTranscribe = false;
          finalize();
        }
      })
      .catch(() => {
        transcribing = false;
        if (!stopped) callbacks.onError("Handy transcription failed.");
        if (pendingAfterTranscribe) {
          pendingAfterTranscribe = false;
          finalize();
        }
      });
  };

  const closeCapture = () => {
    try {
      processor?.disconnect();
    } catch {}
    processor = null;
    void context?.close().catch(() => {});
    context = null;
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = null;
  };

  return {
    async start() {
      // listen() fires again after every turn; reopening must never stack a
      // second capture graph on top of the last one.
      closeCapture();
      muted = false;
      resetUtterance();
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      context = new AudioContext({ sampleRate: PCM_SAMPLE_RATE });
      const source = context.createMediaStreamSource(stream);
      processor = context.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (event) => {
        if (stopped || muted) return;
        const samples = event.inputBuffer.getChannelData(0);
        const silent = isSilentFrame(samples);
        if (!silent) {
          hasSpeech = true;
          framesSilent = 0;
        } else {
          framesSilent = stepSilence(framesSilent, true);
        }
        if (hasSpeech) {
          utterance.push(new Float32Array(samples));
          utteranceFrames += samples.length;
          // The cap is in SAMPLES (16 kHz) — 2,592 frames, not 234 "ms".
          if (utteranceFrames >= MAX_UTTERANCE_SAMPLES) finalize();
          else if (shouldFinalize(framesSilent, hasSpeech)) finalize();
        } else if (shouldFinalize(framesSilent, false)) {
          resetUtterance();
        }
      };
      source.connect(processor);
      const mute = context.createGain();
      mute.gain.value = 0;
      processor.connect(mute);
      mute.connect(context.destination);
    },
    stop() {
      stopped = true;
      pendingAfterTranscribe = false;
      closeCapture();
    },
    setMuted(next: boolean) {
      muted = next;
      if (next && hasSpeech) finalize();
    },
  };
}
