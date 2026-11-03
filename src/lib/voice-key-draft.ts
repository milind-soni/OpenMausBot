export type CloudVoiceProvider = "elevenlabs" | "fish" | "gemini";
export type VoiceKeyDraft = { provider: CloudVoiceProvider | null; value: string };

/**
 * Returns the draft credential value if it matches the specified provider, otherwise an empty string.
 * Never exposes a credential draft after the selected provider changes.
 * @param draft The current in-progress key draft.
 * @param provider The active cloud voice provider.
 * @returns The draft key value if the provider matches, or empty string.
 */
export function voiceKeyDraftValue(draft: VoiceKeyDraft, provider: CloudVoiceProvider): string {
  return draft.provider === provider ? draft.value : "";
}
