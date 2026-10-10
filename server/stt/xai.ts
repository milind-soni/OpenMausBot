// Grok speech-to-text (POST https://api.x.ai/v1/stt). Reuses the workspace
// xAI key exactly like Grok TTS does, so a user who already has Grok voice
// gets recognition with no new credential.
import type { SttProvider, TranscribeOptions, Transcript, Utterance } from "./types.ts";

function resolveApi(): string {
  const raw = (process.env.OMB_XAI_STT_API || "https://api.x.ai/v1").replace(/\/+$/, "");
  const url = new URL(raw);
  const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("OMB_XAI_STT_API requires HTTPS for remote endpoints; HTTP is allowed only on loopback.");
  }
  return raw;
}

function normalizeLanguage(lang: string): string {
  const normalized = lang.trim().toLowerCase();
  const primary = normalized.split(/[-_]/)[0] || normalized;
  return primary.length === 3 ? primary : primary.slice(0, 2);
}

function refusal(status: number): string {
  if (status === 401 || status === 403) return "xAI rejected the key or its speech permissions. Check the xAI key in Settings.";
  if (status === 402) return "The xAI account needs credits to transcribe speech.";
  if (status === 429) return "xAI is rate-limiting speech recognition. Wait a moment and try again.";
  return `Grok speech recognition failed (HTTP ${status}).`;
}

export function xaiStt(key: string, timeoutMs = 20_000): SttProvider {
  return {
    id: "xai",
    async transcribe(utterance: Utterance, call: TranscribeOptions): Promise<Transcript> {
      const api = resolveApi();
      const form = new FormData();
      // xAI reads option fields before the file; the file must come last.
      form.append("format", "true");
      if (call.language) form.append("language", normalizeLanguage(call.language));
      form.append("file", new Blob([utterance.wav.slice()], { type: "audio/wav" }), "utterance.wav");

      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = call.signal ? AbortSignal.any([call.signal, timeout]) : timeout;
      let response: Response;
      try {
        response = await fetch(`${api}/stt`, {
          method: "POST",
          headers: { authorization: `Bearer ${key}` },
          body: form,
          signal,
          redirect: "error",
        });
      } catch (error) {
        if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
          throw new Error("Grok speech recognition timed out.");
        }
        throw new Error("Could not reach Grok speech recognition. Check your connection.");
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(refusal(response.status));
      }
      const body = (await response.json().catch(() => null)) as { text?: unknown; language?: unknown } | null;
      if (!body || typeof body.text !== "string") throw new Error("Grok returned an unreadable transcript.");
      return { text: body.text.trim(), language: typeof body.language === "string" ? body.language : undefined };
    },
  };
}
