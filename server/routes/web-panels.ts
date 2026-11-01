import { checkFraming } from "../web-panel-framing.ts";
import { PASS, type RouteHandler } from "./table.ts";

/** GET /api/web-panels/framing?url=…&origin=…: whether the page at `url` lets the app at `origin` frame it.
 * Security: it reaches only public pages and answers with a verdict, never a page's content. */
export const webPanelRoutes: RouteHandler = async ({ res, url, path, method, json }) => {
  if (path !== "/api/web-panels/framing" || method !== "GET") return PASS;
  const page = url.searchParams.get("url");
  const origin = url.searchParams.get("origin");
  if (!page || !origin) return json(res, 400, { error: "url and origin are required." });
  return json(res, 200, { framing: await checkFraming(page, origin) });
};
