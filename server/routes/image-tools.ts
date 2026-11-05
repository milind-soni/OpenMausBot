import type { ServerResponse } from "node:http";
import { z } from "zod";

import { IMAGE_MAX_PER_TURN_DEFAULT, IMAGE_PROVIDERS } from "../../shared/image-generation.ts";
import { IMAGE_PROMPT_MAX_CHARS } from "../drivers/agents-image-tools.ts";
import {
  generateImage, imageGenerationReady, imageProviderName, imageSlots,
  type GeneratedImage, type ImageCredentials,
} from "../image-generation.ts";
import { createImageDailyCap, type ImageDailyCap } from "../image-daily-cap.ts";
import type { json } from "../harness/http.ts";
import { PASS } from "./table.ts";

export const IMAGE_MESSAGES = {
  notSetUp: "Image generation isn't set up on this computer. Ask the person to choose an image provider in Settings → AI → Image generation (shown in advanced mode).",
  noTurn: "This turn has not started yet or already ended, so the image could not be attached.",
  notSaved: "The image could not be saved on this computer. Try again shortly.",
  notPerson: "Images are made only for a person's own message in a chat. This turn was started another way (a routine, a webhook, an app, a guest or a room goal's coordinator), so no image was made. Tell the person they can ask for the image in a chat.",
  dailyCap: (cap: number) => `Bots on this computer have made ${cap} images today, the most allowed in one day, so no image was made. Tell the person it starts again after midnight.`,
} as const;

const requestSchema = z.object({
  prompt: z.string().trim().min(1).max(IMAGE_PROMPT_MAX_CHARS),
  aspect: z.enum(["1:1", "16:9", "9:16"]).optional(),
  provider: z.enum(IMAGE_PROVIDERS).optional(),
});

export interface ImageTurn {
  key: string;
  parked: () => number;
  attach: (image: GeneratedImage) => boolean;
}

export interface ImageToolDeps {
  cfg: ImageCredentials;
  /** A person's own line started this turn's work, from the harness's records (server/peer-provenance.ts, and a room
   * run's request line): never a routine, a webhook, an app, a guest or a goal's coordinator, whose images never land. */
  personTurn: boolean;
  daily: ImageDailyCap;
  fetchImpl?: typeof fetch;
  turn: ImageTurn | null;
  /** Images still being made, per turn key: they count toward the limit before they are attached. */
  inFlight: Map<string, number>;
  signal?: AbortSignal;
}

type Outcome = { status: number; body: { text: string } | { error: string } };

export async function generateImageForTurn(raw: unknown, deps: ImageToolDeps): Promise<Outcome> {
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: 400, body: { error: `generate_image takes a prompt (1 to ${IMAGE_PROMPT_MAX_CHARS} characters), an optional aspect (1:1, 16:9 or 9:16) and an optional provider.` } };
  }
  const { prompt, aspect, provider } = parsed.data;
  if (!deps.personTurn) return { status: 403, body: { error: IMAGE_MESSAGES.notPerson } };
  const { turn } = deps;
  if (!turn) return { status: 409, body: { error: IMAGE_MESSAGES.noTurn } };
  const limit = deps.cfg.imageGen?.maxPerTurn ?? IMAGE_MAX_PER_TURN_DEFAULT;
  if (turn.parked() + (deps.inFlight.get(turn.key) ?? 0) >= limit) {
    return { status: 429, body: { error: `This turn already has ${limit} images, the most the person allows per reply. Send what you have.` } };
  }

  const { primary, fallback } = imageSlots(deps.cfg);
  let slot: "primary" | "fallback" | undefined;
  if (provider) {
    const base = primary.provider === provider;
    const backup = fallback?.provider === provider;
    if (!base && !backup) {
      const set = `the base is ${imageProviderName(primary.provider)}${fallback ? ` and the backup is ${imageProviderName(fallback.provider)}` : " and there is no backup"}`;
      return { status: 400, body: { error: `${imageProviderName(provider)} is not one of the person's image providers: ${set}. Use one of those, or ask the person to change it in Settings.` } };
    }
    if (!(base && backup)) slot = base ? "primary" : "fallback";
  } else if (!imageGenerationReady(deps.cfg)) {
    return { status: 409, body: { error: IMAGE_MESSAGES.notSetUp } };
  }

  if (!deps.daily.reserve()) return { status: 429, body: { error: IMAGE_MESSAGES.dailyCap(deps.daily.cap) } };
  let made = false;
  deps.inFlight.set(turn.key, (deps.inFlight.get(turn.key) ?? 0) + 1);
  try {
    const image = await generateImage(deps.cfg, { prompt, aspect }, { slot, fetchImpl: deps.fetchImpl, signal: deps.signal });
    made = true;
    if (!turn.attach({ bytes: image.bytes, mime: image.mime })) return { status: 409, body: { error: IMAGE_MESSAGES.noTurn } };
    const backup = image.usedFallback ? `, the person's backup image provider${image.baseError ? `, because the base failed: ${image.baseError}` : ""}` : "";
    const by = `${imageProviderName(image.provider)} (${image.model})${backup}`;
    return { status: 201, body: { text: `Image made by ${by}. It will be attached to this turn's reply when the turn ends.` } };
  } catch (error) {
    const status = (error as { status?: unknown } | null)?.status;
    if (typeof status !== "number" || !(error instanceof Error)) return { status: 500, body: { error: IMAGE_MESSAGES.notSaved } };
    return { status, body: { error: error.message } };
  } finally {
    deps.daily.settle(made);
    const left = (deps.inFlight.get(turn.key) ?? 1) - 1;
    if (left > 0) deps.inFlight.set(turn.key, left); else deps.inFlight.delete(turn.key);
  }
}

export interface ImageRouteContext {
  method: string;
  path: string;
  res: ServerResponse;
  json: typeof json;
  readBody: () => Promise<unknown>;
  threadId: string;
  requireActive: () => void;
  personTurn: boolean;
}

export interface ImageTurnStore {
  liveTurn: (threadId: string) => string | undefined;
  key: (threadId: string, turnId: string) => string;
  images: (key: string) => number;
  park: (key: string, image: GeneratedImage) => void;
}

export function imageTurn(store: ImageTurnStore, threadId: string, requireActive: () => void): ImageTurn | null {
  requireActive();
  const turnId = store.liveTurn(threadId);
  if (!turnId) return null;
  const key = store.key(threadId, turnId);
  return {
    key,
    parked: () => store.images(key),
    attach: (image) => {
      requireActive();
      if (store.liveTurn(threadId) !== turnId) return false;
      store.park(key, image);
      return true;
    },
  };
}

export function createImageToolRoutes(deps: ImageTurnStore & { config: () => ImageCredentials; dataDir: string; fetchImpl?: typeof fetch }) {
  const inFlight = new Map<string, number>();
  const daily = createImageDailyCap(deps.dataDir);
  return {
    async internal(ctx: ImageRouteContext): Promise<typeof PASS | void> {
      if (ctx.method !== "POST" || ctx.path !== "/api/internal/images/generate") return PASS;
      const turn = imageTurn(deps, ctx.threadId, ctx.requireActive);
      const call = new AbortController();
      ctx.res.once("close", () => { if (!ctx.res.writableEnded) call.abort(); });
      const outcome = await generateImageForTurn(await ctx.readBody(), { cfg: deps.config(), personTurn: ctx.personTurn, daily, fetchImpl: deps.fetchImpl, turn, inFlight, signal: call.signal });
      ctx.json(ctx.res, outcome.status, outcome.body);
    },
  };
}
