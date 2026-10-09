// X research: the x_* agents tools' only way out. A thin client over the
// OpenMausBot Cloud Admin's X relay (openmaus-cloud server/cloud-services.ts),
// which calls treg (treg.to, "OpenRouter for agent tools") on our account for
// paying Cloud plans only, within each plan's monthly calls. A Cloud home has
// the relay token in its env; a desktop gets its own with its Cloud sign-in
// (included-services.ts). It hands back compact posts and profiles, never a
// scraper's raw JSON, and turns every failure into an XResearchError carrying
// a sentence a bot can pass on.
//
// Each job calls the cheapest scraper treg lists for it, with its paging and
// sort options; when that one is down, it falls back once to treg's routed
// endpoint, which works through the other scrapers in turn. Scrapers name the
// same fields differently, so rows are read through short alias lists. A
// managed relay (step 2) replaces this module only.

/** Posts one call may return. Fifty compact posts stay under the agents
 * server's result cap. */
export const MAX_POSTS = 50;
export const DEFAULT_POSTS = 20;
const REPLIES_PAGE = 20;
const MAX_PAGES = 3;
const TEXT_LIMIT = 1_500;
const QUOTE_LIMIT = 300;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
/** Characters an answer may take: under the agents server's 24,000-character
 * cap (server/tool-results.ts), so the bot never needs tool_result_read for
 * it. Long posts can push 50 of them past that, so trailing ones are dropped
 * and `more` says so. */
const RESULT_BUDGET = 22_000;

/** treg catalog ids: the cheapest scraper for each job, then treg's routed
 * endpoint for the same job (identity fields only, one page). The relay serves
 * exactly these (openmaus-cloud X_ENDPOINTS). */
export const TREG_X_ENDPOINTS = {
  search: "anyapi.x.search.posts",
  searchRouted: "treg.x.search.posts",
  userPosts: "anyapi.x.user.posts",
  userPostsRouted: "treg.x.user.posts",
  post: "anyapi.twitter.tweet",
  replies: "anyapi.x.post.comments",
  repliesRouted: "treg.x.post.comments",
  profile: "treg.x.user.profile",
} as const;

export type XResearchErrorCode = "bad_input" | "bad_key" | "no_credit" | "rate_limited" | "not_found" | "unavailable";

/** Every sentence a bot or the Settings page can be shown about X research. */
export const X_MESSAGES = {
  noKey: "X research is included with OpenMausBot Cloud plans. Sign in to a paid plan under App Settings → OpenMausBot Cloud to use it.",
  botOff: "X research is off for this bot. Turn it on in this bot's settings under Access.",
  badKey: "Sign in to OpenMausBot Cloud again in Settings to use X research.",
  noPlan: "X research comes with OpenMausBot Cloud plans, and this account's plan isn't active.",
  rateLimited: "X research is busy right now. Try again in a moment.",
  badRequest: "That X research request was refused. Check the query, handle or post link.",
  unavailable: "X research is temporarily unavailable. Try again shortly.",
  postNotFound: "That X post was not found. It may be deleted or private.",
  accountNotFound: (handle: string) => `No X account named @${handle}.`,
} as const;

export class XResearchError extends Error {
  readonly code: XResearchErrorCode;
  constructor(code: XResearchErrorCode, message: string) {
    super(message);
    this.name = "XResearchError";
    this.code = code;
  }
}

export interface XQuoted { url: string; author: string; text: string }
export interface XPost {
  id: string;
  url: string;
  author: string;
  authorName?: string;
  createdAt?: string;
  text: string;
  likes?: number;
  reposts?: number;
  replies?: number;
  quotes?: number;
  views?: number;
  isReply?: boolean;
  quoted?: XQuoted;
}
/** `newestId` and `more` come first so they survive any cut. */
export interface XPostList { newestId?: string; more: boolean; posts: XPost[] }
export interface XPostWithReplies { post: XPost; replies?: XPost[]; moreReplies?: boolean }
export interface XProfile {
  handle: string;
  name?: string;
  bio?: string;
  location?: string;
  website?: string;
  followers?: number;
  following?: number;
  posts?: number;
  verified?: boolean;
  createdAt?: string;
  url: string;
}
export interface XPostRef { id: string; handle?: string }

