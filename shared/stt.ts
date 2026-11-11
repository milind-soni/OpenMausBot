export const STT_PROVIDERS = ["auto", "fish", "openai", "gemini"] as const;
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
  google: { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
} as const;

export function isEndpointStt(provider: SttProvider | undefined): provider is "openai" | "gemini" {
  return provider === "openai" || provider === "gemini";
}

/** Public transcription settings expose readiness and a saved-key flag, never the credential. */
export interface SttStatus {
  provider: SttProvider;
  baseUrl: string;
  model: string;
  configured: boolean;
  keyConfigured: boolean;
}
