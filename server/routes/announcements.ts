import { announcementStore } from "../announcements/feed.ts";
import { releaseNotesStore } from "../announcements/release-notes.ts";
import { PASS, type RouteHandler } from "./table.ts";

export const ANNOUNCEMENTS_PATH = "/api/announcements";

/** GET /api/announcements: the project's announcement cards whose time has not passed, and when their file last changed
 * (`updatedAt`, the date Announcements gives a card without `starts`), with the notes of the latest releases
 * (`releases`, newest first), for every signed-in page alike (request-auth.ts lets a Team Cloud's members read it). Each
 * page decides for itself which card, if any, it shows. Asking refreshes this server's copies when they are an hour old;
 * it never fails for want of the network. */
export const announcementRoutes: RouteHandler = async ({ res, path, method, json }) => {
  if (path !== ANNOUNCEMENTS_PATH) return PASS;
  if (method !== "GET") return json(res, 405, { error: "Use GET." });
  const store = announcementStore();
  const notes = releaseNotesStore();
  const [cards] = await Promise.all([store.cardsForPage(), notes.ready()]);
  return json(res, 200, store.disabled ? { cards, disabled: true } : { cards, updatedAt: store.current().updatedAt, releases: notes.releases() });
};