export interface XResearchClient {
  search(input: { query: string; sort: "latest" | "top"; limit: number; sinceId?: string }): Promise<XPostList>;
  userPosts(input: { handle: string; limit: number; sinceId?: string; includeReplies: boolean }): Promise<XPostList>;
  post(input: { id: string; handle?: string; replies: boolean }): Promise<XPostWithReplies>;
  profile(handle: string): Promise<XProfile>;
}

type Row = Record<string, unknown>;

const POST_ID = /^\d{1,25}$/;
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const X_HOSTS = new Set(["x.com", "www.x.com", "mobile.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"]);
/** First path parts that are X's own pages, never an account. */
const RESERVED = new Set(["i", "home", "search", "explore", "settings", "notifications", "messages", "hashtag", "intent", "share", "compose", "login", "signup", "tos", "privacy"]);

/** An X link, with or without https:// typed in front; null for anything
 * else (a bare handle, or a link to another site). */
function xUrl(value: string): URL | null {
  const withScheme = /^(?:www\.|mobile\.)?(?:x|twitter)\.com\//i.test(value) ? `https://${value}` : value;
  try {
    return new URL(withScheme);
  } catch {
    return null;
  }
}

function isRow(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function at(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRow(current)) return undefined;
    current = current[key];
  }
  return current;
}

function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function firstCount(...values: unknown[]): number | undefined {
  for (const value of values) {
    const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
    if (typeof n === "number" && Number.isFinite(n)) return n;
  }
  return undefined;
}

/** A digit string, or a number JSON has not already rounded. */
function idOf(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && POST_ID.test(value)) return value;
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  }
  return undefined;
}

/** "@maus", "maus" or an x.com profile link (https:// optional) → "maus";
 * anything else, X's own pages included, → null. */
export function normalizeHandle(raw: string): string | null {
  let value = raw.trim();
  const url = xUrl(value);
  if (url) {
    if (!X_HOSTS.has(url.hostname)) return null;
    value = url.pathname.split("/").filter(Boolean)[0] ?? "";
  }
  value = value.replace(/^@/, "");
  return HANDLE.test(value) && !RESERVED.has(value.toLowerCase()) ? value : null;
}

/** A post id, and the author's handle when the link names one, from a bare id
 * or an x.com / twitter.com status link. */
export function parsePostRef(raw: string): XPostRef | null {
  const value = raw.trim();
  if (POST_ID.test(value)) return { id: value };
  const url = xUrl(value);
  if (!url || !X_HOSTS.has(url.hostname)) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  const status = parts.indexOf("status");
  const id = status >= 0 ? parts[status + 1] : undefined;
  if (!id || !POST_ID.test(id)) return null;
  const handle = status === 1 && HANDLE.test(parts[0]!) && !RESERVED.has(parts[0]!.toLowerCase()) ? parts[0] : undefined;
  return handle ? { id, handle } : { id };
}

/** Cut at a code point, so an emoji is never split in half. */
function clip(value: string, limit: number): string {
  const points = Array.from(value);
  return points.length <= limit ? value : `${points.slice(0, limit).join("")}…`;
}

/** Unix seconds (or milliseconds), or a date string, as ISO time. */
function timeOf(value: unknown): string | undefined {
  const n = firstCount(value);
  const when = n !== undefined ? new Date(n < 1e12 ? n * 1000 : n) : typeof value === "string" ? new Date(value) : undefined;
  return when && !Number.isNaN(when.getTime()) ? when.toISOString() : undefined;
}

/** The author's own post page whenever the author is known: scrapers often
 * give x.com/i/web/status/<id>, and a link without the handle sends a bot to
 * its browser to find out whose post it is, which defeats paying for treg. */
