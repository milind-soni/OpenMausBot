/** DeepSeek TTS voice ids: Stella (female) and Tide (male). */
export const DEEPSEEK_VOICES = ["stella", "tide"] as const;
export type DeepSeekVoice = (typeof DEEPSEEK_VOICES)[number];
export const DEFAULT_DEEPSEEK_VOICE: DeepSeekVoice = "stella";
/** The page recorder's cap for one DeepSeek clip: under ASR's 120-second limit with room for a 64 ms frame. */
export const DEEPSEEK_RECORDING_MAX_MS = 115_000;
