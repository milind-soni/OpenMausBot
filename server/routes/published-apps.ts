import { z } from "zod";
import { isNetlifySiteUrl, type PublishedAppsList } from "../../shared/published-apps.ts";
import { PAGE_ID } from "../../shared/published-page.ts";
import type { VisibleSet } from "../bot-visibility.ts";
import type { PublishedApps } from "../host/published-apps.ts";
import type { RequestAuth } from "../request-auth.ts";
import { checkFraming, type Framing } from "../web-panel-framing.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface PublishedAppsRouteDeps {
  apps: PublishedApps;
  /** The same filter the GET /api/bots listing applies to this caller. */
  visibleFor(auth: RequestAuth): VisibleSet;
  framing?: (url: string, origin: string) => Promise<Framing>;
}

/** Must match src/lib/page-open.ts `isPublishedPageUrl`. */
function isPageUrl(value: string): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  const host = url.hostname.toLowerCase();
  return url.protocol === "https:" && !url.username && !url.password && !url.port && host.endsWith(".mausbot.page") && PAGE_ID.test(host.slice(0, -".mausbot.page".length));
}

const deleteBody = z.object({ id: z.string().min(1).max(300) }).strict();

/** GET /api/published-apps: what this viewer's bots put online. POST /api/published-apps/delete `{ id }`: takes one of
 * them down for good. GET /api/published-apps/framing?url=…&origin=…: whether one of them lets the app at `origin`
 * frame it.
 * Security: the list and the delete answer from the viewer's own list (host/published-apps.ts), so an id of an app they
 * are not shown reads as one that does not exist. The framing check reaches only an address in that list or a public
 * hosting address (a Netlify site's, a published page's), and answers with a verdict, never a page's content. */
export function createPublishedAppsRoutes(deps: PublishedAppsRouteDeps): RouteHandler {
  const framing = deps.framing ?? checkFraming;
  return async ({ req, res, url, path, method, auth, json, readBody }) => {
    if (path === "/api/published-apps" && method === "GET") {
      const [apps, included] = await Promise.all([deps.apps.list(deps.visibleFor(auth), auth), deps.apps.allowance()]);
      return json(res, 200, { apps, ...(included ? { included } : {}) } satisfies PublishedAppsList);
    }
    if (path === "/api/published-apps/framing" && method === "GET") {
      const page = url.searchParams.get("url"), origin = url.searchParams.get("origin");
      if (!page || !origin) return json(res, 400, { error: "url and origin are required." });
      if (!isNetlifySiteUrl(page) && !isPageUrl(page) && !await deps.apps.lists(deps.visibleFor(auth), auth, page)) return json(res, 404, { error: "No such published app." });
      return json(res, 200, { framing: await framing(page, origin) });
    }
    if (path === "/api/published-apps/delete" && method === "POST") {
      const body = deleteBody.safeParse(await readBody(req, 4_096));
      if (!body.success) return json(res, 400, { error: "Delete takes id, the published app to delete." });
      const answer = await deps.apps.remove(deps.visibleFor(auth), auth, body.data.id);
      return json(res, answer.status, answer.body);
    }
    return PASS;
  };
}