function postUrl(id: string, handle: string | undefined, given: string | undefined): string {
  return handle ? `https://x.com/${handle}/status/${id}` : given ?? `https://x.com/i/status/${id}`;
}

/** One post from any scraper's row, or null when it has no usable id.
 * Undefined fields are dropped by JSON.stringify, so a field a scraper left
 * out never reaches the bot as a made-up zero. */
export function toPost(raw: unknown, knownHandle?: string): XPost | null {
  if (!isRow(raw)) return null;
  // X's own GraphQL rows keep most fields under `legacy`; a field on the row
  // itself wins.
  const row: Row = { ...(isRow(raw.legacy) ? raw.legacy : {}), ...raw };
  const id = idOf(row.id_str, row.rest_id, row.id, row.tweet_id);
  if (!id) return null;
  const user = at(row, "core", "user_results", "result");
  const handle = firstText(
    row.authorUsername, row.authorHandle, row.username, row.screen_name,
    at(row, "author", "userName"), at(row, "author", "username"), at(row, "author", "screen_name"), at(row, "author", "handle"),
    at(row, "user", "screen_name"), at(row, "user", "username"),
    at(user, "legacy", "screen_name"), at(user, "core", "screen_name"),
    knownHandle,
  )?.replace(/^@/, "");
  const quotedRaw = [row.quoted, row.quotedTweet, row.quoted_tweet, row.quoted_status, at(row, "quoted_status_result", "result")].find(isRow);
  const quoted = quotedRaw ? toPost(quotedRaw) : null;
  return {
    id,
    url: postUrl(id, handle, firstText(row.url)),
    author: handle ? `@${handle}` : "@unknown",
    authorName: firstText(row.authorName, at(row, "author", "name"), at(row, "user", "name"), at(user, "legacy", "name"), at(user, "core", "name")),
    createdAt: timeOf(row.createdUtc ?? row.created_at ?? row.createdAt),
    text: clip(firstText(at(row, "note_tweet", "note_tweet_results", "result", "text"), row.full_text, row.text) ?? "", TEXT_LIMIT),
    likes: firstCount(row.likeCount, row.likes, row.favorite_count, row.like_count),
    reposts: firstCount(row.retweetCount, row.repostCount, row.retweets, row.retweet_count),
    replies: firstCount(row.replyCount, row.replies, row.reply_count),
    quotes: firstCount(row.quoteCount, row.quotes, row.quote_count),
    views: firstCount(row.viewCount, row.views, at(row, "views", "count"), row.view_count),
    isReply: typeof row.isReply === "boolean" ? row.isReply : undefined,
    quoted: quoted ? { url: quoted.url, author: quoted.author, text: clip(quoted.text, QUOTE_LIMIT) } : undefined,
  };
}

/** The rows of a catalog answer ({output: {data: {items | tweets}}}) or a
 * routed one ({output: {posts | comments}}). */
function rowsOf(answer: Row): unknown[] {
  const output = at(answer, "output");
  for (const list of [at(output, "data", "items"), at(output, "data", "tweets"), at(output, "posts"), at(output, "comments"), at(output, "data", "replies")]) {
    if (Array.isArray(list)) return list;
  }
  return [];
}

function cursorOf(answer: Row): string | undefined {
  const output = at(answer, "output");
  return firstText(at(output, "data", "nextCursor"), at(output, "next_cursor"), at(output, "nextCursor"));
}

/** How many leading posts fit in `budget` characters of JSON. */
function fitting(posts: XPost[], budget: number): number {
  let used = 0;
  for (let i = 0; i < posts.length; i++) {
    used += JSON.stringify(posts[i]).length + 1;
    if (used > budget) return i;
  }
  return posts.length;
}

function newestOf(posts: XPost[]): string | undefined {
  let newest: bigint | undefined;
  for (const post of posts) {
    const id = BigInt(post.id);
    if (newest === undefined || id > newest) newest = id;
  }
  return newest?.toString();
}

