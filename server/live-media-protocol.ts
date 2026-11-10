import { z } from "zod";
import type { LivePlaybackCredit, LiveClientFailure } from "../shared/wire.ts";

export const liveAudioContextStateSchema = z.enum(["running", "suspended", "interrupted", "closed"]);
export const livePlaybackCreditSchema = z.object({
  type: z.literal("playback.credit"),
  epoch: z.number().int().min(0).max(1_000_000_000),
  seq: z.number().int().min(0).max(1_000_000_000),
  bytes: z.number().int().min(0).max(24_000).multipleOf(2),
  contextState: liveAudioContextStateSchema,
}).strict().refine(credit => credit.contextState === "running" || credit.bytes === 0) satisfies z.ZodType<LivePlaybackCredit>;

export const liveClientFailureSchema = z.object({
  type: z.literal("client.failure"),
  code: z.enum(["upload-backpressure", "capture-stale", "capture-overrun", "playback-buffer", "playback-stalled", "audio-context", "media-socket", "media-protocol", "media-processor"]),
  contextState: liveAudioContextStateSchema,
  bufferedBytes: z.number().int().min(0).max(10_000_000),
  queuedMs: z.number().int().min(0).max(3_600_000),
  frameAgeMs: z.number().int().min(0).max(3_600_000),
}).strict() satisfies z.ZodType<LiveClientFailure>;
