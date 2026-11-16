import type { AppPreview } from "./app-preview";
import { publishedLink } from "./page-open";
import { showable } from "./published-apps";

/** A message shows at most this many sites, so a list of links stays a list. */
export const SITE_CARDS_MAX = 3;

const CODE = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g;
const HTTPS_URL = /https:\/\/[^\s<>()[\]{}"'`|\\^]+/g;
const TRAILING = /[.,;:!?*_~]+$/;

/** The sites a bot put online that a message links to, once each, in order: an https address of a Netlify site, a
 * published page, or an app in the loaded Published apps list; never one in code, and never the app's own origin. */
export function publishedSiteLinks(text: string, appOrigin: string): AppPreview[] {
  const found: AppPreview[] = [];
  const seen = new Set<string>();
  for (const [raw] of text.replace(CODE, " ").matchAll(HTTPS_URL)) {
    const href = raw.replace(TRAILING, "");
    let url: URL;
    try { url = new URL(href); } catch { continue; }
    const key = `${url.origin}${url.pathname}`;
    if (seen.has(key) || !showable(href, appOrigin)) continue;
    const preview = publishedLink(href);
    if (!preview) continue;
    seen.add(key);
    found.push(preview);
    if (found.length === SITE_CARDS_MAX) break;
  }
  return found;
}
