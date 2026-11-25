export type CloudVoiceProvider = "elevenlabs" | "fish" | "gemini";
export type VoiceKeyDraft = { provider: CloudVoiceProvider | null; value: string };

/** Never expose a credential draft after the selected provider changes. */
export function voiceKeyDraftValue(draft: VoiceKeyDraft, provider: CloudVoiceProvider): string {
  return draft.provider === provider ? draft.value : "";
}
