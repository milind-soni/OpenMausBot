import { z } from "zod";
import { hearingConfigShape } from "./hearing-config.ts";

export const FISH_TTS_MODELS = ["s2.1-pro", "s2.1-pro-free"] as const;
export type FishTtsModel = (typeof FISH_TTS_MODELS)[number];

export const voiceProviders = ["elevenlabs", "fish", "system", "chatterbox", "xai", "gemini", "openai", "deepseek", "cartesia"] as const;
export type VoiceProvider = (typeof voiceProviders)[number];
const key = z.string().trim().optional();

export const ttsConfigSchema = z.object({
  key,
  fishKey: key,
  geminiKey: key,
  cartesiaKey: key,
  cartesiaModel: z.string().trim().max(100).optional(),
  cartesiaLanguage: z.string().trim().regex(/^(?:[a-z]{2,3}(?:-[A-Z]{2})?)?$/, "Use a Cartesia language code such as nl or en-GB").optional(),
  voice: z.string().optional(),
  provider: z.enum(voiceProviders).optional(),
  baseUrl: z.string().trim().max(2048)
    .refine((value) => !value || /^https?:\/\//i.test(value), "the Chatterbox server address must start with http:// or https://").optional(),
  model: z.string().optional(),
  ...hearingConfigShape,
  fishModel: z.enum(FISH_TTS_MODELS).optional(),
  everyReply: z.boolean().optional(),
});

export type TtsConfig = z.output<typeof ttsConfigSchema>;
