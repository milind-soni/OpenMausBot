import { z } from "zod";

import { LOCAL_APP_NAME_MAX, type LocalAppsList } from "../../shared/local-apps.ts";
import { webOrigin } from "../../shared/app-frame/csp.ts";
import type { LocalApps } from "../local-apps/service.ts";
import { nameOf } from "../local-apps/service.ts";
import type { LocalAppRecord } from "../local-apps/store.ts";
import { personKey } from "../person-key.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface LocalAppsRouteDeps {
  apps: LocalApps;
  store: {
    bot(id: string): unknown;
    botByThread(threadId: string): { id: string } | null;
    groupByThread(threadId: string): unknown;
    taskByThread(botId: string, threadId: string): unknown;
  };
  /** The same filter the GET /api/bots listing applies to this caller. */
  visibleFor(auth: RequestAuth): { everything: boolean; thread(threadId: string): boolean };
  /** On a Cloud home, a guest changes only conversations it started. */
  threadRefusal?(auth: RequestAuth, threadId: string): string | null;
  /** False once a session has ended: a folder app's files stop answering it. */
  live?(auth: RequestAuth): boolean;
}

const LIST = "/api/local-apps";
const ONE = /^\/api\/local-apps\/(la_[A-Za-z0-9_-]{16})(\/app)?$/;
const ID = /^[\w-]{1,128}$/;

const saveBody = z.object({ botId: z.string().regex(ID), threadId: z.string().regex(ID), messageId: z.string().regex(ID) }).strict();
const patchBody = z.object({ name: z.string().max(LOCAL_APP_NAME_MAX * 4).optional(), pinnedRev: z.number().int().min(0).max(999_999).nullable().optional() }).strict();

const ownerOf = (auth: RequestAuth) => (auth.kind === "session" ? personKey(auth.session) : undefined);

/** GET /api/local-apps lists the caller's saved apps; POST saves a page `{ botId, threadId, messageId }` (the same page
 * saved again answers with its app). GET, PATCH `{ name?, pinnedRev? }` and DELETE /api/local-apps/:id; GET
 * /api/local-apps/:id/app?rev=&origin= is the app's document, built as the chat builds it.
 * Security: a viewer who does not see every conversation is shown only the apps they saved, and of those only the ones
 * whose conversation, while it exists, they can still read. Saving asks the same of the page's conversation, so another
 * bot's or another conversation's page reads as one that is not there. */
export function createLocalAppsRoutes(deps: LocalAppsRouteDeps): RouteHandler {
  const { apps, store } = deps;
  const chatHas = (threadId: string) => Boolean(store.botByThread(threadId) || store.groupByThread(threadId));
  const sees = (auth: RequestAuth, record: LocalAppRecord, visible = deps.visibleFor(auth)) => {
    if (visible.everything) return true;
    if (!record.owner || record.owner !== ownerOf(auth)) return false;
    return !chatHas(record.threadId) || visible.thread(record.threadId);
  };
  /** Renaming, keeping a version and removing: whoever saved it or an admin, and never from a conversation the caller
   * may not change. */
  const mayChange = (auth: RequestAuth, record: LocalAppRecord): string | null => {
    if (!auth.scopes.includes("admin") && record.owner !== ownerOf(auth)) return "Only whoever saved this app can change it.";
    return chatHas(record.threadId) ? deps.threadRefusal?.(auth, record.threadId) ?? null : null;
  };

  return async ({ req, res, url, path, method, auth, json, readBody }) => {
    if (path === LIST) {
      if (method === "GET") {
        const visible = deps.visibleFor(auth);
        res.setHeader("cache-control", "private, no-store");
        return json(res, 200, { apps: apps.list().filter((record) => sees(auth, record, visible)).map(apps.view) } satisfies LocalAppsList);
      }
      if (method !== "POST") return PASS;
      const body = saveBody.safeParse(await readBody(req, 4_096));
      if (!body.success) return json(res, 400, { error: "Saving an app takes botId, threadId and messageId of the page." });
      const { botId, threadId, messageId } = body.data;
      if (store.groupByThread(threadId)) return json(res, 409, { error: "A page in a room can't be saved as an app." });
      if (!store.bot(botId) || !store.taskByThread(botId, threadId) || !deps.visibleFor(auth).thread(threadId)) return json(res, 404, { error: "no such conversation" });
      const refused = deps.threadRefusal?.(auth, threadId);
      if (refused) return json(res, 403, { error: refused });
      const saved = apps.save({ botId, threadId, messageId, owner: ownerOf(auth) });
      if (!saved.ok) return json(res, saved.status, { error: saved.error });
      return json(res, saved.created ? 201 : 200, { app: apps.view(saved.app) });
    }

    const m = ONE.exec(path);
    if (!m) return PASS;
    const record = apps.get(m[1]!);
    if (!record || !sees(auth, record)) return json(res, 404, { error: "No such app." });

    if (m[2]) {
      if (method !== "GET") return PASS;
      const asked = url.searchParams.get("rev");
      if (asked !== null && !/^\d{1,6}$/.test(asked)) return json(res, 400, { error: "rev must be a version number" });
      const origin = webOrigin(url.searchParams.get("origin")) ?? webOrigin(url.origin) ?? undefined;
      const viewer = { key: auth.kind === "session" ? `session:${auth.session.id}` : auth.kind,
        allowed: () => (deps.live?.(auth) ?? true) && Boolean(apps.get(record.id)) && sees(auth, apps.get(record.id)!) };
      const doc = apps.document(record.id, asked === null ? undefined : Number(asked), origin, viewer);
      if (!doc) return json(res, 404, { error: "That version of the app is no longer kept." });
      res.setHeader("cache-control", "private, no-store");
      return json(res, 200, doc);
    }

    if (method === "GET") return json(res, 200, { app: apps.view(record) });
    if (method !== "DELETE" && method !== "PATCH") return PASS;
    const refused = mayChange(auth, record);
    if (refused) return json(res, 403, { error: refused });
    if (method === "DELETE") {
      apps.remove(record.id);
      return json(res, 200, { ok: true });
    }
    const body = patchBody.safeParse(await readBody(req, 4_096));
    if (!body.success || (body.data.name === undefined && body.data.pinnedRev === undefined)) return json(res, 400, { error: "Change an app with name or pinnedRev." });
    let changed: LocalAppRecord | null = record;
    if (body.data.name !== undefined) {
      const name = nameOf(body.data.name);
      if (!name) return json(res, 400, { error: "An app needs a name." });
      changed = apps.rename(record.id, name);
    }
    if (changed && body.data.pinnedRev !== undefined) {
      changed = apps.pin(record.id, body.data.pinnedRev);
      if (!changed) return json(res, 404, { error: "That version of the app is no longer kept." });
    }
    return changed ? json(res, 200, { app: apps.view(changed) }) : json(res, 404, { error: "No such app." });
  };
}
