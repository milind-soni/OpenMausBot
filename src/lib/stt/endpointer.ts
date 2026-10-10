// Energy endpointer for the universal speech engine: decides when a spoken
// turn starts and ends from per-frame RMS. Pure and frame-driven so it is
// unit-testable without a microphone.
//
// Why energy and not a neural VAD here: capture already runs through
// Chromium's WebRTC noise suppression + echo cancellation, which removes
// most steady background noise, and call mode is half-duplex (the mic is
// gated while the bot speaks). An adaptive noise floor with hysteresis is
// then enough for turn-taking. The interface is deliberately small so a
// Silero-VAD (ONNX) implementation can replace it later without touching
// the engine.

export type EndpointerOptions = {
  frameMs: number;
  /** Trailing silence that ends a turn. 0 = manual: never auto-end
   * (composer dictation and push-to-talk finish explicitly). */
  endpointMs: number;
  /** Frames at the start that only calibrate the noise floor. Absorbs the
   * tail of the bot's own playback and the click of the mic opening. */
  calibrationMs: number;
  /** Sustained energy needed before a turn counts as started. */
  startMs: number;
  /** A "turn" shorter than this (a cough, a door) is discarded. */
  minSpeechMs: number;
  /** Hard ceiling; the server rejects utterances over 30 s. */
  maxUtteranceMs: number;
  /** Speech threshold as a multiple of the noise floor. */
  ratio: number;
  /** Absolute RMS floor for the threshold, for near-silent rooms. */
  minThreshold: number;
};

export const DEFAULT_ENDPOINTER: EndpointerOptions = {
  frameMs: 20,
  endpointMs: 900,
  calibrationMs: 240,
  startMs: 80,
  minSpeechMs: 250,
  maxUtteranceMs: 28_000,
  ratio: 3,
  minThreshold: 0.012,
};

export type EndpointEvent = "none" | "start" | "end" | "discard" | "limit";

export class Endpointer {
  private readonly o: EndpointerOptions;
  private floor = 0;
  private elapsed = 0;
  private speaking = false;
  private above = 0;
  private silence = 0;
  private speechMs = 0;

  constructor(options: Partial<EndpointerOptions> = {}) {
    this.o = { ...DEFAULT_ENDPOINTER, ...options };
  }

  get inSpeech(): boolean {
    return this.speaking;
  }

  /** Feed one frame's RMS (0..1). Returns what, if anything, just happened. */
  push(rms: number): EndpointEvent {
    const { frameMs } = this.o;
    this.elapsed += frameMs;
    if (this.elapsed <= this.o.calibrationMs) {
      this.floor = this.floor === 0 ? rms : this.floor * 0.8 + rms * 0.2;
      return "none";
    }
    const threshold = Math.max(this.o.minThreshold, this.floor * this.o.ratio);

    if (!this.speaking) {
      if (rms > threshold) {
        this.above += frameMs;
        if (this.above >= this.o.startMs) {
          this.speaking = true;
          this.speechMs = this.above;
          this.silence = 0;
          return "start";
        }
      } else {
        this.above = 0;
        // Track the room slowly, only while nobody is talking.
        this.floor = this.floor * 0.95 + rms * 0.05;
      }
      return "none";
    }

    this.speechMs += frameMs;
    // Hysteresis: staying "in speech" needs less energy than entering it,
    // so soft word endings do not chop a sentence in half.
    if (rms > threshold * 0.6) this.silence = 0;
    else this.silence += frameMs;

    if (this.speechMs >= this.o.maxUtteranceMs) {
      this.reset();
      return "limit";
    }
    if (this.o.endpointMs > 0 && this.silence >= this.o.endpointMs) {
      const voiced = this.speechMs - this.silence;
      this.reset();
      return voiced >= this.o.minSpeechMs ? "end" : "discard";
    }
    return "none";
  }

  private reset() {
    this.speaking = false;
    this.above = 0;
    this.silence = 0;
    this.speechMs = 0;
  }
}
