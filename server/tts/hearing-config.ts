import { z } from "zod";

/** How the person is heard. hearWith "elevenlabs": dictation and Take turns go to Scribe with their own ElevenLabs
 * key on every computer. hearLanguage: the ISO 639 code they speak to Scribe; "" or absent lets Scribe detect it. */
export const hearingConfigShape = {
  hearWith: z.enum(["device", "elevenlabs"]).optional(),
  hearLanguage: z.union([z.literal(""), z.string().trim().toLowerCase().regex(/^[a-z]{2,3}$/)]).optional(),
};
