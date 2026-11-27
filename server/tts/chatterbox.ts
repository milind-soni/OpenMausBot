// The server address and model id are settings, not secrets (the server is the user's own machine): shown in full.
import type { Audio, Voice } from "./elevenlabs.ts";

export const DEFAULT_MODEL = "chatterbox-turbo";

/** Most Chatterbox servers speak with one built-in voice unless told otherwise. */
export const FALLBACK_VOICES: Voice[] = [
  { id: "default", label: "Default", description: "the server's built-in Chatterbox voice" },
];

export function apiRoot(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return /\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

async function safeJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function message(status: number, what: string, body: any): string {
  const theirs =
    (typeof body?.error === "string" && body.error.trim()) ||
    (typeof body?.detail === "string" && body.detail.trim()) ||
    (typeof body?.message === "string" && body.message.trim()) ||
    "";
  return theirs ? `${what} failed: ${theirs}` : `${what} failed (${status})`;
}

async function request(url: string, init: RequestInit, what: string, baseUrl: string): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e) {
    if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
      throw new Error(`${what} timed out — the Chatterbox server at ${baseUrl.trim()} did not answer`);
    }
    throw new Error(`couldn't reach the Chatterbox server at ${baseUrl.trim()} — check that it is running`);
  }
}

async function fetchVoiceList(url: string, baseUrl: string, read: (body: any) => Voice[]): Promise<Voice[]> {
  try {
    const res = await request(
      url,
      { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) },
      "listing voices",
      baseUrl,
    );
    return res.ok ? read(await safeJson(res)).filter((v) => v.id) : [];
  } catch {
    return [];
  }
}

/** /audio/voices names real voices; /models names models (Kokoro-FastAPI answers both), so it is only a fallback. */
export async function listChatterboxVoices(baseUrl: string): Promise<Voice[]> {
  const voices = await fetchVoiceList(`${apiRoot(baseUrl)}/audio/voices`, baseUrl, (body) =>
    (body?.voices ?? []).map((entry: any): Voice => {
      // Chatterbox-TTS-Server returns filename strings; its docs describe { filename, display_name } objects.
      if (typeof entry === "string") return { id: entry, label: entry };
      const id = String(entry?.filename ?? entry?.id ?? "");
      return { id, label: String(entry?.display_name ?? entry?.name ?? id) };
    }),
  );
  if (voices.length) return voices;
  const models = await fetchVoiceList(`${apiRoot(baseUrl)}/models`, baseUrl, (body) =>
    (body?.data ?? []).map((m: any): Voice => ({ id: String(m?.id ?? ""), label: String(m?.id ?? "") })),
  );
  return models.length ? models : FALLBACK_VOICES;
}

/** wav: every browser plays it and every compatible server makes it. The server's own content-type wins. */
export async function synthesizeChatterbox(
  text: string,
  voiceId: string,
  baseUrl: string,
  model?: string,
  signal?: AbortSignal,
): Promise<Audio> {
  const res = await request(
    `${apiRoot(baseUrl)}/audio/speech`,
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "audio/wav" },
      body: JSON.stringify({ model: model?.trim() || DEFAULT_MODEL, input: text, voice: voiceId, response_format: "wav" }),
      signal: AbortSignal.any([AbortSignal.timeout(60_000), ...(signal ? [signal] : [])]),
    },
    "speaking",
    baseUrl,
  );
  if (!res.ok) throw new Error(message(res.status, "speaking", await safeJson(res)));
  const header = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const mime =
    header === "audio/mpeg" || header === "audio/mp3"
      ? "audio/mpeg"
      : header === "audio/x-wav"
        ? "audio/wav"
        : header.startsWith("audio/")
          ? header
          : "audio/wav";
  return { bytes: new Uint8Array(await res.arrayBuffer()), mime };
}
