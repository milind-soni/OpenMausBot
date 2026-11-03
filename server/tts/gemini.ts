import { z } from "zod";
import type { Audio, Voice } from "./elevenlabs.ts";

const API = (process.env.OMB_GEMINI_TTS_API || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");

export const GEMINI_TTS_DEFAULT_MODEL = "gemini-3.8-flash-lite-tts";

export const GEMINI_PREBUILT_VOICES: readonly Voice[] = Object.freeze([
  { id: "Puck", label: "Puck", description: "Upbeat" },
  { id: "Charon", label: "Charon", description: "Informative" },
  { id: "Kore", label: "Kore", description: "Firm" },
  { id: "Fenrir", label: "Fenrir", description: "Excitable" },
  { id: "Aoede", label: "Aoede", description: "Breezy" },
  { id: "Zephyr", label: "Zephyr", description: "Bright" },
  { id: "Leda", label: "Leda", description: "Youthful" },
  { id: "Orus", label: "Orus", description: "Firm" },
  { id: "Callirrhoe", label: "Callirrhoe", description: "Easy-going" },
  { id: "Autonoe", label: "Autonoe", description: "Bright" },
  { id: "Enceladus", label: "Enceladus", description: "Breathy" },
  { id: "Iapetus", label: "Iapetus", description: "Clear" },
  { id: "Umbriel", label: "Umbriel", description: "Easy-going" },
  { id: "Algieba", label: "Algieba", description: "Smooth" },
  { id: "Despina", label: "Despina", description: "Smooth" },
  { id: "Erinome", label: "Erinome", description: "Clear" },
  { id: "Algenib", label: "Algenib", description: "Gravelly" },
  { id: "Rasalgethi", label: "Rasalgethi", description: "Informative" },
  { id: "Laomedeia", label: "Laomedeia", description: "Upbeat" },
  { id: "Achernar", label: "Achernar", description: "Soft" },
]);

function refusal(status: number): string {
  if (status === 400) return "Gemini rejected the speech generation request parameters.";
  if (status === 401 || status === 403) return "Gemini rejected the API key or its permissions. Check your Gemini key in Settings.";
  if (status === 429) return "Gemini is rate-limiting speech generation. Wait a moment and try again.";
  if (status === 404) return "Gemini TTS model or voice not found. Check the model and voice settings.";
  return `Gemini voice failed (HTTP ${status}). Try again later.`;
}

export async function listVoices(_key: string): Promise<Voice[]> {
  return [...GEMINI_PREBUILT_VOICES];
}

export async function synthesize(
  text: string,
  voiceId: string,
  key: string,
  model = GEMINI_TTS_DEFAULT_MODEL,
): Promise<Audio> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Text is required for speech synthesis.");

  const voiceName = voiceId.trim() || "Puck";
  let targetModel = model.trim() || GEMINI_TTS_DEFAULT_MODEL;
  if (targetModel.startsWith("models/")) {
    targetModel = targetModel.slice("models/".length);
  }

  const url = `${API}/models/${encodeURIComponent(targetModel)}:generateContent?key=${encodeURIComponent(key)}`;
  const body = {
    contents: [
      {
        parts: [
          {
            text: trimmed,
          },
        ],
      },
    ],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName,
          },
        },
      },
    },
  };

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "x-goog-api-key": key,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new Error("Gemini voice timed out. Try again.");
    }
    throw new Error("Could not reach Gemini voice. Check your connection.");
  }

  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(refusal(response.status));
  }

  const json = await response.json().catch(() => null);
  if (!json || typeof json !== "object") {
    throw new Error("Gemini returned invalid response for speech synthesis.");
  }

  const candidate = (json as { candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> } }> }).candidates?.[0];
  const inlineData = candidate?.content?.parts?.[0]?.inlineData;

  if (!inlineData?.data) {
    throw new Error("Gemini returned empty audio response.");
  }

  const buffer = Buffer.from(inlineData.data, "base64");
  return {
    bytes: new Uint8Array(buffer),
    mime: inlineData.mimeType || "audio/wav",
  };
}
