/** One thing a bot put online, as the Published apps page shows it (GET /api/published-apps). */
export interface PublishedApp {
  id: string;
  /** `page`: a page published from this server to a MausBot link. `netlify`: a site on the person's own Netlify account. */
  source: "page" | "netlify";
  title: string;
  url: string;
  /** The bot whose folder or conversation it came from; `name` is empty once that bot is gone. */
  bot: { id: string; name: string };
  /** A conversation the viewer can read where the bot published it, when one is known. */
  threadId?: string;
  publishedAt: number;
  /** `link`: anyone who has the link. `public`: the site answered without a login. `netlify-team`: it asked for a
   * Netlify login when last checked. */
  access: "link" | "public" | "netlify-team" | "unknown";
  /** The site's page in the person's Netlify account. */
  manageUrl?: string;
  canDelete: boolean;
}

export interface PublishedAppsList {
  apps: PublishedApp[];
}

/** Why POST /api/published-apps/delete did not delete. `no_token` and `token_refused` come with `manageUrl`. */
export type PublishedAppDeleteRefusal = "gone" | "forbidden" | "no_token" | "token_refused" | "failed";

export interface PublishedAppDeleteFailure {
  error: string;
  code: PublishedAppDeleteRefusal;
  manageUrl?: string;
}

/** A site's own address on Netlify: https://<name>.netlify.app, with nothing but a path after it. */
export function isNetlifySiteUrl(value: string | null | undefined): value is string {
  if (typeof value !== "string") return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  return url.protocol === "https:" && !url.username && !url.password && !url.port && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.netlify\.app$/.test(url.hostname.toLowerCase());
}
