// A finished job's replay (server/replay.ts): its preview for the Share replay dialog, the published link, and the
// one-file download. Admin-scope routes, so only the owner's own app; a room is refused.
import { z } from "zod";

import type { PublishedPageCard } from "../../shared/published-page.ts";
import { cardText } from "../pages/publisher.ts";
import type { PagePublisher } from "../pages/publisher.ts";
import { buildReplay, replayDownload, replayJobs, replayPageFiles, replayPictures, ReplayError, type ReplayDeps } from "../replay.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface ReplayRouteDeps extends ReplayDeps {
  publisher: Pick<PagePublisher, "publishFiles">;
  /** Puts the page's card in the conversation; its message id, or null when the conversation is gone. */
  post(threadId: string, text: string, card: PublishedPageCard): string | null;
}

const PREVIEW = /^\/api\/threads\/([\w-]+)\/replay$/;
const PUBLISH = /^\/api\/threads\/([\w-]+)\/replay\/publish$/;
const DOWNLOAD = /^\/api\/threads\/([\w-]+)\/replay\.html$/;
const ID = z.string().regex(/^[\w-]{1,128}$/);
const leaveOut = z.array(z.number().int().min(1).max(10_000)).max(500);
const publishBody = z.object({ request: ID.optional(), title: z.string().max(1000).optional(), leaveOut: leaveOut.optional() }).strict();

/** The link a replay keeps however often its job is published again. */
export const replaySource = (threadId: string, requestId: string) => `replay:${threadId}/${requestId}`;

export function createReplayRoutes(deps: ReplayRouteDeps): RouteHandler {
  return async ({ req, res, url, path, method, json, readBody }) => {
    const preview = method === "GET" ? PREVIEW.exec(path) : null;
    const publish = method === "POST" ? PUBLISH.exec(path) : null;
    const download = method === "GET" ? DOWNLOAD.exec(path) : null;
    const threadId = (preview ?? publish ?? download)?.[1];
    if (!threadId) return PASS;
    try {
      if (publish) {
        const body = publishBody.safeParse(await readBody(req, 16_384) ?? {});
        if (!body.success) return void json(res, 400, { error: "Publish takes an optional request, title and leaveOut (step numbers)." });
        const built = buildReplay(deps, threadId, body.data.request);
        const bot = deps.bot(threadId)!;
        const title = body.data.title?.trim() || built.model.title;
        const outcome = await deps.publisher.publishFiles({
          botId: bot.id, threadId, source: replaySource(threadId, built.requestId), title,
          files: replayPageFiles(built, title, body.data.leaveOut),
          post: (text, card) => deps.post(threadId, text || cardText(card), card),
        });
        return void json(res, outcome.status, outcome.status === 200 ? { ok: true, card: outcome.card } : { error: outcome.text, ...(outcome.card ? { card: outcome.card } : {}) });
      }
      const request = url.searchParams.get("request") ?? undefined;
      if (request !== undefined && !ID.safeParse(request).success) return void json(res, 400, { error: "request must be a message id" });
      const built = buildReplay(deps, threadId, request);
      if (download) {
        const out = (url.searchParams.get("leaveOut") ?? "").split(",").filter(Boolean).map(Number);
        if (!leaveOut.safeParse(out).success) return void json(res, 400, { error: "leaveOut must be step numbers" });
        const html = replayDownload(built, url.searchParams.get("title")?.slice(0, 1000) ?? "", out);
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-disposition": `attachment; filename="replay-${built.requestId}.html"`,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        return void res.end(html);
      }
      const pictured = replayPictures(built);
      res.setHeader("cache-control", "no-store");
      return void json(res, 200, {
        jobs: replayJobs(deps.messages(threadId)).slice(0, 50),
        replay: {
          requestId: built.requestId, ...built.model,
          steps: built.model.steps.map(({ image: _image, ...step }) => ({ ...step, imageUrl: built.imageUrls.get(step.n) ?? null, pictured: pictured.has(step.n) })),
          leftOutToFit: [...built.images.keys()].filter((n) => !pictured.has(n)).length,
        },
      });
    } catch (error) {
      if (error instanceof ReplayError) return void json(res, error.status, { error: error.message });
      throw error;
    }
  };
}
