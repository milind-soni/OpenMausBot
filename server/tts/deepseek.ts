// DeepSeek speech, per https://api-docs.deepseek.com/guides/tts/ and https://api-docs.deepseek.com/guides/asr/.
import { z } from "zod";
import { DEEPSEEK_VOICES, type DeepSeekVoice } from "../../shared/deepseek-voice.ts";
import type { Audio, Voice } from "./elevenlabs.ts";

const API = (process.env.OMB_DEEPSEEK_SPEECH_API || "https://api.deepseek.com/v1").replace(/\/+$/, "");
/** DeepSeek TTS takes at most 10,000 characters; at four UTF-8 bytes each that stays under its 64 KiB body limit. */
export const TTS_MAX_CHARS = 10_000;
/** DeepSeek ASR takes at most 8 MiB and 120 seconds of audio. */
export const ASR_MAX_BYTES = 8 * 1024 * 1024;
export const ASR_MAX_SECONDS = 120;
const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
const MAX_JSON_BYTES = 256 * 1024;
const TIMEOUT_MS = 60_000;

const LABELS: Record<DeepSeekVoice, string> = { stella: "Stella (female)", tide: "Tide (male)" };
const transcriptSchema = z.object({ text: z.string(), request_id: z.string().optional(), duration_ms: z.number().optional() });

export class DeepSeekSpeechError extends Error {
  readonly status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

export function listVoices(): Voice[] {
  return DEEPSEEK_VOICES.map((id) => ({ id, label: LABELS[id] }));
}

export const isDeepSeekVoice = (voice: unknown): voice is DeepSeekVoice => DEEPSEEK_VOICES.some((id) => id === voice);

function refusal(status: number, action: "speech" | "transcription"): DeepSeekSpeechError {
  if (status === 401 || status === 403) return new DeepSeekSpeechError("DeepSeek rejected the API key. Check the DeepSeek key in Settings → AI → Other services.", 409);
  if (status === 402) return new DeepSeekSpeechError("The DeepSeek account has insufficient balance for speech.");
  if (status === 429) return new DeepSeekSpeechError("DeepSeek is rate-limiting speech. Wait a moment and try again.");
  if (status === 400 || status === 413 || status === 422) {
    return new DeepSeekSpeechError(action === "speech" ? "DeepSeek could not read that text aloud." : "DeepSeek could not hear that recording.", 400);
  }
  if (status >= 500) return new DeepSeekSpeechError("DeepSeek speech is unavailable right now. Try again later.");
  return new DeepSeekSpeechError(`DeepSeek ${action} failed (HTTP ${status}).`);
}

async function request(path: string, init: RequestInit, action: "speech" | "transcription", signal?: AbortSignal): Promise<Response> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, { ...init, redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  } catch {
    if (signal?.aborted) throw new DeepSeekSpeechError(`DeepSeek ${action} was cancelled.`, 499);
    if (timeout.aborted) throw new DeepSeekSpeechError(`DeepSeek ${action} timed out. Try again.`, 504);
    throw new DeepSeekSpeechError("Could not reach DeepSeek. Check your connection.");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    // Remote error bodies can echo credentials or the spoken text.
    throw refusal(response.status, action);
  }
  return response;
}

async function readBounded(response: Response, max: number, action: "speech" | "transcription"): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > max) {
    await response.body?.cancel().catch(() => {});
    throw new DeepSeekSpeechError(`DeepSeek returned too large a ${action} response.`);
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => {});
        throw new DeepSeekSpeechError(`DeepSeek returned too large a ${action} response.`);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof DeepSeekSpeechError) throw error;
    throw new DeepSeekSpeechError(`DeepSeek ${action} was interrupted. Try again.`);
  }
  if (declared && size !== declared) throw new DeepSeekSpeechError(`DeepSeek ${action} was interrupted. Try again.`);
  return Buffer.concat(chunks, size);
}

export interface WavInfo {
  format: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  seconds: number;
}

