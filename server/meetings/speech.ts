// Speech-to-text for a meeting. Security invariant: the cloud computer only ever gets a short-lived single-use token for
// ElevenLabs' realtime transcription (POST {api}/single-use-token/realtime_scribe, valid 15 minutes for one connection),
// never a key: a Cloud asks its Admin voice relay, which holds the key; a person's own key is used here, on this server.
import { voiceCredential } from "../included-services.ts";
import type { SpeechGrant } from "./engine.ts";

/** An included (relay) token is spent in blocks: the bot reconnects with a fresh token every so often, which the relay meters. */
export const RELAY_ROTATE_MS = 10 * 60_000;

export type SpeechSource = { grant(signal?: AbortSignal): Promise<SpeechGrant>; local: boolean };

export function speechSource(ownKey: string | undefined, fetchImpl: typeof fetch = fetch): SpeechSource {
  const credential = voiceCredential(ownKey?.trim() || undefined);
  if (!credential) return { local: true, grant: async () => ({ kind: "whisper" }) };
  return {
    local: false,
    async grant(signal) {
      const response = await fetchImpl(`${credential.api}/single-use-token/realtime_scribe`, {
        method: "POST", redirect: "error", headers: { "xi-api-key": credential.token, accept: "application/json" },
        signal: signal ?? AbortSignal.timeout(20_000),
      });
      const body = await response.json().catch(() => null) as { token?: unknown; detail?: { message?: unknown } } | null;
      if (!response.ok || typeof body?.token !== "string" || !body.token) {
        const said = typeof body?.detail?.message === "string" ? ` ${body.detail.message}` : "";
        throw new Error(credential.included
          ? `Meeting transcription isn't available on this Cloud right now (${response.status}).${said}`
          : `ElevenLabs refused a transcription token for the speech key in Settings (${response.status}).${said}`);
      }
      return { kind: "eleven", token: body.token, ...(credential.included ? { rotateMs: RELAY_ROTATE_MS } : {}) };
    },
  };
}
