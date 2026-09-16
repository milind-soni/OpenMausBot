// ElevenLabs, the one voice.
//
// Everything about talking to the service lives in this file: verifying a
// key, listing voices, and turning one utterance into mp3 bytes. It runs on
// the HARNESS, never the renderer, because the key must not leave the
// server — GET /api/config reports configured-or-not booleans and nothing
// else, and that invariant is worth more than a saved round trip.
//
// One request per utterance rather than the streaming-input WebSocket: the
// client already splits text into utterances and fetches the next while the
// current one plays, which gets the same perceived latency with far fewer
// moving parts — and no socket to leak when a turn is interrupted.
const API = process.env.ASTRA_ELEVENLABS_API || "https://api.elevenlabs.io/v1";
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

/** Prefer ElevenLabs' own words over anything we can invent — it knows the
 * plan, the quota and the model name. Mirrors box.boxErrorMessage. */
function message(status: number, what: string, body: any): string {
  const theirs =
    (typeof body?.detail === "string" && body.detail.trim()) ||
    (typeof body?.detail?.message === "string" && body.detail.message.trim()) ||
    (typeof body?.message === "string" && body.message.trim()) ||
    "";
  if (status === 401 || status === 403) {
    // Restricted keys are the common case, not a corner: a key with the
    // wrong scopes is REAL and still fails, so saying "copy a fresh one"
    // sends people to regenerate a key that was never the problem.
    return "ElevenLabs rejected that key. If it's a restricted key, give it the Voices and Text to Speech permissions — or paste an unrestricted one.";
  }
  if (status === 429) return theirs || "ElevenLabs is rate-limiting this account — wait a moment and try again.";
  if (status === 402) return theirs || "ElevenLabs says this account is out of credit.";
  return theirs ? `${what} failed: ${theirs}` : `${what} failed (${status})`;
}

/** Check a key before we store it: a rejected credential must fail at the
 * paste, not hours later in another panel with nothing to act on.
 *
 * Checked against /voices, NOT /user. ElevenLabs keys carry per-endpoint
 * scopes, and a key restricted to speech has no `user_read` — verifying
 * there rejects perfectly good keys for a permission this feature never
 * uses (found the hard way, with a real key). /voices is what the settings
 * picker needs next, so it tests exactly the capability that matters. */
export async function verifyKey(key: string): Promise<VerifyResult> {
  try {
    const res = await fetch(`${API}/voices`, {
      headers: { "xi-api-key": key },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) return { ok: true };
    return { ok: false, message: message(res.status, "checking that key", await safeJson(res)) };
  } catch {
    return { ok: false, message: "Couldn't reach ElevenLabs to check that key — check your connection." };
  }
}

export async function listVoices(key: string): Promise<Voice[]> {
  const res = await fetch(`${API}/voices`, {
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

export async function synthesize(text: string, voiceId: string, key: string): Promise<Audio> {
  const res = await fetch(`${API}/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${FORMAT}`, {
    method: "POST",
    headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({ text, model_id: MODEL }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(message(res.status, "speaking", await safeJson(res)));
  return { bytes: new Uint8Array(await res.arrayBuffer()), mime: "audio/mpeg" };
}