/** A complete RIFF/WAVE file: a fmt chunk and a data chunk that fits in the bytes; otherwise undefined. */
export function readWav(bytes: Uint8Array): WavInfo | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") return undefined;
  let fmt: Omit<WavInfo, "seconds"> | undefined;
  for (let at = 12; at + 8 <= bytes.byteLength;) {
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (body + size > bytes.byteLength) return undefined;
    if (tag(at) === "fmt " && size >= 16) {
      fmt = {
        format: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    } else if (tag(at) === "data") {
      if (!fmt || !fmt.channels || !fmt.sampleRate || !fmt.bitsPerSample || !size) return undefined;
      const frame = fmt.channels * Math.ceil(fmt.bitsPerSample / 8);
      if (size % frame) return undefined;
      return { ...fmt, seconds: size / frame / fmt.sampleRate };
    }
    at = body + size + (size % 2);
  }
  return undefined;
}

function normalizeStreamingWav(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength < 12) return bytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE" || view.getUint32(4, true) !== 0xffffffff) return bytes;
  for (let at = 12; at + 8 <= bytes.byteLength;) {
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (tag(at) === "data" && size === 0xffffffff) {
      const normalized = Buffer.from(bytes);
      normalized.writeUInt32LE(bytes.byteLength - 8, 4);
      normalized.writeUInt32LE(bytes.byteLength - body, at + 4);
      return normalized;
    }
    if (body + size > bytes.byteLength) break;
    at = body + size + (size % 2);
  }
  return bytes;
}

export async function synthesize(text: string, voiceId: string, key: string, signal?: AbortSignal): Promise<Audio> {
  if (!key) throw new DeepSeekSpeechError("Add a DeepSeek API key in Settings → AI → Other services to use DeepSeek voice.", 409);
  if (!isDeepSeekVoice(voiceId)) throw new DeepSeekSpeechError("Choose Stella or Tide as the DeepSeek voice.", 409);
  const spoken = text.trim();
  if (!spoken) throw new DeepSeekSpeechError("There is no text to read aloud.", 400);
  if ([...spoken].length > TTS_MAX_CHARS) throw new DeepSeekSpeechError(`DeepSeek reads at most ${TTS_MAX_CHARS} characters at once.`, 413);
  const body = JSON.stringify({ text: spoken, voice_id: voiceId, format: "wav", filter_markdown: true });
  const response = await request("/tools/tts", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "audio/wav" },
    body,
  }, "speech", signal);
  const mime = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (mime !== "audio/wav" && mime !== "audio/x-wav" && mime !== "audio/wave") {
    await response.body?.cancel().catch(() => {});
    throw new DeepSeekSpeechError("DeepSeek returned an unexpected audio format. Try again later.");
  }
  const received = await readBounded(response, MAX_AUDIO_BYTES, "speech");
  if (!received.byteLength) throw new DeepSeekSpeechError("DeepSeek returned empty audio. Try again.");
  const bytes = normalizeStreamingWav(received);
  if (!readWav(bytes)) throw new DeepSeekSpeechError("DeepSeek returned incomplete audio. Try again.");
  return { bytes, mime: "audio/wav" };
}

export async function transcribe(audio: Uint8Array, key: string, signal?: AbortSignal): Promise<string> {
  if (!key) throw new DeepSeekSpeechError("Add a DeepSeek API key in Settings → AI → Other services to dictate with DeepSeek.", 409);
  if (audio.byteLength > ASR_MAX_BYTES) throw new DeepSeekSpeechError("DeepSeek hears at most 8 MiB of audio at once.", 413);
  const wav = readWav(audio);
  if (!wav || wav.format !== 1 || wav.bitsPerSample !== 16) throw new DeepSeekSpeechError("DeepSeek needs a 16-bit PCM WAV recording.", 400);
  if (wav.seconds > ASR_MAX_SECONDS) throw new DeepSeekSpeechError(`DeepSeek hears at most ${ASR_MAX_SECONDS} seconds at once.`, 413);
  const form = new FormData();
  form.append("file", new Blob([audio as Uint8Array<ArrayBuffer>], { type: "audio/wav" }), "speech.wav");
  const response = await request("/tools/asr", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, accept: "application/json" },
    body: form,
  }, "transcription", signal);
  const raw = await readBounded(response, MAX_JSON_BYTES, "transcription");
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw).toString("utf8"));
  } catch {
    json = undefined;
  }
  const parsed = transcriptSchema.safeParse(json);
  if (!parsed.success) throw new DeepSeekSpeechError("DeepSeek returned an unexpected transcription. Try again later.");
  return parsed.data.text.trim();
}
