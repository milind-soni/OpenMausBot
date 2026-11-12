// Deepgram Voice (Aura TTS) and Speech Recognition (Nova STT) provider.
import type { Audio, Voice } from "./elevenlabs.ts";

const DEEPGRAM_API = (process.env.OMB_DEEPGRAM_API || "https://api.deepgram.com/v1").replace(/\/+$/, "");

export const DEEPGRAM_VOICES: Voice[] = [
  { id: "aura-2-asteria-en", label: "Asteria (Conversational Female)", description: "Expressive, clear pacing" },
  { id: "aura-2-orion-en", label: "Orion (Technical Male)", description: "Authoritative, confident tone" },
  { id: "aura-2-luna-en", label: "Luna (Warm Female)", description: "Friendly, casual assistant" },
  { id: "aura-2-zeus-en", label: "Zeus (Direct Male)", description: "Energetic, clear announcements" },
  { id: "aura-2-athena-en", label: "Athena (Smooth Female)", description: "Calm, articulate voice" },
  { id: "aura-2-helios-en", label: "Helios (Bright Male)", description: "Warm, engaging tone" },
];

export async function listVoices(): Promise<Voice[]> {
  return DEEPGRAM_VOICES;
}

/**
 * Synthesizes text into MP3 audio via Deepgram Aura TTS.
 */
export async function synthesize(text: string, voiceId: string, key: string, signal?: AbortSignal): Promise<Audio> {
  const model = voiceId || "aura-2-asteria-en";
  const url = `${DEEPGRAM_API}/speak?model=${encodeURIComponent(model)}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Token ${key}`,
        "content-type": "application/json",
        accept: "audio/mpeg",
      },
      body: JSON.stringify({ text }),
      signal: signal ?? AbortSignal.timeout(30_000),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new Error("Deepgram voice timed out. Try again.");
    }
    throw new Error("Could not reach Deepgram voice. Check your connection.");
  }

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(`Deepgram TTS failed (${response.status}): ${errorBody || response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return {
    bytes: new Uint8Array(arrayBuffer),
    mime: "audio/mpeg",
  };
}

/**
 * Transcribes audio into text via Deepgram Nova STT.
 */
export async function transcribe(audio: Uint8Array, mime: string, key: string, signal?: AbortSignal): Promise<string> {
  const url = `${DEEPGRAM_API}/listen?model=nova-3&smart_format=true&punctuate=true`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Token ${key}`,
        "content-type": mime || "audio/wav",
      },
      body: audio,
      signal: signal ?? AbortSignal.timeout(30_000),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new Error("Deepgram transcribe timed out. Try again.");
    }
    throw new Error("Could not reach Deepgram speech recognition. Check your connection.");
  }

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(`Deepgram transcription failed (${response.status}): ${errorBody || response.statusText}`);
  }

  const json = (await response.json()) as {
    results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> };
  };
  const transcript = json.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
  return transcript.trim();
}
