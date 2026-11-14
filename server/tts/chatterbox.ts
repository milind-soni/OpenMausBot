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

export async function listChatterboxVoices(baseUrl: string): Promise<Voice[]> {
  try {
    try {
      const res = await request(
        `${apiRoot(baseUrl)}/models`,
        { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) },
        "listing voices",
        baseUrl,
      );
      if (res.ok) {
        const body = await safeJson(res);
        const voices = (body?.data ?? [])
          .map((m: any): Voice => ({ id: String(m?.id ?? ""), label: String(m?.id ?? "") }))
          .filter((v: Voice) => v.id);
        if (voices.length) return voices;
      }
    } catch {
    }
    // Some servers (Chatterbox-TTS-Server) list voices here instead.
    const voicesRes = await request(
      `${apiRoot(baseUrl)}/audio/voices`,
      { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) },
      "listing voices",
      baseUrl,
    );
    if (voicesRes.ok) {
      const body = await safeJson(voicesRes);
      const voices = (body?.voices ?? [])
        .map((entry: any): Voice => {
          // Chatterbox-TTS-Server returns filename strings; its docs describe { filename, display_name } objects.
          if (typeof entry === "string") return { id: entry, label: entry };
          const id = String(entry?.filename ?? entry?.id ?? "");
          return { id, label: String(entry?.display_name ?? entry?.name ?? id) };
        })
        .filter((v: Voice) => v.id);
      if (voices.length) return voices;
    }
  } catch {
  }
  return FALLBACK_VOICES;
}

/** wav: every browser plays it and every compatible server makes it. The server's own content-type wins. */
export async function synthesizeChatterbox(
  text: string,
  voiceId: string,
  baseUrl: string,
  model?: string,
): Promise<Audio> {
  const res = await request(
    `${apiRoot(baseUrl)}/audio/speech`,
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "audio/wav" },
      body: JSON.stringify({ model: model?.trim() || DEFAULT_MODEL, input: text, voice: voiceId, response_format: "wav" }),
      signal: AbortSignal.timeout(60_000),
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
