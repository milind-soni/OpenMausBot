// The internal calls behind publish_page and unpublish_page, the person's Unpublish on a page's chat card, and the
// preview's Publish of a page a bot showed in the chat.
//
// The internal handler runs inside index.ts's /api/internal/ block, after the capability bearer is checked: the bot and
// its conversation come from the capability, never the body, and only the bot's own folders are read.
import type { ServerResponse } from "node:http";
import { z } from "zod";
import type { PublishedPageCard } from "../../shared/published-page.ts";
import type { PublishablePage } from "../chat-apps.ts";
import { guestWorkspaceToHost } from "../bot-attachment.ts";
import { VM_WORKSPACE_GUEST } from "../container-computer.ts";
import type { json as sendJson } from "../harness/http.ts";
import type { PageBundle } from "../pages/bundle.ts";
import type { PagePublisher } from "../pages/publisher.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface PagesInternalContext {
  method: string;
  path: string;
  res: ServerResponse;
  json: typeof sendJson;
  botId: string;
  threadId: string;
  /** index.ts's readInternalBody: re-checks the capability after the read. */
  readBody: () => Promise<unknown>;
  /** Throws once the turn that owns the capability has ended (Stop, or the turn settled). */
  requireActive: () => void;
  /** Aborts once the tool call's request is gone. */
  signal: AbortSignal;
  /** The bot's own folders for this turn, and its Local VM's workspace on this computer when it has one. */
  folders: () => Promise<{ roots: readonly string[]; vmWorkspace: string | null }>;
  /** Puts a card in the conversation the tool was called from; null when that conversation is gone. A live card comes
   * with the files published, so it can show the page itself. */
  post: (text: string, card: PublishedPageCard, bundle?: PageBundle) => string | null;
}

const PUBLISH = "/api/internal/pages/publish", UNPUBLISH = "/api/internal/pages/unpublish";
const UNPUBLISH_ROUTE = /^\/api\/published-pages\/([a-z0-9]{20,63})\/unpublish$/;
const APP_PUBLISH_ROUTE = /^\/api\/threads\/([\w-]+)\/messages\/([\w-]+)\/app\/publish$/;
const appPublishBody = z.object({ rev: z.number().int().min(0).max(1_000_000).optional() }).strict();
const pageId = z.string().max(63).optional();
const publishBody = z.object({ path: z.string().max(4096), title: z.string().max(1000), page_id: pageId });
const unpublishBody = z.object({ page_id: pageId, path: z.string().max(4096).optional() });

/** A path inside the bot's Local VM workspace means the same file on this computer. */
const hostPath = (path: string, vmWorkspace: string | null) => vmWorkspace ? guestWorkspaceToHost(path, VM_WORKSPACE_GUEST, vmWorkspace) ?? path : path;

export function createPagesInternalRoutes(publisher: PagePublisher) {
  return async (ctx: PagesInternalContext): Promise<typeof PASS | void> => {
    if (ctx.method !== "POST" || (ctx.path !== PUBLISH && ctx.path !== UNPUBLISH)) return PASS;
    const raw = await ctx.readBody();
    const { roots, vmWorkspace } = await ctx.folders();
    const folders = vmWorkspace ? [vmWorkspace, ...roots] : roots;
    ctx.requireActive();
    const call = { assertActive: ctx.requireActive, signal: ctx.signal };
    let outcome;
    if (ctx.path === PUBLISH) {
      const body = publishBody.safeParse(raw ?? {});
      if (!body.success) return void ctx.json(ctx.res, 400, { error: "publish_page takes path, title and optionally page_id, as text." });
      outcome = await publisher.publish({ botId: ctx.botId, threadId: ctx.threadId, path: hostPath(body.data.path, vmWorkspace), title: body.data.title,
        ...(body.data.page_id ? { pageId: body.data.page_id } : {}), roots: folders, post: ctx.post, call });
    } else {
      const body = unpublishBody.safeParse(raw ?? {});
      if (!body.success) return void ctx.json(ctx.res, 400, { error: "unpublish_page takes page_id, or the path the page was published from." });
      outcome = await publisher.unpublish({ ...(body.data.page_id ? { pageId: body.data.page_id } : {}),
        ...(body.data.path ? { path: hostPath(body.data.path, vmWorkspace) } : {}), botId: ctx.botId, roots: folders, call });
    }
    ctx.json(ctx.res, outcome.status, outcome.status === 200 ? { ok: true, text: outcome.text } : { error: outcome.text });
  };
}

export interface AppPages {
  /** The direct conversation's bot; null for a room or a conversation that is gone. */
  botOf(threadId: string): { id: string } | null;
  page(threadId: string, messageId: string, rev?: number): PublishablePage;
  /** The link the page's card already shows, so publishing again updates it. */
  published(threadId: string, messageId: string): string | null;
  /** The card gains the link: its message id, or null when the page is gone. */
  show(threadId: string, messageId: string, card: PublishedPageCard): string | null;
}

/** A chat page keeps one link however often it is published again: a folder page shares its folder's with publish_page. */
export const appPageSource = (threadId: string, messageId: string) => `app:${threadId}/${messageId}`;

/** POST /api/published-pages/<pageId>/unpublish: the card's Unpublish. POST .../messages/<id>/app/publish: a page card's
 * Share. Both admin-scope routes, so only the owner's own app. */
export function createPublishedPageRoutes(publisher: PagePublisher, apps?: AppPages): RouteHandler {
  return async ({ req, res, path, method, json, readBody }) => {
    const match = UNPUBLISH_ROUTE.exec(path);
    if (match && method === "POST") {
      const outcome = await publisher.unpublish({ pageId: match[1] });
      return void json(res, outcome.status, outcome.status === 200 ? { ok: true, card: outcome.card } : { error: outcome.text });
    }
    const page = apps ? APP_PUBLISH_ROUTE.exec(path) : null;
    if (!apps || !page || method !== "POST") return PASS;
    const [, threadId, messageId] = page as unknown as [string, string, string];
    const bot = apps.botOf(threadId);
    if (!bot) return void json(res, 404, { error: "Pages from a room or a closed conversation can't be published here." });
    const body = appPublishBody.safeParse(await readBody(req, 4_096) ?? {});
    if (!body.success) return void json(res, 400, { error: "Publish takes an optional rev, the version to publish." });
    const built = apps.page(threadId, messageId, body.data.rev);
    if (!built.ok) return void json(res, built.status, { error: built.error });
    const pageId = apps.published(threadId, messageId);
    const outcome = await publisher.publishFiles({
      botId: bot.id, threadId, source: built.folder ?? appPageSource(threadId, messageId), title: built.title, files: built.files,
      ...(pageId ? { pageId } : {}),
      post: (_text, card) => (card.state === "live" ? apps.show(threadId, messageId, card) : null),
    });
    json(res, outcome.status, outcome.status === 200 ? { ok: true, card: outcome.card } : { error: outcome.text, ...(outcome.card ? { card: outcome.card } : {}) });
  };
}
