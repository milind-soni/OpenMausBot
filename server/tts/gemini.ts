import type { Audio, Voice } from "./elevenlabs.ts";

const API = (process.env.OMB_GEMINI_TTS_API || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");

/** Default Gemini text-to-speech generation model. */
export const GEMINI_TTS_DEFAULT_MODEL = "gemini-3.8-flash-lite-tts";

/**
 * 20 prebuilt single-speaker voices provided by the Gemini API speech generation service.
 */
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

/** Verification result from testing an API key. */
export type VerifyResult = { ok: true } | { ok: false; message: string };

/**
 * Returns a human-readable failure message for a Gemini HTTP status code.
 * @param status The HTTP status code returned by the Gemini API.
 * @returns Descriptive error message explaining the failure.
 */
function refusal(status: number): string {
  if (status === 400) return "Gemini rejected the speech generation request parameters.";
  if (status === 401 || status === 403) return "Gemini rejected the API key or its permissions. Check your Gemini key in Settings.";
  if (status === 429) return "Gemini is rate-limiting speech generation. Wait a moment and try again.";
  if (status === 404) return "Gemini TTS model or voice not found. Check the model and voice settings.";
  return `Gemini voice failed (HTTP ${status}). Try again later.`;
}

/**
 * Verifies that the provided Gemini API key is valid by querying the models endpoint.
 * @param key The Gemini API key to verify.
 * @returns An object indicating whether the key is valid, with an error message if invalid.
 */
export async function verifyKey(key: string): Promise<VerifyResult> {
  try {
    const url = `${API}/models?pageSize=1`;
    const res = await fetch(url, {
      headers: { "x-goog-api-key": key },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) return { ok: true };
    return { ok: false, message: refusal(res.status) };
  } catch {
    return { ok: false, message: "Couldn't reach Gemini to check that key — check your connection." };
  }
}

/**
 * Lists available Gemini voices, returning the catalog of 20 prebuilt voices.
 * @param _key Optional Gemini API key.
 * @returns Array of available Voice descriptors.
 */
export async function listVoices(_key: string): Promise<Voice[]> {
  return [...GEMINI_PREBUILT_VOICES];
}

/**
 * Wraps raw PCM audio buffer with a standard 44-byte WAV header.
 * @param pcmData Raw PCM buffer.
 * @param sampleRate Audio sample rate in Hz (default 24000).
 * @param numChannels Number of audio channels (default 1).
 * @param bitsPerSample Bits per audio sample (default 16).
 * @returns Complete WAV audio buffer with RIFF/WAVE headers.
 */
function pcmToWav(pcmData: Buffer, sampleRate = 24000, numChannels = 1, bitsPerSample = 16): Buffer {
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = pcmData.length;
  const header = Buffer.alloc(44);

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmData]);
}

/**
 * Ensures that synthesized audio data is packaged in a valid WAV container with headers.
 * @param buffer Buffer containing the audio bytes.
 * @param mimeType Optional MIME type reported by the API.
 * @returns Object containing the audio byte array and audio MIME type.
 */
function ensureWav(buffer: Buffer, mimeType?: string): Audio {
  const isWav = buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WAVE";
  if (isWav) {
    return { bytes: new Uint8Array(buffer), mime: mimeType || "audio/wav" };
  }
  const wavBuffer = pcmToWav(buffer);
  return { bytes: new Uint8Array(wavBuffer), mime: "audio/wav" };
}

/**
 * Synthesizes text to speech using the Gemini API generateContent endpoint.
 * @param text The plain text to read aloud.
 * @param voiceId The prebuilt voice name (e.g. Puck, Aoede).
 * @param key The Gemini API key used for authentication.
 * @param model The Gemini model to target (defaults to gemini-3.8-flash-lite-tts).
 * @returns Synthesized Audio object containing bytes and MIME type.
 */
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

  // Security: pass the API key in the x-goog-api-key header only, not in the URL query string.
  const url = `${API}/models/${encodeURIComponent(targetModel)}:generateContent`;
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
  return ensureWav(buffer, inlineData.mimeType);
}
