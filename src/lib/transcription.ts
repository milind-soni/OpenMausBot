export interface SttProfile { model: string; endpoint: string; key?: string; hasKey?: boolean; clearKey?: boolean }
export interface SttConfig {
  version: number; provider: string; language: string; profiles: Record<string, SttProfile>;
  localModel: string; threads: number; accelerate: boolean; executable: string;
}
export interface LocalSpeechState {
  models: Array<{ id: string; name: string; installed: boolean }>;
  runtimeReady: boolean; executable: string; installing: boolean;
  progress: { label: string; percent: number } | null; canDownloadRuntime: boolean;
}
export interface SttState {
  config: SttConfig;
  providers: Array<{ id: string; name: string; kind: string; help: string; model?: string }>;
  local: LocalSpeechState;
}
export function transcriptionError(error: unknown): string {
  return String(error instanceof Error ? error.message : error || "Transcription failed.")
    .replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

/** Segment mono speech at pauses, with a bounded, ordered upload queue. */
export function createSpeechSegments(options: {
  transcribe: (pcm: ArrayBuffer) => Promise<string>;
  onText: (text: string) => void;
  onError: (error: string) => void;
}) {
  let samples: number[][] = [], size = 0, voiced = 0, silent = 0, offset = 0;
  let closed = false, canceled = false, queued = 0, text = "";
  let pending = Promise.resolve();
  const flush = () => {
    const raw = samples, length = size, speech = voiced;
    samples = []; size = 0; voiced = 0; silent = 0;
    if (speech < .12 || canceled || !length) return;
    if (queued + length > 16000 * 120) {
      canceled = true;
      options.onError("Transcription cannot keep up. Try a smaller local model or a faster service.");
      return;
    }
    const pcm = new Int16Array(length); let n = 0;
    for (const block of raw) for (const value of block) pcm[n++] = Math.round(Math.max(-1, Math.min(1, value)) * 32767);
    queued += length;
    pending = pending.then(async () => {
      try {
        if (canceled) return;
        const result = await options.transcribe(pcm.buffer);
        if (!canceled && result) { text += (text ? " " : "") + result; options.onText(text); }
      } catch (error) {
        if (!canceled) { canceled = true; options.onError(transcriptionError(error)); }
      } finally { queued -= length; }
    });
  };
  return {
    push(input: Float32Array, rate: number) {
      if (closed || canceled || !Number.isFinite(rate) || rate < 16000) return;
      const values: number[] = [], ratio = rate / 16000;
      for (; offset < input.length; offset += ratio) values.push(input[Math.floor(offset)]!);
      offset -= input.length;
      if (!values.length) return;
      const active = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length) > .006;
      const duration = values.length / 16000;
      if (active) { voiced += duration; silent = 0; } else silent += duration;
      samples.push(values); size += values.length;
      if ((voiced > .12 && silent > .8) || size >= 16000 * 28) flush();
      else if (!voiced && size > 16000 * .3) { samples = samples.slice(-2); size = samples.reduce((sum, block) => sum + block.length, 0); }
    },
    async finish() { if (!closed) { closed = true; flush(); } await pending; return text; },
    cancel() { canceled = true; closed = true; samples = []; size = 0; },
  };
}
