// openmausbot://app/<id>: the one parser of a saved app's link, for main (open-url, argv), the launchers it writes and
// the page. A launcher's link adds `?window=1`: it opens the app in a window of its own, not in the main window.

export const APP_LINK_PREFIX = "openmausbot://app/";
/** Security invariant: an id reaches a shell script, a desktop entry's Exec line, a shortcut argument and a file name,
 * so only this shape passes. Must match LOCAL_APP_ID in shared/local-apps.ts (app-link.node-test.mjs checks). */
export const LOCAL_APP_ID = /^la_[A-Za-z0-9_-]{16}$/;
const MAX_LINK = 256;

export const validAppId = (id) => typeof id === "string" && LOCAL_APP_ID.test(id);

/** The link the page and the app use. */
export function appLink(id) {
  if (!validAppId(id)) throw new Error("invalid app id");
  return `${APP_LINK_PREFIX}${id}`;
}

/** The link a launcher on this computer opens. */
export function launcherLink(id) {
  return `${appLink(id)}?window=1`;
}

/** `{ id, window }` for openmausbot://app/<id>, a trailing slash allowed, `?window=1` the only query; null otherwise. */
export function parseAppLink(value) {
  if (typeof value !== "string" || value.length > MAX_LINK) return null;
  const link = value.trim();
  if (link.slice(0, APP_LINK_PREFIX.length).toLowerCase() !== APP_LINK_PREFIX) return null;
  const match = /^([^/?#]+)\/?(\?window=1)?$/.exec(link.slice(APP_LINK_PREFIX.length));
  return match && validAppId(match[1]) ? { id: match[1], window: Boolean(match[2]) } : null;
}

/** The first saved app's link among a launch's arguments. */
export function appLinkFromCommandLine(argv) {
  for (const value of Array.isArray(argv) ? argv : []) {
    const parsed = parseAppLink(value);
    if (parsed) return parsed;
  }
  return null;
}
