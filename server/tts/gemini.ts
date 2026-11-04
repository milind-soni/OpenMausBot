import { z } from "zod";
import type { Audio, Voice } from "./elevenlabs.ts";

export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash-lite-tts";
const API = (process.env.OMB_GEMINI_TTS_API || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
const VOICES = ["Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede", "Callirrhoe", "Autonoe", "Enceladus", "Iapetus", "Umbriel", "Algieba", "Despina", "Erinome", "Algenib", "Rasalgethi", "Laomedeia", "Achernar", "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi", "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat"];
const outputSchema = z.object({ steps: z.array(z.object({
  type: z.string(),
  content: z.array(z.object({ type: z.string(), data: z.string().optional(), mime_type: z.string().optional() })).optional(),
})) });

export function listVoices(): Voice[] {
  return VOICES.map((id) => ({ id, label: id }));
}

export function isSupportedVoice(voiceId: string | undefined): boolean {
  return voiceId !== undefined && VOICES.includes(voiceId);
}

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
