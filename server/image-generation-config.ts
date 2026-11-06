import { z } from "zod";
import { IMAGE_PROVIDERS, looksLikeApiKey, normalizeImageGenerationUrl, type ImageGenerationConfig } from "../shared/image-generation.ts";

const imageModelIdSchema = z.string().trim().max(200).refine(
  (value) => !["\r", "\n", "\0"].some((character) => value.includes(character)),
  "Use a model ID without control characters",
);
const imageSlotSchema = z.object({ provider: z.enum(IMAGE_PROVIDERS), model: imageModelIdSchema.optional() }).strict();
// Stored configs keep loading; only a new save is refused, so a pasted key is never kept as a model.
const savedModelIdSchema = imageModelIdSchema.refine((value) => !looksLikeApiKey(value), "This looks like an API key, not a model ID: paste the key in the key field instead");
const savedImageSlotSchema = z.object({ provider: z.enum(IMAGE_PROVIDERS), model: savedModelIdSchema.optional() }).strict();
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
export const imageGenPatchSchema = imageGenConfigSchema.extend({ primary: savedImageSlotSchema.optional(), fallback: savedImageSlotSchema.nullable().optional(), customModel: savedModelIdSchema.optional() })
  .transform(({ provider, customModel, ...patch }) => {
    const typed = [patch.primary, patch.fallback].find((slot) => slot?.provider === "custom" && slot.model)?.model;
    const remembered = typed ?? (provider && provider !== "custom" ? undefined : customModel);
    const next = remembered === undefined ? patch : { ...patch, customModel: remembered };
    return !provider || patch.primary ? next : { ...next, primary: { provider } };
  });

export type ImageGenCredentialPatch = Pick<ImageGenerationConfig, "key" | "customApiKey" | "geminiKey">;

const keyed = z.object({ key: z.string().optional() }).catch({});
const imageKeysOnly = z.object({ key: z.string().optional(), geminiKey: z.string().optional(), customApiKey: z.string().optional() }).catch({});

/** Every key `imageProviderKey` reads (importing it here would loop back through config.ts). */
function storedImageKeys(disk: Record<string, unknown>): string[] {
  const image = imageKeysOnly.parse(disk.imageGen ?? {});
  return [image.key, image.geminiKey, image.customApiKey, keyed.parse(disk.xai ?? {}).key, keyed.parse(disk.openrouter ?? {}).key]
    .map((key) => key?.trim() ?? "").filter(Boolean);
}

/** `saveConfig` around a save: a model equal to a key, before or after it, is refused when typed and dropped when stored, since
 * reads hide such a model only while that key stays configured. */
export function keepKeysOutOfImageModels(disk: Record<string, unknown>, patch: z.output<typeof imageGenPatchSchema> | undefined): () => void {
  const before = storedImageKeys(disk);
  return () => {
    const keys = new Set([...before, ...storedImageKeys(disk)]);
    const isKey = (model: unknown) => typeof model === "string" && keys.has(model.trim());
    if ([patch?.primary?.model, patch?.fallback?.model, patch && "customModel" in patch ? patch.customModel : undefined].some(isKey)) {
      throw Object.assign(new Error("This is an API key, not a model ID: paste the key in the key field instead"), { status: 400 });
    }
    const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
    if (!isRecord(disk.imageGen)) return;
    const next = { ...disk.imageGen };
    for (const name of ["primary", "fallback"]) {
      const slot = next[name];
      if (isRecord(slot) && isKey(slot.model)) {
        const { model: _dropped, ...kept } = slot;
        next[name] = kept;
      }
    }
    if (isKey(next.customModel)) delete next.customModel;
    disk.imageGen = next;
  };
}
