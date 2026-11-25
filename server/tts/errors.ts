import { NoVoiceConfigured } from "./index.ts";
import { DeepSeekSpeechError } from "./deepseek.ts";
import { OpenAiVoiceError } from "./openai.ts";

export function voiceFailure(error: unknown) {
  if (error instanceof OpenAiVoiceError) {
    return { status: error.errorKey === "voice.openai.error.key" ? 409 : 502, body: { error: error.message, errorKey: error.errorKey } };
  }
  if (error instanceof DeepSeekSpeechError) return { status: error.status === 499 ? 502 : error.status, body: { error: error.message } };
  if (error instanceof NoVoiceConfigured) return { status: 409, body: { error: error.message } };
  return undefined;
}

export function voiceNoteFailure(error: unknown) {
  const known = voiceFailure(error);
  if (known) return known;
  const status = (error as { status?: number } | null)?.status;
  if (typeof status === "number" && status >= 400 && status < 500) {
    return { status, body: { error: error instanceof Error ? error.message : "voice note failed" } };
  }
  return undefined;
}
