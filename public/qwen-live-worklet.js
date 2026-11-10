const HALF_TAPS = 32;
const PHASES = 128;

export class Pcm16Framer {
  constructor(frameSamples = 320) {
    this.frameSamples = frameSamples;
    this.frame = new ArrayBuffer(frameSamples * 2);
    this.used = 0;
  }

  push(samples) {
    const frames = [];
    for (const sample of samples) {
      const value = Math.max(-1, Math.min(1, sample));
      new DataView(this.frame).setInt16(this.used++ * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
      if (this.used === this.frameSamples) {
        frames.push(this.frame);
        this.frame = new ArrayBuffer(this.frameSamples * 2);
        this.used = 0;
      }
    }
    return frames;
  }
}

export class StreamingResampler {
  constructor(inputRate, outputRate) {
    this.step = inputRate / outputRate;
    this.samples = [];
    this.position = 0;
    this.offset = 0;
    this.outputSamples = 0;
    const cutoff = Math.min(1, outputRate / inputRate) * 0.9;
    this.kernels = Array.from({ length: PHASES }, (_, phase) => {
      const weights = Float64Array.from({ length: HALF_TAPS * 2 + 1 }, (_, tap) => {
        const x = tap - HALF_TAPS - phase / PHASES;
        const sinc = Math.abs(x) < 1e-8 ? cutoff : Math.sin(Math.PI * cutoff * x) / (Math.PI * x);
        const window = 0.5 + 0.5 * Math.cos(Math.PI * x / (HALF_TAPS + 1));
        return sinc * window;
      });
      const sum = weights.reduce((a, b) => a + b, 0);
      return weights.map((weight) => weight / sum);
    });
  }

  push(input) {
    for (const sample of input) this.samples.push(sample);
    const output = [];
    while (Math.floor(this.position) + HALF_TAPS < this.samples.length) {
      const index = Math.floor(this.position);
      const weights = this.kernels[Math.min(PHASES - 1, Math.floor((this.position - index) * PHASES))];
      let value = 0;
      for (let tap = 0; tap < weights.length; tap++) value += (this.samples[index + tap - HALF_TAPS] ?? 0) * weights[tap];
      output.push(value);
      this.position = ++this.outputSamples * this.step - this.offset;
    }
    const consumed = Math.max(0, Math.floor(this.position) - HALF_TAPS);
    this.samples.splice(0, consumed);
    this.offset += consumed;
    this.position = this.outputSamples * this.step - this.offset;
    return Float32Array.from(output);
  }
}

if (typeof registerProcessor === "function") {
  class QwenLiveCapture extends AudioWorkletProcessor {
    constructor() {
      super();
      this.resampler = new StreamingResampler(sampleRate, 16_000);
      this.framer = new Pcm16Framer();
      this.released = false;
      this.started = false;
      this.overrun = false;
      this.credits = 0;
      this.capturedAt = null;
      this.port.onmessage = (event) => {
        if (event.data === "release") {
          this.released = true;
          this.resampler = this.framer = null;
        } else if (!this.released && !this.overrun && event.data?.type === "capture.credit" && Number.isInteger(event.data.frames) && event.data.frames > 0 && event.data.frames <= 50) {
          this.credits = Math.min(50, this.credits + event.data.frames);
          this.started = true;
        }
      };
    }

    process(inputs) {
      if (this.released) return false;
      if (!this.started || this.overrun) return true;
      const mono = inputs[0]?.[0];
      if (mono) {
        if (this.capturedAt === null) this.capturedAt = currentTime;
        for (const pcm of this.framer.push(this.resampler.push(mono))) {
          if (!this.credits) {
            this.overrun = true;
            this.resampler = this.framer = null;
            this.port.postMessage({ type: "capture.overrun" });
            break;
          }
          this.credits -= 1;
          const capturedAt = this.capturedAt;
          this.capturedAt += pcm.byteLength / 32_000;
          this.port.postMessage({ type: "capture.frame", pcm, capturedAt }, [pcm]);
        }
      }
      return true;
    }
  }
  registerProcessor("qwen-live-capture", QwenLiveCapture);
}
