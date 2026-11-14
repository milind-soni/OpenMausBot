// The microphone and speaker of a Gemini Live call: Gemini takes 16 kHz 16-bit PCM and answers with 24 kHz 16-bit PCM.
const MIC_RATE = 16_000;
const SPEAKER_RATE = 24_000;
/** About 100 ms of microphone audio per message. */
const MIC_CHUNK = MIC_RATE / 10;

export interface GeminiAudio {
  /** Opens the microphone; rejects as getUserMedia does, e.g. with NotAllowedError. */
  startMic(onChunk: (pcm: ArrayBuffer) => void): Promise<void>;
  play(pcm: ArrayBuffer): void;
  /** Stops what is playing and queued, when the person talks over the agent. */
  flush(): void;
  idle(): boolean;
  /** Called when the last queued audio has played. */
  onIdle: (() => void) | null;
  close(): void;
}

// Posts the input as it comes; the page resamples, so the worklet does not depend on the device's rate.
const WORKLET = `registerProcessor("omb-mic", class extends AudioWorkletProcessor {
  process(inputs) { const c = inputs[0] && inputs[0][0]; if (c) this.port.postMessage(c.slice(0)); return true; }
});`;

/** Linear resampling to 16 kHz 16-bit PCM; keeps the fractional position between calls. */
export class MicResampler {
  private readonly step: number;
  private position = 0;
  private last = 0;
  private pending: number[] = [];

  constructor(inputRate: number) {
    this.step = inputRate / MIC_RATE;
  }

  /** Returns whole chunks of MIC_CHUNK samples ready to send. */
  push(input: Float32Array): ArrayBuffer[] {
    const at = (i: number) => (i < 0 ? this.last : input[i]);
    while (this.position < input.length - 1) {
      const base = Math.floor(this.position);
      const frac = this.position - base;
      const value = at(base) + (at(base + 1) - at(base)) * frac;
      this.pending.push(Math.max(-1, Math.min(1, value)));
      this.position += this.step;
    }
    this.position -= input.length;
    if (input.length) this.last = input[input.length - 1];
    const chunks: ArrayBuffer[] = [];
    while (this.pending.length >= MIC_CHUNK) {
      const samples = this.pending.splice(0, MIC_CHUNK);
      const pcm = new Int16Array(samples.length);
      samples.forEach((s, i) => (pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff));
      chunks.push(pcm.buffer);
    }
    return chunks;
  }
}

export function pcm16ToFloat(pcm: ArrayBuffer): Float32Array<ArrayBuffer> {
  const view = new DataView(pcm);
  const out = new Float32Array(Math.floor(pcm.byteLength / 2));
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 0x8000;
  return out;
}

export function browserGeminiAudio(): GeminiAudio {
  let context: AudioContext | null = new AudioContext();
  let stream: MediaStream | null = null;
  let node: AudioWorkletNode | null = null;
  const playing = new Set<AudioBufferSourceNode>();
  let nextAt = 0;
  const audio: GeminiAudio = {
    onIdle: null,
    async startMic(onChunk) {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (!context) return void stream.getTracks().forEach((track) => track.stop());
      await context.resume().catch(() => undefined);
      const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
      try {
        await context.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      if (!context) return;
      const resampler = new MicResampler(context.sampleRate);
      node = new AudioWorkletNode(context, "omb-mic");
      node.port.onmessage = (event: MessageEvent<Float32Array>) => resampler.push(event.data).forEach(onChunk);
      context.createMediaStreamSource(stream).connect(node);
    },
    play(pcm) {
      if (!context) return;
      const samples = pcm16ToFloat(pcm);
      if (!samples.length) return;
      const buffer = context.createBuffer(1, samples.length, SPEAKER_RATE);
      buffer.copyToChannel(samples, 0);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      nextAt = Math.max(nextAt, context.currentTime);
      source.start(nextAt);
      nextAt += buffer.duration;
      playing.add(source);
      source.onended = () => {
        playing.delete(source);
        if (!playing.size) audio.onIdle?.();
      };
    },
    flush() {
      for (const source of playing) {
        source.onended = null;
        try { source.stop(); } catch { /* not started yet */ }
      }
      playing.clear();
      nextAt = 0;
    },
    idle: () => playing.size === 0,
    close() {
      audio.flush();
      node?.disconnect();
      node = null;
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
      void context?.close().catch(() => undefined);
      context = null;
    },
  };
  return audio;
}
