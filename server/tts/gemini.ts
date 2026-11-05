import { z } from "zod";
import type { Audio, Voice, VerifyResult } from "./elevenlabs.ts";

export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash-lite-tts";
const API = (process.env.OMB_GEMINI_TTS_API || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
const VOICES = ["Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede", "Callirrhoe", "Autonoe", "Enceladus", "Iapetus", "Umbriel", "Algieba", "Despina", "Erinome", "Algenib", "Rasalgethi", "Laomedeia", "Achernar", "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi", "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat"];
const outputSchema = z.object({ steps: z.array(z.object({
  type: z.string(),
  content: z.array(z.object({ type: z.string(), data: z.string().optional(), mime_type: z.string().optional() })).optional(),
})) });

/**
 * Lists available Gemini voices, returning the catalog of 30 prebuilt voices.
 * @returns Array of available Voice descriptors.
 */
export function listVoices(): Voice[] {
  return VOICES.map((id) => ({ id, label: id }));
}

/**
 * Checks whether a voice ID is in the supported Gemini prebuilt voice catalog.
 * @param voiceId Voice identifier to check.
 * @returns True if voice is supported, false otherwise.
 */
export function isSupportedVoice(voiceId: string | undefined): boolean {
  return voiceId !== undefined && VOICES.includes(voiceId);
}

/**
 * Verifies that the provided Gemini API key is valid by querying the models endpoint.
 * @param key The Gemini API key to verify.
 * @returns An object indicating whether the key is valid, with an error message if invalid.
 */
export async function verifyKey(key: string): Promise<VerifyResult> {
  try {
    const res = await fetch(`${API}/models?pageSize=1`, {
      method: "GET",
      redirect: "error",
      headers: { "x-goog-api-key": key },
      signal: AbortSignal.timeout(20_000),
    });
    await res.body?.cancel().catch(() => {});
    if (res.ok) return { ok: true };
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      return { ok: false, message: "Gemini rejected the API key or its speech permissions. Check the key in Settings." };
    }
    if (res.status === 429) {
      return { ok: false, message: "Gemini quota exceeded. Try again later." };
    }
    return { ok: false, message: `Couldn't verify Gemini API key (HTTP ${res.status}).` };
  } catch {
    return { ok: false, message: "Couldn't reach Gemini to check that key — check your connection." };
  }
}

/**
 * Synthesizes text to speech using the Gemini speech interactions API.
 * @param text The plain text to read aloud.
 * @param voiceId Prebuilt Gemini voice ID.
 * @param key The Gemini API key.
 * @param model Gemini model identifier.
 * @returns Synthesized Audio object containing bytes and MIME type.
 */
export async function synthesize(text: string, voiceId: string, key: string, model = DEFAULT_GEMINI_MODEL): Promise<Audio> {
  if (!isSupportedVoice(voiceId)) throw new Error("Pick a Gemini voice from the voice list.");
  let response: Response;
  try {
    response = await fetch(`${API}/interactions`, {
      method: "POST", redirect: "error",
      headers: { "x-goog-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({ model: model.trim() || DEFAULT_GEMINI_MODEL,
        input: [{ type: "user_input", content: [{ type: "text", text }] }],
        response_format: { type: "audio" }, generation_config: { speech_config: [{ voice: voiceId }] },
      }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new Error("Could not reach Gemini speech generation. Check your connection and try again.");
  }
  if (!response.ok) {
    await response.body?.cancel();
    // Remote errors can contain the credential or the private transcript.
    if (response.status === 401 || response.status === 403) throw new Error("Gemini rejected the API key or its speech permissions. Check the key in Settings.");
    if (response.status === 429) throw new Error("Gemini speech quota exceeded. Check your plan or try again later.");
    throw new Error(`Gemini speech generation failed (HTTP ${response.status}). Check the model and try again.`);
  }
  const parsed = outputSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new Error("Gemini returned an invalid speech response.");
  const audio = parsed.data.steps.filter((step) => step.type === "model_output")
    .flatMap((step) => step.content ?? []).filter((part) => part.type === "audio").at(-1);
  if (!audio?.data || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(audio.data)) {
    throw new Error("Gemini returned empty or invalid audio.");
  }
  const bytes = Buffer.from(audio.data, "base64");
  if (audio.mime_type && audio.mime_type.split(";")[0].toLowerCase() !== "audio/wav") throw new Error("Gemini returned an unexpected audio format.");
  if (bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Gemini returned invalid WAV audio.");
  }
  return { bytes, mime: "audio/wav" };
}
