// Runs on the harness, never the renderer: the key must not leave the server. OMB_ELEVENLABS_API overrides the
// base URL for dev and tests.
import { elevenLabsProviderApi } from "../included-services.ts";

const MODEL = "eleven_flash_v2_5";
// 64kbps mono is indistinguishable for speech and a third of the bytes
const FORMAT = "mp3_44100_64";

export interface Voice {
  id: string;
  label: string;
  description?: string;
}

export interface Audio {
  bytes: Uint8Array;
  mime: string;
}

export type VerifyResult = { ok: true } | { ok: false; message: string };

async function safeJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function message(status: number, what: string, body: any): string {
  const theirs =
    (typeof body?.detail === "string" && body.detail.trim()) ||
    (typeof body?.detail?.message === "string" && body.detail.message.trim()) ||
    (typeof body?.message === "string" && body.message.trim()) ||
    "";
  if (status === 401 || status === 403) {
    return "ElevenLabs rejected that key. If it's a restricted key, give it the Voices and Text to Speech permissions — or paste an unrestricted one.";
  }
  if (status === 429) return theirs || "ElevenLabs is rate-limiting this account — wait a moment and try again.";
  if (status === 402) return theirs || "ElevenLabs says this account is out of credit.";
  return theirs ? `${what} failed: ${theirs}` : `${what} failed (${status})`;
}

/** Checked against /voices, not /user: ElevenLabs keys carry per-endpoint scopes, and a speech-only key has no `user_read`. */
export async function verifyKey(key: string): Promise<VerifyResult> {
  try {
    const res = await fetch(`${elevenLabsProviderApi()}/voices`, {
      headers: { "xi-api-key": key },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) return { ok: true };
    return { ok: false, message: message(res.status, "checking that key", await safeJson(res)) };
  } catch {
    return { ok: false, message: "Couldn't reach ElevenLabs to check that key — check your connection." };
  }
}

export async function listVoices(key: string, api: string): Promise<Voice[]> {
  const res = await fetch(`${api}/voices`, {
    headers: { "xi-api-key": key },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await safeJson(res);
  if (!res.ok) throw new Error(message(res.status, "listing voices", body));
  return (body?.voices ?? [])
    .map((v: any): Voice => ({
      id: String(v.voice_id ?? ""),
      label: String(v.name ?? "Voice"),
      description: [v.labels?.accent, v.labels?.description].filter(Boolean).join(" · ") || undefined,
    }))
    .filter((v: Voice) => v.id);
}

// tsconfig.server.json targets ES2023: Promise.withResolvers is ES2024.
function withResolvers<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
export interface Synthesis {
  /** The clip's first bytes off the wire; settle while later chunks are still arriving. */
  firstAudio: Promise<Audio>;
  /** The complete clip, once every chunk has arrived. */
  audio: Promise<Audio>;
}

export function synthesize(text: string, voiceId: string, key: string, api: string): Synthesis {
  const firstAudio = withResolvers<Audio>();
  const audio = withResolvers<Audio>();
  // Callers may consume only `audio`: a failure before the first chunk must not become an unhandled rejection.
  firstAudio.promise.catch(() => {});
  void (async () => {
    try {
      const res = await fetch(`${api}/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=${FORMAT}`, {
        method: "POST",
        headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
        body: JSON.stringify({ text, model_id: MODEL }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(message(res.status, "speaking", await safeJson(res)));
      if (!res.body) throw new Error("speaking failed: no audio came back");
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value?.length) continue;
        chunks.push(value);
        if (chunks.length === 1) firstAudio.resolve({ bytes: value, mime: "audio/mpeg" });
      }
      if (!chunks.length) throw new Error("speaking failed: the audio came back empty");
      audio.resolve({ bytes: Buffer.concat(chunks), mime: "audio/mpeg" });
    } catch (error) {
      firstAudio.reject(error);
      audio.reject(error);
    }
  })();
  return { firstAudio: firstAudio.promise, audio: audio.promise };
}
