export const VOICE_PLAYBACK_RATES = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;
export type VoicePlaybackRate = (typeof VOICE_PLAYBACK_RATES)[number];
