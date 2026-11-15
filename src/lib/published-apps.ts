import type { PublishedApp } from "../../shared/published-apps";
import { isAppOrigin } from "./web-panels";

/** Security: a published site is untrusted content. Its frame keeps the site's own origin (so it runs like a normal
 * site, with its own storage) and gets scripts, forms and new tabs, never the top window, downloads, pointer lock or
 * a way out of the sandbox. A site on the app's own origin is never framed (`showable`). */
export const SITE_FRAME_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups";
/** A card's small picture of the site: it only has to draw itself. */
export const SITE_THUMB_SANDBOX = "allow-scripts allow-same-origin";
/** What neither frame may ask the browser for. */
export const SITE_FRAME_ALLOW = "camera 'none'; microphone 'none'; geolocation 'none'; display-capture 'none'; clipboard-read 'none'; autoplay 'none'";

/** A plain web address that is not the app itself. */
export function showable(url: string, appOrigin: string): boolean {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  return !parsed.username && !parsed.password && !isAppOrigin(parsed.href, appOrigin);
}

export function appInitial(title: string): string {
  const first = [...title.trim()].find((character) => /[\p{L}\p{N}]/u.test(character));
  return first ? first.toLocaleUpperCase() : "·";
}

let known: readonly PublishedApp[] = [];

/** The list the Published apps page last loaded: a link to one of these opens beside the chat. */
export function rememberPublishedApps(apps: readonly PublishedApp[]): void {
  known = apps;
}

/** The app in the loaded list that this address is inside. */
export function knownPublishedApp(href: string): PublishedApp | undefined {
  let url: URL;
  try { url = new URL(href); } catch { return undefined; }
  return known.find((app) => {
    if (!app.url) return false;
    const base = new URL(app.url);
    return url.origin === base.origin && url.pathname.startsWith(base.pathname);
  });
}
