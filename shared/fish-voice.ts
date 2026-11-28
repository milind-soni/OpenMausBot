import { z } from "zod";

export const FISH_TTS_MODELS = ["s2.1-pro", "s2.1-pro-free", "drama-3"] as const;
export type FishTtsModel = (typeof FISH_TTS_MODELS)[number];

export const fishSynthesisSchema = z.object({
  temperature: z.number().min(0).max(1).optional(),
  topP: z.number().min(0).max(1).optional(),
  speed: z.number().min(0.5).max(2).optional(),
  mp3Bitrate: z.literal([64, 128]).optional(),
});

export type FishSynthesis = z.output<typeof fishSynthesisSchema>;
