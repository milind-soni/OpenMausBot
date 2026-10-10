// The AudioWorklet that turns the mic into 20 ms Int16 frames plus their RMS.
// Shipped as an inline source string loaded through a Blob URL, so it needs
// no bundler support and behaves the same in dev, packaged Electron, and a
// plain browser tab.
//
// The AudioContext is created at 16 kHz; Chromium resamples the device
// (44.1/48 kHz on nearly every Windows and Linux mic) internally, so no
// JavaScript resampler is needed.
export const FRAME_SAMPLES = 320; // 20 ms at 16 kHz

const SOURCE = `
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Int16Array(${FRAME_SAMPLES});
    this.n = 0;
    this.sq = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const s = Math.max(-1, Math.min(1, ch[i]));
      this.sq += s * s;
      this.buf[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.n === ${FRAME_SAMPLES}) {
        const rms = Math.sqrt(this.sq / ${FRAME_SAMPLES});
        const pcm = this.buf;
        this.port.postMessage({ pcm, rms }, [pcm.buffer]);
        this.buf = new Int16Array(${FRAME_SAMPLES});
        this.n = 0;
        this.sq = 0;
      }
    }
    return true;
  }
}
registerProcessor("omb-pcm-capture", PcmCapture);
`;

let moduleUrl: string | null = null;

export function captureWorkletUrl(): string {
  moduleUrl ??= URL.createObjectURL(new Blob([SOURCE], { type: "text/javascript" }));
  return moduleUrl;
}

export const CAPTURE_PROCESSOR = "omb-pcm-capture";