/** An HTTP refusal from treg as one of the sentences in X_MESSAGES. */
export function errorFor(status: number, body: unknown): XResearchError {
  // The relay's own refusals (openmaus-cloud server/cloud-services.ts); a 5xx
  // there is a scraper or our treg account, never the person's to fix.
  if (status === 401 || status === 403) return new XResearchError("bad_key", X_MESSAGES.badKey);
  if (status === 402) return new XResearchError("no_credit", X_MESSAGES.noPlan);
  if (status === 422) return new XResearchError("bad_input", X_MESSAGES.badRequest);
  if (status === 429) {
    // The month's allowance: the relay's sentence names the plan, the number and the reset date.
    const said = at(body, "message");
    return new XResearchError("rate_limited", at(body, "error") === "quota_exceeded" && typeof said === "string" && said.length <= 300 ? said : X_MESSAGES.rateLimited);
  }
  return new XResearchError("unavailable", X_MESSAGES.unavailable);
}

const unavailable = () => new XResearchError("unavailable", X_MESSAGES.unavailable);

/** Read the body in chunks and give up the moment it crosses the cap. */
async function readCapped(response: Response): Promise<string> {
  const announced = Number(response.headers.get("content-length") ?? 0);
  if (announced > MAX_BODY_BYTES) throw unavailable();
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      throw unavailable();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The cheapest scraper first; only an outage (not a bad token, an empty
 * balance or a malformed request) earns the routed fallback. */
async function withFallback<T>(primary: () => Promise<T>, fallback: () => Promise<T>): Promise<T> {
  try {
    return await primary();
  } catch (error) {
    if (error instanceof XResearchError && error.code === "unavailable") return fallback();
    throw error;
  }
}

interface ListOptions {
  limit: number;
  sinceId?: string;
  /** Newest-first lists stop paging once a page shows a post already seen. */
  newestFirst: boolean;
  keepReplies: boolean;
  /** Send limit and cursor (catalog endpoints; routed ones take neither). */
  paged: boolean;
  /** Pages to follow at most; each page is a billed call. */
  pages: number;
  /** Rows that do not name their author (an account's own timeline). */
  knownHandle?: string;
}

/** `url` is the relay base (OMB_CLOUD_X_URL, or a desktop's from its Cloud
 * sign-in) and `token` its relay token: the only things that leave here. */
export function createXRelayClient(options: { url: string; token: string; fetcher?: typeof fetch; timeoutMs?: number }): XResearchClient {
  const fetcher = options.fetcher ?? fetch;
  const base = options.url.replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;

  async function send(path: string, body: Row): Promise<Row> {
    let status: number;
    let ok: boolean;
    let raw: string;
    try {
      const response = await fetcher(`${base}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${options.token}`, accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = response.status;
      ok = response.ok;
      raw = await readCapped(response);
    } catch (error) {
      if (error instanceof XResearchError) throw error;
      throw unavailable();
    }
    let parsed: unknown = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = null;
    }
    if (!ok) throw errorFor(status, parsed);
    if (!isRow(parsed)) throw unavailable();
    return parsed;
  }

  const call = (endpoint: string, body: Row) => send(`/call/${endpoint}`, body);

  async function list(endpoint: string, body: Row, opts: ListOptions): Promise<XPostList> {
    const since = opts.sinceId === undefined ? undefined : BigInt(opts.sinceId);
    const posts: XPost[] = [];
    let cursor: string | undefined;
    let more = false;
    for (let page = 0; page < opts.pages; page++) {
      const answer = await call(endpoint, opts.paged ? { ...body, limit: opts.limit, ...(cursor ? { cursor } : {}) } : body);
      const rows = rowsOf(answer);
      // The page is paid for, so every row is read: an old post can sit among
      // new ones (a pinned post, or a retweet a scraper lists under the
      // original's id). An old post past the first row ends the paging.
      let reachedSeen = false;
      rows.forEach((raw, index) => {
        const post = toPost(raw, opts.knownHandle);
        if (!post || (!opts.keepReplies && post.isReply === true)) return;
        if (since !== undefined && BigInt(post.id) <= since) {
          if (opts.newestFirst && index > 0 && at(raw, "isPinned") !== true) reachedSeen = true;
          return;
        }
        posts.push(post);
      });
      cursor = cursorOf(answer);
      more = Boolean(cursor) && rows.length > 0 && !reachedSeen;
      if (!more || posts.length >= opts.limit) break;
    }
    if (posts.length > opts.limit) {
      posts.length = opts.limit;
      more = true;
    }
    const fit = fitting(posts, RESULT_BUDGET);
    if (fit < posts.length) {
      posts.length = fit;
      more = true;
    }
    return { newestId: newestOf(posts), more, posts };
  }

  return {
    search({ query, sort, limit, sinceId }) {
      const q = sinceId === undefined ? query : `${query} since_id:${sinceId}`;
      return withFallback(
        () => list(TREG_X_ENDPOINTS.search, { query: q, queryType: sort === "top" ? "Top" : "Latest" }, { limit, sinceId, newestFirst: sort === "latest", keepReplies: true, paged: true, pages: MAX_PAGES }),
        () => list(TREG_X_ENDPOINTS.searchRouted, { q }, { limit, sinceId, newestFirst: false, keepReplies: true, paged: false, pages: 1 }),
      );
    },
    userPosts({ handle, limit, sinceId, includeReplies }) {
      const shared = { limit, sinceId, keepReplies: includeReplies, knownHandle: handle };
      return withFallback(
        () => list(TREG_X_ENDPOINTS.userPosts, { handle }, { ...shared, newestFirst: true, paged: true, pages: MAX_PAGES }),
        () => list(TREG_X_ENDPOINTS.userPostsRouted, { username: handle }, { ...shared, newestFirst: false, paged: false, pages: 1 }),
      );
    },
    async post({ id, handle, replies }) {
      const url = handle ? `https://x.com/${handle}/status/${id}` : `https://x.com/i/web/status/${id}`;
      const answer = await call(TREG_X_ENDPOINTS.post, { url });
      const post = at(answer, "output", "found") === false ? null : toPost(at(answer, "output", "data"), handle);
      if (!post) throw new XResearchError("not_found", X_MESSAGES.postNotFound);
      if (!replies) return { post };
      const page = await withFallback(
        () => list(TREG_X_ENDPOINTS.replies, { url }, { limit: REPLIES_PAGE, newestFirst: false, keepReplies: true, paged: true, pages: 1 }),
        () => list(TREG_X_ENDPOINTS.repliesRouted, { tweet_id: id }, { limit: REPLIES_PAGE, newestFirst: false, keepReplies: true, paged: false, pages: 1 }),
      );
      const fit = fitting(page.posts, RESULT_BUDGET - JSON.stringify(post).length);
      return { post, replies: page.posts.slice(0, fit), moreReplies: page.more || fit < page.posts.length };
    },
    async profile(handle) {
      // Routed already: treg tries each scraper and answers one normalized
      // shape, `username` null when every one missed.
      const answer = await call(TREG_X_ENDPOINTS.profile, { username: handle });
      const out = at(answer, "output");
      const username = firstText(at(out, "username"))?.replace(/^@/, "");
      if (!username) throw new XResearchError("not_found", X_MESSAGES.accountNotFound(handle));
      const verified = at(out, "is_verified");
      return {
        handle: `@${username}`,
        name: firstText(at(out, "name")),
        bio: firstText(at(out, "description")),
        location: firstText(at(out, "location")),
        website: firstText(at(out, "website")),
        followers: firstCount(at(out, "followers")),
        following: firstCount(at(out, "following")),
        posts: firstCount(at(out, "posts_count")),
        verified: typeof verified === "boolean" ? verified : undefined,
        createdAt: timeOf(at(out, "created_at")),
        url: `https://x.com/${username}`,
      };
    },
  };
}
