import { isNetlifySiteUrl, type PublishedApp } from "../../shared/published-apps";
import type { AppPreview } from "./app-preview";
import { isPublishedPageUrl } from "./page-open";
import { showable } from "./published-apps";

/** A message shows at most this many sites, so a list of links stays a list. */
export const SITE_CARDS_MAX = 3;

const CODE = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g;
const HTTPS_URL = /https:\/\/[^\s<>()[\]{}"'`|\\^]+/g;
const TRAILING = /[.,;:!?*_~]+$/;

export interface SiteCardLink extends AppPreview {
  /** The app in the viewer's Published apps list. */
  appId: string;
}

function appAt(href: URL, apps: readonly PublishedApp[]): PublishedApp | undefined {
  return apps.find((app) => {
    if (!app.url || app.status) return false;
    let base: URL;
    try { base = new URL(app.url); } catch { return false; }
    return href.origin === base.origin && href.pathname.startsWith(base.pathname);
  });
}

/** What a message links to among the sites bots put online, in order, never inside code and never the app's own
 * origin: `cards`, once each, are https sites in the viewer's own Published apps list; `unknown` are Netlify sites and
 * published pages the list doesn't hold (someone else's, or not listed yet), which stay plain links. */
export function publishedSiteLinks(text: string, appOrigin: string, apps: readonly PublishedApp[]): { cards: SiteCardLink[]; unknown: string[] } {
  const cards: SiteCardLink[] = [];
  const unknown: string[] = [];
  for (const [raw] of text.replace(CODE, " ").matchAll(HTTPS_URL)) {
    const href = raw.replace(TRAILING, "");
    let url: URL;
    try { url = new URL(href); } catch { continue; }
    if (!showable(href, appOrigin)) continue;
    const app = appAt(url, apps);
    if (!app) {
      if ((isNetlifySiteUrl(href) || isPublishedPageUrl(href)) && !unknown.includes(href)) unknown.push(href);
      continue;
    }
    if (cards.length === SITE_CARDS_MAX || cards.some((card) => card.appId === app.id)) continue;
    cards.push({ appId: app.id, url: href, title: app.title, ...(app.access === "netlify-team" ? { loginOnly: true } : {}) });
  }
  return { cards, unknown };
}
