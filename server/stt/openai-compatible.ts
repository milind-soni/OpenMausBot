// One adapter for every server that speaks POST /v1/audio/transcriptions:
// OpenAI, Groq, and local servers (speaches / faster-whisper-server,
// whisper.cpp's server with --inference-path, LocalAI, vLLM). The local case
// is the offline path: nothing leaves the machine, and it mirrors how the
// Chatterbox TTS provider is configured (an address and a model, no key).
import type { SttProvider, SttProviderId, TranscribeOptions, Transcript, Utterance } from "./types.ts";

type Options = {
  id: Extract<SttProviderId, "openai" | "groq" | "local">;
  label: string;
  baseUrl: string;
  model: string;
  key?: string;
  timeoutMs: number;
};

function refusal(label: string, status: number): string {
  if (status === 401 || status === 403) return `${label} rejected the key. Check it in Settings.`;
  if (status === 402) return `The ${label} account needs credits to transcribe speech.`;
  if (status === 404) return `${label} could not find that transcription model. Check the model name in Settings.`;
  if (status === 413) return `${label} refused the recording as too large.`;
  if (status === 429) return `${label} is rate-limiting speech recognition. Wait a moment and try again.`;
  return `${label} speech recognition failed (HTTP ${status}).`;
}

export function openAiCompatible(options: Options): SttProvider {
  const endpoint = `${options.baseUrl.replace(/\/+$/, "")}/audio/transcriptions`;
  return {
    id: options.id,
    async transcribe(utterance: Utterance, call: TranscribeOptions): Promise<Transcript> {
      const form = new FormData();
      form.append("model", options.model);
      form.append("response_format", "json");
      form.append("temperature", "0");
      if (call.language) form.append("language", call.language.slice(0, 2).toLowerCase());
      // Copy into a fresh ArrayBuffer: Blob rejects SharedArrayBuffer views
      // and must not alias the request buffer.
      form.append("file", new Blob([utterance.wav.slice()], { type: "audio/wav" }), "utterance.wav");

      const headers: Record<string, string> = {};
      if (options.key) headers.authorization = `Bearer ${options.key}`;
      const timeout = AbortSignal.timeout(options.timeoutMs);
      const signal = call.signal ? AbortSignal.any([call.signal, timeout]) : timeout;

      let response: Response;
      try {
        response = await fetch(endpoint, { method: "POST", headers, body: form, signal, redirect: "error" });
      } catch (error) {
        if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
          throw new Error(`${options.label} speech recognition timed out.`);
        }
        throw new Error(
          options.id === "local"
            ? "Could not reach the local speech server. Check that it is running and the address in Settings."
            : `Could not reach ${options.label}. Check your connection.`,
        );
      }
      if (!response.ok) {
        // Remote error bodies can echo credentials or request details.
        await response.body?.cancel();
        throw new Error(refusal(options.label, response.status));
      }
      const body = (await response.json().catch(() => null)) as { text?: unknown; language?: unknown } | null;
      if (!body || typeof body.text !== "string") {
        throw new Error(`${options.label} returned an unreadable transcript.`);
      }
      return {
        text: body.text.trim(),
        language: typeof body.language === "string" ? body.language : undefined,
      };
    },
  };
}
