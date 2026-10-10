// Speech-to-text provider contract. Mirrors server/tts: the harness holds
// every credential and the renderer only ever sends audio and receives text.
//
// A provider transcribes ONE finished utterance. Endpointing (deciding when
// the user stopped talking) happens on the capture side, in the renderer,
// because that is where the microphone is and where half-duplex turn-taking
// already lives (CallView). Keeping providers utterance-shaped means every
// batch API (OpenAI, Groq, xAI REST, a local faster-whisper / whisper.cpp
// server) fits the same interface without a streaming shim.

export type SttProviderId = "openai" | "groq" | "xai" | "local";

/** Validated 16 kHz mono signed 16-bit PCM, still wrapped as a WAV file so
 * it can be forwarded to multipart APIs byte-for-byte. */
export type Utterance = {
  wav: Uint8Array;
  sampleRate: number;
  durationMs: number;
};

export type TranscribeOptions = {
  /** BCP-47 or ISO-639-1 hint; omitted means "let the model detect". */
  language?: string;
  signal?: AbortSignal;
};

export type Transcript = {
  text: string;
  language?: string;
};

export interface SttProvider {
  readonly id: SttProviderId;
  transcribe(utterance: Utterance, options: TranscribeOptions): Promise<Transcript>;
}
