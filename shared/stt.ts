export const STT_PROVIDERS = ["auto", "fish", "openai"] as const;
/** `auto` uses Apple Speech in the Mac app and Fish Audio elsewhere. A Whisper server on the user's own computer is `openai` with its localhost API root. */
export type SttProvider = (typeof STT_PROVIDERS)[number];

/** Speech input is independent of the provider that speaks replies. */
export interface SttConfig {
  provider?: SttProvider;
  baseUrl?: string;
  model?: string;
  key?: string;
  /** Server-owned provider and API root the saved key may reach; `nowhere` revokes a credential still held by the desktop store. */
  keyFor?: string;
}

export const STT_PRESETS = {
  openai: { baseUrl: "https://api.openai.com/v1" },
  groq: { baseUrl: "https://api.groq.com/openai/v1" },
} as const;

export function isEndpointStt(provider: SttProvider | undefined): provider is "openai" {
  return provider === "openai";
}

/** The service recorded speech goes to. An upload made for another destination is refused, so a settings change mid-session cannot redirect audio. */
export const STT_DESTINATION_HEADER = "x-omb-stt-destination";

export function sttDestination(status: Pick<SttStatus, "provider" | "baseUrl"> | undefined): string {
  return isEndpointStt(status?.provider) ? `${status.provider} ${status.baseUrl}` : "fish";
}

/** Public transcription settings expose readiness and a saved-key flag, never the credential. */
export interface SttStatus {
  provider: SttProvider;
  baseUrl: string;
  model: string;
  configured: boolean;
  keyConfigured: boolean;
  /** A key is saved, or set in OMB_STT_API_KEY, but not sent: it was saved for another address, or this address is plain http to another computer. */
  keyIgnored?: true;
}
