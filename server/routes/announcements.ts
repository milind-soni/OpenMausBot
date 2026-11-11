import { announcementStore } from "../announcements/feed.ts";
import { PASS, type RouteHandler } from "./table.ts";

export const ANNOUNCEMENTS_PATH = "/api/announcements";

/** GET /api/announcements: the project's announcement cards whose time has not passed, for every signed-in page alike
 * (request-auth.ts lets a Team Cloud's members read it). Each page decides for itself which card, if any, it shows.
 * Asking refreshes this server's copy when it is an hour old; it never fails for want of the network. */
export const announcementRoutes: RouteHandler = async ({ res, path, method, json }) => {
  if (path !== ANNOUNCEMENTS_PATH) return PASS;
  if (method !== "GET") return json(res, 405, { error: "Use GET." });
  const store = announcementStore();
  return json(res, 200, { cards: await store.cardsForPage(), ...(store.disabled ? { disabled: true } : {}) });
};
