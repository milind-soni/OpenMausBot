export const OPENAI_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"] as const;
export const DEFAULT_OPENAI_VOICE = "marin";

export const OPENAI_VOICE_ERRORS = {
  key: "voice.openai.error.key",
  auth: "voice.openai.error.auth",
  rateLimit: "voice.openai.error.rateLimit",
  timeout: "voice.openai.error.timeout",
  connection: "voice.openai.error.connection",
  empty: "voice.openai.error.empty",
  invalid: "voice.openai.error.invalid",
  limit: "voice.openai.error.limit",
  cancelled: "voice.openai.error.cancelled",
  failed: "voice.openai.error.failed",
  voice: "voice.openai.error.voice",
} as const;
export type OpenAiVoiceErrorCode = keyof typeof OPENAI_VOICE_ERRORS;
