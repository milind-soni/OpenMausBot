// Speech-to-text for a meeting. Security invariant: no provider key ever reaches the cloud computer.
// - A Cloud plan uses the project's hosted ElevenLabs key, and only through its Admin voice relay; a Cloud never falls
//   through to another source when the relay refuses (unless the person asks for transcription on the computer).
// - Anyone else uses their own keys, in this order: ElevenLabs (realtime; the computer gets single-use tokens minted
//   here, POST {api}/single-use-token/realtime_scribe, 15 minutes for one connection), Groq, then OpenAI (their
//   transcription APIs are called from this server on audio the computer sends back), then Whisper on the computer.
import { voiceCredential } from "../included-services.ts";
import type { SpeechGrant } from "./engine.ts";

/** An included (relay) token is spent in blocks: the bot reconnects with a fresh token every so often, which the relay meters. */
export const RELAY_ROTATE_MS = 10 * 60_000;
export const GROQ_API = "https://api.groq.com/openai/v1";
export const OPENAI_API = "https://api.openai.com/v1";
const GROQ_MODEL = "whisper-large-v3-turbo";
const OPENAI_MODEL = "whisper-1";

/** One transcribed word, in milliseconds from the start of the audio it came from. */
export interface HeardWord { w: string; s: number; e: number }

export type SpeechSource =
  | { kind: "relay" | "eleven"; grant(signal?: AbortSignal): Promise<SpeechGrant> }
  | { kind: "chunks"; provider: "groq" | "openai"; transcribe(audio: Buffer, signal?: AbortSignal): Promise<HeardWord[]> }
  | { kind: "whisper" };

export interface SpeechKeys {
  tts?: { key?: string };
  groq?: { key?: string; url?: string };
  openai?: { key?: string };
}

export class SpeechRefusal extends Error {}

export function speechSource(keys: SpeechKeys, options: { local?: boolean } = {}, fetchImpl: typeof fetch = fetch, env: NodeJS.ProcessEnv = process.env): SpeechSource {
  if (options.local) return { kind: "whisper" };
  const included = voiceCredential(undefined, env);
  if (included?.included) return { kind: "relay", grant: (signal) => mint(included.api, included.token, true, fetchImpl, signal) };
  const own = (value: string | undefined) => value?.trim() || undefined;
  const eleven = own(keys.tts?.key);
  if (eleven) {
    const credential = voiceCredential(eleven, env)!;
    return { kind: "eleven", grant: (signal) => mint(credential.api, credential.token, false, fetchImpl, signal) };
  }
  const groq = own(keys.groq?.key);
  if (groq) return { kind: "chunks", provider: "groq", transcribe: (audio, signal) => transcribe(own(keys.groq?.url) ?? GROQ_API, groq, GROQ_MODEL, "Groq", audio, fetchImpl, signal) };
  const openai = own(keys.openai?.key);
  if (openai) return { kind: "chunks", provider: "openai", transcribe: (audio, signal) => transcribe(OPENAI_API, openai, OPENAI_MODEL, "OpenAI", audio, fetchImpl, signal) };
  return { kind: "whisper" };
}

async function mint(api: string, key: string, included: boolean, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<SpeechGrant> {
  const response = await fetchImpl(`${api}/single-use-token/realtime_scribe`, {
    method: "POST", redirect: "error", headers: { "xi-api-key": key, accept: "application/json" }, signal: signal ?? AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => null) as { token?: unknown; detail?: { message?: unknown } } | null;
  if (response.ok && typeof body?.token === "string" && body.token) return { kind: "eleven", token: body.token, ...(included ? { rotateMs: RELAY_ROTATE_MS } : {}) };
  const said = typeof body?.detail?.message === "string" ? body.detail.message : "";
  throw new SpeechRefusal(included
    ? said || `Meeting transcription isn't available on this Cloud right now (${response.status}).`
    : `ElevenLabs refused a transcription token for the speech key in Settings (${response.status}).${said ? ` ${said}` : ""}`);
}

async function transcribe(api: string, key: string, model: string, name: string, audio: Buffer, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<HeardWord[]> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)], { type: "audio/ogg" }), "speech.ogg");
  form.append("model", model);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  form.append("timestamp_granularities[]", "segment");
  const response = await fetchImpl(`${api.replace(/\/+$/, "")}/audio/transcriptions`, {
    method: "POST", redirect: "error", headers: { authorization: `Bearer ${key}` }, body: form, signal: signal ?? AbortSignal.timeout(60_000),
  });
  const body = await response.json().catch(() => null) as { words?: unknown; segments?: unknown; text?: unknown; error?: { message?: unknown } } | null;
  if (!response.ok) {
    const said = typeof body?.error?.message === "string" ? ` ${body.error.message.slice(0, 200)}` : "";
    throw new SpeechRefusal(`${name} refused the transcription request with the key in Settings (${response.status}).${said}`);
  }
  const ms = (value: unknown) => Math.max(0, Math.round(Number(value) * 1000) || 0);
  const words = Array.isArray(body?.words) ? body.words.flatMap((w: any) => typeof w?.word === "string" && w.word.trim() ? [{ w: w.word.trim(), s: ms(w.start), e: ms(w.end) }] : []) : [];
  if (words.length) return words;
  const segments = Array.isArray(body?.segments) ? body.segments.flatMap((s: any) => typeof s?.text === "string" && s.text.trim() ? [{ w: s.text.trim(), s: ms(s.start), e: ms(s.end) }] : []) : [];
  if (segments.length) return segments;
  return typeof body?.text === "string" && body.text.trim() ? [{ w: body.text.trim(), s: 0, e: 0 }] : [];
}
