import { z } from "zod";
import { IMAGE_PROVIDERS, normalizeImageGenerationUrl, type ImageGenerationConfig } from "../shared/image-generation.ts";

const API_KEY_SHAPE = /^(sk-|sk_|xai-|gsk_|AIza)[A-Za-z0-9_-]{12,}$/;
const imageModelIdSchema = z.string().trim().max(200).refine(
  (value) => !["\r", "\n", "\0"].some((character) => value.includes(character)),
  "Use a model ID without control characters",
);
const imageSlotSchema = z.object({ provider: z.enum(IMAGE_PROVIDERS), model: imageModelIdSchema.optional() }).strict();
// Stored configs keep loading; only a new save is refused, so a pasted key is never kept as a model.
const savedImageSlotSchema = z.object({
  provider: z.enum(IMAGE_PROVIDERS),
  model: imageModelIdSchema.refine((value) => !API_KEY_SHAPE.test(value), "This looks like an API key, not a model ID: paste the key in the key field instead").optional(),
}).strict();
export const imageGenConfigSchema = z.object({
  primary: imageSlotSchema.optional(),
  fallback: imageSlotSchema.optional(),
  maxPerTurn: z.number().int().min(1).max(10).optional(),
  provider: z.enum(["openai", "xai", "custom"]).optional(),
  key: z.string().optional(),
  geminiKey: z.string().optional(),
  customApiKey: z.string().optional(),
  customUrl: z.string().trim().max(2048).transform((value, ctx) => {
    if (!value) return "";
    try { return normalizeImageGenerationUrl(value); } catch (error) {
      ctx.addIssue({ code: "custom", message: (error as Error).message });
      return z.NEVER;
    }
  }).optional(),
  customModel: imageModelIdSchema.optional(),
});
/** A patch from an older client names one `provider`; it becomes the base, so only `primary` decides it. */
export const imageGenPatchSchema = imageGenConfigSchema.extend({ primary: savedImageSlotSchema.optional(), fallback: savedImageSlotSchema.nullable().optional() })
  .transform(({ provider, customModel, ...patch }) => {
    const typed = [patch.primary, patch.fallback].find((slot) => slot?.provider === "custom" && slot.model)?.model;
    const remembered = typed ?? (provider && provider !== "custom" ? undefined : customModel);
    const next = remembered === undefined ? patch : { ...patch, customModel: remembered };
    return !provider || patch.primary ? next : { ...next, primary: { provider } };
  });

export type ImageGenCredentialPatch = Pick<ImageGenerationConfig, "key" | "customApiKey" | "geminiKey">;
