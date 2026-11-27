// GET ?profile=<id> or ?bot=<id>; POST /api/browser-sites/sign-out {profile | bot, site?} signs out of one site, or every site without `site`.
// On a Team Cloud `threadId` names the conversation whose browser is meant (a member's, a group chat's); none is the team's.
import type { BrowserSitesTarget, SignedInSites } from "../browser-sites.ts";
import { PASS, type RouteHandler } from "./table.ts";

export type BrowserSitesRef = { profile: string } | { bot: string };

export interface BrowserSitesRouteDeps {
  target(ref: BrowserSitesRef, threadId: string | null): Promise<BrowserSitesTarget | { status: number; error: string }> | BrowserSitesTarget | { status: number; error: string };
  list(target: BrowserSitesTarget): Promise<SignedInSites>;
  signOut(target: BrowserSitesTarget, site: string | null): Promise<SignedInSites>;
}

const ID = /^[\w.-]{1,128}$/u;
const SITE = /^[a-z0-9.:[\]-]{1,253}$/u;
const threadOf = (value: unknown): string | null => (typeof value === "string" ? value : null);

function ref(value: { profile?: unknown; bot?: unknown }): BrowserSitesRef | null {
  if (typeof value.profile === "string" && ID.test(value.profile) && value.bot === undefined) return { profile: value.profile };
  if (typeof value.bot === "string" && ID.test(value.bot) && value.profile === undefined) return { bot: value.bot };
  return null;
}

function failure(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Could not read this browser's sign-ins.";
}

export function createBrowserSiteRoutes(deps: BrowserSitesRouteDeps): RouteHandler {
  return async ({ req, res, url, path, method, json, readBody }) => {
    if (path === "/api/browser-sites" && method === "GET") {
      const which = ref({ profile: url.searchParams.get("profile") ?? undefined, bot: url.searchParams.get("bot") ?? undefined });
      if (!which) return json(res, 400, { error: "Name one browser profile or one bot." });
      const target = await deps.target(which, threadOf(url.searchParams.get("threadId")));
      if ("error" in target) return json(res, target.status, { error: target.error });
      res.setHeader("cache-control", "no-store");
      try { return json(res, 200, await deps.list(target)); }
      catch (error) { return json(res, 503, { error: failure(error) }); }
    }
    if (path !== "/api/browser-sites/sign-out" || method !== "POST") return PASS;
    // JSON only, so a form posted from another local page cannot sign anyone out.
    const mediaType = String(req.headers["content-type"] ?? "").split(";", 1)[0]!.trim().toLowerCase();
    if (mediaType !== "application/json") return json(res, 415, { error: "content-type must be application/json" });
    const body = await readBody(req, 4096);
    const which = body && typeof body === "object" ? ref(body) : null;
    if (!which) return json(res, 400, { error: "Name one browser profile or one bot." });
    if (body.site !== undefined && (typeof body.site !== "string" || !SITE.test(body.site))) return json(res, 400, { error: "site must be a listed site" });
    const target = await deps.target(which, threadOf(body.threadId));
    if ("error" in target) return json(res, target.status, { error: target.error });
    try { return json(res, 200, await deps.signOut(target, body.site ?? null)); }
    catch (error) { return json(res, 503, { error: failure(error) }); }
  };
}
