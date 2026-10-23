import { z } from "zod";

export const contextSettingsSchema = z.object({
    /** Accepted for older configs; ordinary replay now preserves the full tail. */
    rebuildBytes: z.number().int().min(1_024).max(1_000_000).optional(),
    compactAt: z.number().positive().max(10_000_000).optional(),
    autoCompact: z.boolean().optional(),
    roomCompactAt: z.number().positive().max(10_000_000).optional(),
    checkpointOutputTokens: z.number().int().min(256).max(32_768).optional(),
    checkpointTailTokens: z.number().int().min(1).max(128_000).optional(),
    checkpointPrefillTimeoutMs: z.number().int().min(1_000).nullable().optional(),
    checkpointIdleTimeoutMs: z.number().int().min(1_000).optional(),
  });
